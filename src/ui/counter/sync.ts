/**
 * The drain: this tablet's outbox, pushed until the server has it.
 *
 * Push-only. Counters never see totals, so a counter's device never needs
 * anybody else's events — there is no merge here, no conflict resolution and no
 * CRDT, and if this file ever starts to need one, something upstream has gone
 * wrong and the fix is there rather than here.
 *
 * **Nothing is ever dropped on an ambiguous outcome.** A network timeout, a
 * 5xx, an aborted request: everything stays, and the next attempt sends it
 * again. Events leave the outbox only on a definite ack naming the sequence
 * range accepted. Over-delivery is free — events are immutable and keyed by a
 * device-generated uuid, so a replay is a no-op on both sides — while
 * under-delivery is a lost morning of counting. Every time that trade appears
 * in this file it is resolved the same way.
 *
 * All the state lives in Dexie. This object holds a timer and a snapshot; kill
 * the tab, reboot the tablet, and the outbox is exactly where it was.
 */
import type { CounterChainRepository, DeviceEstado } from '../../domain';
import { ApiError, type Api } from '../api';

/** The device drains in batches of at most this many, contiguous in `seq`. */
export const BATCH = 200;

/** Backoff: doubling, jittered, capped. Reset on any success. */
const BASE_DELAY = 1_000;
const MAX_DELAY = 60_000;

/** How long "Terminar" waits before it stops waiting. Never longer. */
export const FINISH_TIMEOUT = 8_000;

/**
 * How long one push may hang before it counts as ambiguous.
 *
 * A captive portal answers a TCP connection and then nothing — the request
 * neither succeeds nor fails, and without this the drain sits on it for ever:
 * «Reintentar ahora» stays greyed out as "Subiendo…", the backoff never arms,
 * and a counter standing in the office with perfectly good wifi has no way to
 * make anything happen. Timing out here does not risk the events: a request
 * that lands after we stopped waiting is a replay, and a replay is a no-op.
 */
export const PUSH_TIMEOUT = 20_000;

/** Why the drain stopped and will not restart on its own. */
export interface Stopped {
  kind: 'fork' | 'sealed';
  title: string;
  detail: string;
}

export interface SyncSnapshot {
  /** Events still in the outbox on this device. */
  pendientes: number;
  /** Events the server refused because the session was sealed (§1d). */
  rechazados: number;
  /** What this *device* believes about itself. The server never stores it. */
  estado: DeviceEstado;
  /** What the server last said about this counter. Null until it has said anything. */
  serverEstado: string | null;
  draining: boolean;
  /** The last transient problem, for the banner. Cleared on success. */
  problem: string | null;
  /** Non-null once the drain has given up. Nothing restarts it but a person. */
  stopped: Stopped | null;
  /** Normalised UTC of the last accepted push. */
  lastSyncedAt: string | null;
  /** Consecutive failures. Drives the backoff, and worth showing. */
  attempts: number;
}

interface PushAck {
  acceptedThrough: number;
  headHash: string;
  counterEstado: string;
  serverAt: string;
}

export interface CounterSyncOptions {
  sessionId: string;
  counterId: string;
  token: string;
  /** Injected so tests do not wait in real time. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Full jitter, so a bodega full of tablets does not retry in lockstep. */
  random?: () => number;
  clock?: () => string;
}

export class CounterSync {
  private readonly api: Api;
  private readonly chain: CounterChainRepository;
  private readonly sessionId: string;
  private readonly counterId: string;
  private readonly token: string;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly clock: () => string;

  private snapshot: SyncSnapshot = {
    pendientes: 0,
    rechazados: 0,
    estado: 'contando',
    serverEstado: null,
    draining: false,
    problem: null,
    stopped: null,
    lastSyncedAt: null,
    attempts: 0,
  };
  private readonly listeners = new Set<() => void>();
  private timer: unknown = null;
  /** One drain at a time. A second trigger while one is running is a no-op. */
  private running: Promise<void> | null = null;

