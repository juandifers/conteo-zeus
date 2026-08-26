/**
 * The counting screen's store.
 *
 * Small on purpose: an event array, a resolution map, and a subscriber set.
 * It reimplements none of the fold — `resolve` and `undoLast` are imported and
 * called, so the screen and the export can never disagree about what an item's
 * events add up to (DOMAIN.md §3).
 *
 * **Writes are optimistic, and durable anyway.** Local state moves first, the
 * event is stamped into the outbox synchronously, and the database catches up
 * behind both. A counter tapping `add` forty times off a shelf must never wait
 * on IndexedDB — but "must not wait" is not "may be lost", which is what the
 * outbox is for (see outbox.ts).
 *
 * When writes keep failing the store **stops accepting counts**. Letting
 * somebody count a whole cava into a banner is worse than telling them to stop.
 */
import {
  changesResolution,
  nowInstant,
  resolve,
  resolveAll,
  undoLast,
  type CountEvent,
  type CountEventDraft,
  type CountRepository,
  type ItemState,
  type Resolution,
  type Session,
} from '../domain';
import type { Outbox } from './outbox';

const UNTOUCHED: Resolution = { state: 'untouched' };

/**
 * Consecutive failed flushes before the store refuses more counts.
 *
 * Three rather than one, because a single rejection is usually a transient
 * IndexedDB hiccup and the outbox already covers it. Three in a row is the
 * database, and continuing means building a count nobody can post.
 */
const HALT_AFTER = 3;

/** How many items sit in each state. Items with no events simply miss the map. */
function tally(
  session: Session,
  resolutions: ReadonlyMap<number, Resolution>,
): Record<ItemState, number> {
  const counts: Record<ItemState, number> = { counted: 0, unchanged: 0, untouched: 0 };
  for (const item of session.items) {
    counts[(resolutions.get(item.idarticulo) ?? UNTOUCHED).state]++;
  }
  return counts;
}

export interface WriteFailure {
  event: CountEvent;
  message: string;
}

/** Why counting stopped, in the words the screen prints. */
export interface Halt {
  title: string;
  detail: string;
}

export interface CountSnapshot {
  session: Session;
  events: readonly CountEvent[];
  resolutions: ReadonlyMap<number, Resolution>;
  /** Where the counter says they are. Stamped on every event they append. */
  zona: string;
  usuario: string;
  /** How many items are in each state. Drives the header's progress. */
  counts: Record<ItemState, number>;
  /** Writes in flight. Zero means everything on screen is also on disk. */
  pending: number;
  failures: readonly WriteFailure[];
  /** Non-null once the store has given up. Nothing may be appended. */
  halted: Halt | null;
  /** False when nothing protects an unflushed event but this tab staying open. */
  protected: boolean;
}

export interface CountStoreOptions {
  usuario: string;
  deviceId: string;
  /** First unused sequence number for this device, from the store (§6). */
  nextSeq: number;
  zona: string;
  outbox: Outbox;
  /** Injected so tests get a fixed `at`; production passes the real clock. */
  clock?: () => string;
  /** Injected so tests get stable event ids. */
  newId?: () => string;
}

export class CountStore {
  private readonly repo: CountRepository;
  private readonly deviceId: string;
  private readonly outbox: Outbox;
  private readonly clock: () => string;
  private readonly newId: () => string;