  constructor(api: Api, chain: CounterChainRepository, options: CounterSyncOptions) {
    this.api = api;
    this.chain = chain;
    this.sessionId = options.sessionId;
    this.counterId = options.counterId;
    this.token = options.token;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  private emit(next: Partial<SyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  /** The device's own claim, set when the counter taps «Terminar». Never stored on the server. */
  setDeviceEstado(estado: DeviceEstado): void {
    this.emit({ estado });
  }

  /** Recount what is waiting, without pushing. Cheap, and what a screen mounts with. */
  async refresh(): Promise<void> {
    const pendientes = (await this.chain.unsynced(this.sessionId, this.counterId, Number.MAX_SAFE_INTEGER)).length;
    const rechazados = (await this.chain.rejected(this.sessionId, this.counterId)).length;
    this.emit({ pendientes, rechazados });
  }

  /**
   * Push until the outbox is empty, something ambiguous happens, or the drain
   * stops for good.
   *
   * Re-entrant by design: `online`, the foreground, the timer and the button all
   * call it, and a second call while one is in flight joins the first rather
   * than starting a second conversation with the server.
   */
  drain(): Promise<void> {
    if (this.running) return this.running;
    if (this.snapshot.stopped) return Promise.resolve();
    this.running = this.drainOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drainOnce(): Promise<void> {
    this.clearTimer();
    this.emit({ draining: true });
    try {
      // Before anything is sent, so a banner that says «147 sin subir» is
      // telling the truth on every path out of this function — including the
      // ones that end in a stop.
      await this.refresh();
      for (;;) {
        const batch = await this.chain.unsynced(this.sessionId, this.counterId, BATCH);
        if (batch.length === 0) {
          await this.refresh();
          this.emit({ draining: false, problem: null, attempts: 0 });
          return;
        }

        let ack: PushAck;
        try {
          ack = await this.within(
            this.api.post<PushAck>(`/api/c/${this.token}/events`, { events: batch }),
            PUSH_TIMEOUT,
            'el servidor no respondió',
          );
        } catch (cause) {
          const handled = await this.onFailure(cause);
          if (handled === 'stop') return;
          if (handled === 'retry-now') continue;
          return;
        }

        // The only place anything leaves the outbox, and only ever on an ack
        // that names how far the server got.
        await this.chain.markSynced(this.sessionId, this.counterId, ack.acceptedThrough);
        await this.refresh();
        this.emit({
          serverEstado: ack.counterEstado,
          estado: ack.counterEstado === 'terminado_confirmado' ? 'terminado_confirmado' : this.snapshot.estado,
          lastSyncedAt: this.clock(),
          problem: null,
          attempts: 0,
        });
      }
    } finally {
      this.emit({ draining: false });
    }
  }

  /** What to do about a refusal. Returns whether the loop continues. */
  private async onFailure(cause: unknown): Promise<'stop' | 'retry-now' | 'backoff'> {
    const detail = cause instanceof ApiError ? (cause.detalle as { code?: string; expectedFrom?: number } | null) : null;
    const message = cause instanceof Error ? cause.message : String(cause);

    switch (detail?.code) {
      case 'SESSION_SEALED': {
        // Kept, never deleted. The counter's work exists; it did not make it
        // into the file, and that is the admin's problem to solve rather than
        // the counter's to have quietly erased.
        await this.chain.markRejected(this.sessionId, this.counterId);
        await this.refresh();
        this.stop({
          kind: 'sealed',
          title: 'La sesión ya se cerró',
          detail:
            'Lo que contaste está guardado en esta tableta, pero no alcanzó a entrar ' +
            'en el archivo. No es un error tuyo. Avisa al administrador y no borres ' +
            'nada: desde aquí se puede exportar para adjuntarlo al acta.',
        });
        return 'stop';
      }
      case 'SEQUENCE_GAP': {
        // Not an error state. A tablet force-closed mid-drain lands here
        // routinely: the server is behind where this device thinks it is, so
        // this device resends from where the server actually is.
        const from = typeof detail.expectedFrom === 'number' ? detail.expectedFrom : 1;
        await this.chain.resetFrom(this.sessionId, this.counterId, from);
        await this.refresh();
        this.emit({ problem: null });
        return 'retry-now';
      }
      case 'DEVICE_COLLISION':
        this.stop({
          kind: 'fork',
          title: 'Otra tableta está usando este mismo enlace',
          detail:
            'No sigas contando — avisa al administrador. Lo que ya registraste sigue ' +
            'guardado aquí y no se pierde.',
        });
        return 'stop';
      case 'CHAIN_FORK':
      case 'CHAIN_INVALID':
        // Loud, and it stops. Either two live devices are pushing one token or
        // this database was restored from a backup. Nothing about it resolves
        // itself, and a retry loop hammering a fork is worse than a stop.
        this.stop({
          kind: 'fork',
          title: 'Esta tableta y el servidor no coinciden',
          detail:
            `${message} No sigas contando y avisa al administrador: lo que registraste ` +
            'sigue guardado aquí.',
        });
        return 'stop';
      default:
        break;
    }

    // Everything else is ambiguous — no connection, a 500, a request that was
    // cut off — and ambiguous means keep everything and try again.
    const attempts = this.snapshot.attempts + 1;
    this.emit({ attempts, problem: message });
    this.armRetry(attempts);
    return 'backoff';
  }

  /**
   * A promise, or a rejection once `ms` have passed.
   *
   * The underlying request is not cancelled — there is nothing to cancel it
   * with through the `Api` port, and cancelling would not help anyway: whether
   * the server received it is exactly what we do not know. It is treated as
   * ambiguous, which means everything stays in the outbox.
   */
  private within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.schedule(() => reject(new Error(message)), ms);
      work.then(
        (value) => {
          this.cancel(handle);
          resolve(value);
        },
        (cause: unknown) => {
          this.cancel(handle);
          reject(cause as Error);
        },
      );
    });
  }