  private readonly byItem = new Map<number, CountEvent[]>();
  private seq: number;
  private failureStreak = 0;
  private snapshot: CountSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    repo: CountRepository,
    session: Session,
    events: readonly CountEvent[],
    options: CountStoreOptions,
  ) {
    this.repo = repo;
    this.deviceId = options.deviceId;
    this.outbox = options.outbox;
    this.clock = options.clock ?? nowInstant;
    this.newId = options.newId ?? (() => crypto.randomUUID());

    for (const event of events) {
      const bucket = this.byItem.get(event.idarticulo);
      if (bucket) bucket.push(event);
      else this.byItem.set(event.idarticulo, [event]);
    }

    // From the device row, not from the log. The watermark is advanced inside
    // the transaction that writes each event (DOMAIN.md §6), so it is correct
    // whether or not this session's log — or any log — is in memory.
    this.seq = options.nextSeq;

    const resolutions = resolveAll(events);
    this.snapshot = {
      session,
      events: events.slice(),
      resolutions,
      zona: options.zona,
      usuario: options.usuario,
      counts: tally(session, resolutions),
      pending: 0,
      failures: [],
      halted: null,
      protected: options.outbox.available,
    };
  }

  /**
   * Load a session and its whole log.
   *
   * The log is read once, in full, and never consulted again for a read: every
   * subsequent question is answered from memory. A session's log is a few
   * hundred events.
   */
  static async open(
    repo: CountRepository,
    sessionId: string,
    options: CountStoreOptions,
  ): Promise<CountStore> {
    const session = await repo.getSession(sessionId);
    if (!session) throw new Error(`no existe la sesión ${sessionId}`);
    const events = await repo.eventsForSession(sessionId);
    return new CountStore(repo, session, events, options);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CountSnapshot => this.snapshot;

  private emit(next: Partial<CountSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  resolutionFor(idarticulo: number): Resolution {
    return this.snapshot.resolutions.get(idarticulo) ?? UNTOUCHED;
  }

  eventsFor(idarticulo: number): CountEvent[] {
    return (this.byItem.get(idarticulo) ?? []).slice();
  }

  setZona(zona: string): void {
    this.emit({ zona });
  }

  setUsuario(usuario: string): void {
    this.emit({ usuario });
  }

  // --- what a counter can do ------------------------------------------------

  /** A keypad entry, and what `Coincide con el sistema` appends. */
  setCount(idarticulo: number, qty: number): CountEvent {
    return this.append(idarticulo, { kind: 'set', qty });
  }

  /** One tap in tally mode. A negative `qty` walks a mis-tap back (§3). */
  addCount(idarticulo: number, qty: number): CountEvent {
    return this.append(idarticulo, { kind: 'add', qty });
  }

  /** A waiver. Carries a name and a time, which is the whole point (§4). */
  markUnchanged(idarticulo: number, motivo?: string): CountEvent {
    return this.append(idarticulo, { kind: 'unchanged', motivo });
  }

  /**
   * The supervisor's bulk waiver — the only route to posting an incomplete
   * count (DOMAIN.md §4).
   *
   * A `motivo` is required here and only here. The counter's waiver refuses to
   * ask for one, because prompting somebody at the moment they are escaping
   * turns the escape hatch back into a form (§3); one action covering two
   * hundred rows is a much larger claim, and friction is the correct answer to
   * it. Rejected rather than defaulted: a bulk waiver whose reason was
   * "(sin motivo)" would be indistinguishable in the log from one somebody
   * thought about.
   *
   * `usuario` is the supervisor's, not the counter's — this is the one place a
   * store stamps a name other than the one it was opened with, and the whole
   * value of the events it writes is whose signature they carry.
   *
   * `zona` is deliberately empty. The counter's zone says where somebody
   * stood; nobody stood anywhere for these, and stamping the last zone a
   * tablet was set to would put a place on an event that never happened there.
   *
   * One event per item, each one held, flushed and acknowledged on its own.
   * Two hundred transactions rather than one is the cost of every row being
   * independently durable and independently attributable.
   */
  waiveMany(
    idarticulos: readonly number[],
    options: { motivo: string; usuario: string },
  ): CountEvent[] {
    const motivo = options.motivo.trim();
    if (motivo.length === 0) {
      throw new Error(
        'una exención masiva necesita un motivo: es la única razón por la que ' +
          'un conteo incompleto puede generar un archivo',
      );
    }
    const usuario = options.usuario.trim();
    if (usuario.length === 0) {
      throw new Error('escribe quién autoriza la exención antes de firmarla');
    }
    return idarticulos.map((idarticulo) =>
      this.append(idarticulo, { kind: 'unchanged', motivo }, { usuario, zona: '' }),
    );
  }

  /**
   * Withdraw everything recorded against this item (§3).
   *
   * The item goes back to `untouched` and to blocking a post, which is the
   * point: a withdrawn count should make somebody deal with it rather than
   * quietly resolving into a number nobody counted.
   */
  retract(idarticulo: number): CountEvent {
    return this.append(idarticulo, { kind: 'retract' });
  }

  /**
   * True when there is anything to undo.
   *
   * Asked of the domain rather than answered here: `undoLast` returns `null`
   * exactly when the event it would produce would leave the resolution where it
   * is, so "is there something to undo" and "what would undoing append" are the
   * same question and get the same answer. A screen with its own rule for this
   * is a second copy of the fold (DOMAIN.md §3).
   */
  canUndo(idarticulo: number): boolean {
    return undoLast(this.byItem.get(idarticulo) ?? []) !== null;
  }

  /** True when a withdrawal would actually withdraw something. Same rule. */
  canRetract(idarticulo: number): boolean {
    return changesResolution(this.byItem.get(idarticulo) ?? [], { kind: 'retract' });
  }

  /**
   * Undo by **appending**, never by deleting (DOMAIN.md §3).
   *
   * The rule lives in the domain, because undoing a `set` has to restore the
   * previous *resolution* and only a fold knows what that was.
   */
  undo(idarticulo: number): CountEvent | null {
    const draft = undoLast(this.byItem.get(idarticulo) ?? []);
    if (!draft) return null;
    return this.append(idarticulo, draft);
  }

  // --- the write path -------------------------------------------------------

  private append(
    idarticulo: number,
    draft: CountEventDraft,
    /** Overrides for an event a different person is signing — see `waiveMany`. */
    stamp?: { usuario: string; zona: string },
  ): CountEvent {
    if (this.snapshot.halted) {
      throw new Error(
        'el guardado está detenido; no se aceptan más conteos hasta reintentar',
      );
    }

    const { session } = this.snapshot;
    const usuario = stamp?.usuario ?? this.snapshot.usuario;
    const zona = stamp?.zona ?? this.snapshot.zona;
    const base = {
      id: this.newId(),
      sessionId: session.id,
      idarticulo,
      usuario,
      zona,
      at: this.clock(),
      deviceId: this.deviceId,
      seq: this.seq++,
    };
    let event: CountEvent;
    switch (draft.kind) {
      case 'set':
        event = { ...base, kind: 'set', qty: draft.qty };
        break;
      case 'add':
        event = { ...base, kind: 'add', qty: draft.qty };
        break;
      case 'unchanged':
        event = { ...base, kind: 'unchanged', ...(draft.motivo ? { motivo: draft.motivo } : {}) };
        break;
      case 'retract':
        event = { ...base, kind: 'retract' };
        break;
    }

    this.apply(event);
    // Synchronous and durable, between the render and the flush. This is the
    // only line standing between an optimistic write and a tab closed at the
    // wrong moment.
    const held = this.outbox.hold(event);
    if (!held && this.snapshot.protected) this.emit({ protected: false });
    this.persist(event, held);
    return event;
  }

  /** In-memory first: this is what the screen re-renders from. */
  private apply(event: CountEvent): void {
    const bucket = this.byItem.get(event.idarticulo);
    if (bucket) bucket.push(event);
    else this.byItem.set(event.idarticulo, [event]);

    const resolutions = new Map(this.snapshot.resolutions);
    resolutions.set(event.idarticulo, resolve(this.byItem.get(event.idarticulo)!));
    this.emit({
      events: [...this.snapshot.events, event],
      resolutions,
      counts: tally(this.snapshot.session, resolutions),
    });
  }

  /** IndexedDB last, and never on the critical path. */
  private persist(event: CountEvent, held: boolean): void {
    this.emit({ pending: this.snapshot.pending + 1 });
    void this.repo.appendEvent(event).then(
      () => {
        this.outbox.release(event.id);
        this.failureStreak = 0;
        this.emit({ pending: Math.max(0, this.snapshot.pending - 1) });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.failureStreak++;
        this.emit({
          pending: Math.max(0, this.snapshot.pending - 1),
          failures: [...this.snapshot.failures, { event, message }],
          halted: this.snapshot.halted ?? this.haltFor(held, message),
        });
      },
    );
  }

  /**
   * Whether this failure ends the count, and what to tell the person.
   *
   * Two thresholds, because two different things have gone wrong. An event the
   * outbox could not hold and the database would not take exists nowhere but
   * this tab: one failure is already fatal. An event the outbox is holding
   * survives a reload, so it takes a run of failures to conclude the database
   * is gone rather than busy.
   */
  private haltFor(held: boolean, message: string): Halt | null {
    if (!held) {
      return {
        title: 'Este conteo no se guardó en ninguna parte',
        detail:
          `La tableta rechazó la copia local y la base de datos falló: «${message}». ` +
          'Lo que ves en pantalla existe sólo en esta pestaña. No sigas contando: ' +
          'anota a mano lo que lleves y avisa a sistemas antes de cerrar.',
      };
    }
    if (this.failureStreak >= HALT_AFTER) {
      return {
        title: 'No se está guardando nada',
        detail:
          `${this.failureStreak} registros seguidos no llegaron a la base de datos ` +
          `(«${message}»). Se conservan en la tableta y se reintentan al volver a ` +
          'abrir, pero no sigas contando hasta que un reintento funcione.',
      };
    }
    return null;
  }

  /**
   * Re-attempt everything that did not land, and resume counting if it works.
   *
   * `appendEvent` is idempotent by id, so an event that actually reached the
   * database and only failed to be released is a no-op here.
   */
  retryFailures(): void {
    const failures = this.snapshot.failures;
    if (failures.length === 0) return;
    this.failureStreak = 0;
    this.emit({ failures: [], halted: null });
    for (const { event } of failures) {
      const held = this.outbox.hold(event);
      this.persist(event, held);
    }
  }

  /** Resolves once every optimistic write has settled. Tests await it. */
  async settled(): Promise<void> {
    while (this.snapshot.pending > 0) {
      await new Promise((done) => setTimeout(done, 0));
    }
  }
}