  private stop(stopped: Stopped): void {
    this.clearTimer();
    this.emit({ stopped, problem: null, draining: false });
  }

  /**
   * Exponential backoff with **full** jitter, capped at a minute.
   *
   * Full jitter rather than a fixed delay because a bodega has five tablets that
   * all lost signal in the same corridor and would otherwise all come back at
   * the same instant, on the same access point.
   */
  private armRetry(attempts: number): void {
    const ceiling = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.min(attempts - 1, 10));
    const delay = Math.max(BASE_DELAY, Math.floor(this.random() * ceiling));
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  /** «Reintentar ahora»: clears the transient problem and tries immediately. */
  retryNow(): Promise<void> {
    this.emit({ attempts: 0, problem: null });
    return this.drain();
  }

  /**
   * Drain, but stop waiting after `timeout`.
   *
   * What «Terminar» calls. There is no connectivity in the bodega and a blocking
   * spinner is a force-close, which is the one thing that loses data — so the
   * button always returns, and the banner takes over from there. The request may
   * well land after this resolves; that is fine, because a replay is a no-op.
   */
  async drainWithin(timeout = FINISH_TIMEOUT): Promise<boolean> {
    let timedOut = false;
    const raced = new Promise<void>((resolve) => {
      const handle = this.schedule(() => {
        timedOut = true;
        resolve();
      }, timeout);
      void this.drain().then(() => {
        this.cancel(handle);
        resolve();
      });
    });
    await raced;
    return !timedOut && this.snapshot.pendientes === 0;
  }

  /** Everything the server refused because the session was sealed, as a file. */
  async rejectedExport(): Promise<string> {
    const rejected = await this.chain.rejected(this.sessionId, this.counterId);
    return JSON.stringify(
      {
        sessionId: this.sessionId,
        counterId: this.counterId,
        motivo: 'rechazado_sesion_sellada',
        exportadoEn: this.clock(),
        eventos: rejected,
      },
      null,
      2,
    );
  }

  /**
   * Wire the drain to everything that means "there might be signal now".
   *
   * `online` and the foreground because those are the two moments a tablet in a
   * corridor gets a network back, and a periodic timer because neither event
   * fires on a device that never fully lost it — a captive portal, a marginal
   * access point. Background Sync via the service worker may be added on top
   * opportunistically; nothing here depends on it, because Android PWA support
   * for it is inconsistent and the foreground drain has to be sufficient alone.
   */
  listen(target: {
    addEventListener: (type: string, fn: () => void) => void;
    removeEventListener: (type: string, fn: () => void) => void;
  }, everyMs = 30_000): () => void {
    const wake = () => void this.drain();
    target.addEventListener('online', wake);
    target.addEventListener('visibilitychange', wake);
    target.addEventListener('focus', wake);
    const tick = setInterval(wake, everyMs);
    void this.drain();
    return () => {
      target.removeEventListener('online', wake);
      target.removeEventListener('visibilitychange', wake);
      target.removeEventListener('focus', wake);
      clearInterval(tick);
      this.clearTimer();
    };
  }
}
