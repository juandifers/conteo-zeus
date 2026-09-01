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
  assertNormalisedInstant,
  chainHash,
  changesResolution,
  isItemEvent,
  nowInstant,
  resolve,
  resolveAll,
  undoLast,
  type ChainedEvent,
  type CountEvent,
  type CountEventDraft,
  type CounterChainRepository,
  type CounterEventDraft,
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
  /**
   * The chain link, in P2 mode, so a retry writes the same row rather than an
   * unhashed one. `null` for P1 events, which have no chain.
   */
  link: ChainedEvent | null;
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
  /**
   * Injected so tests get a fixed `at`; production passes the real clock.
   *
   * Whatever it returns is clamped to be non-decreasing for this device — see
   * `stamp`. A pinned clock therefore yields the pinned value repeatedly,
   * which is what a pinned clock should mean.
   */
  clock?: () => string;
  /** Injected so tests get stable event ids. */
  newId?: () => string;
  /**
   * **The presence of this is P2 mode.**
   *
   * A store opened with a `counterId` is one counter's device in a dispatched
   * session: every event it appends carries the id, is chained onto `head`, and
   * is written through `chain` with a `pendiente` flag rather than through
   * `repo.appendEvent`. Undo is scoped to this counter's own events, and the
   * whole-item withdrawal is refused outright (P2.2's gate).
   *
   * Absent, the store is P1's: one device, one session, entirely local, and
   * `retract()` keeps its whole-item meaning for the logs that already contain
   * them (docs/MIGRATION-P1-P2.md).
   */
  counterId?: string;
  /**
   * The chain head this device continues from. Required in P2 mode.
   *
   * Passed in rather than recomputed from the loaded log, because a replacement
   * tablet holds none of the log and still has to continue the chain — it asks
   * the server where the counter stands and starts from there. Recomputing
   * locally would put a fresh device at the genesis hash with the server forty
   * events ahead, which is a fork.
   */
  head?: string;
  /** The outbox. Required in P2 mode; unused otherwise. */
  chain?: CounterChainRepository;
  /**
   * A clock watermark this device must not stamp earlier than.
   *
   * For a replacement tablet. `stamp` already keeps *this* device
   * non-decreasing, seeded from its own events in the log — but a spare holds
   * none of them, and the fold orders by `at` before `deviceId` and `seq`
   * (DOMAIN.md §3). A spare whose clock runs five minutes behind the tablet it
   * replaced would stamp events that sort *before* the ones they continue, and
   * for one counter's own article that is the difference between a waiver
   * withdrawing a count and the count overriding the waiver. Seeded from
   * `/api/c/:token/resume`, which reports the latest `at` the server holds.
   */
  highWater?: string;
}

export class CountStore {
  private readonly repo: CountRepository;
  private readonly deviceId: string;
  private readonly outbox: Outbox;
  private readonly clock: () => string;
  private readonly newId: () => string;
  /** Present exactly in P2 mode — see `CountStoreOptions.counterId`. */
  readonly counterId?: string;
  private readonly chain?: CounterChainRepository;
  /** This counter's chain head. Advances with every append in P2 mode. */
  private head: string;

  private readonly byItem = new Map<number, CountEvent[]>();
  private seq: number;
  /** The greatest `at` this device has already stamped. See `stamp`. */
  private highWater: string;
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
    this.counterId = options.counterId;
    this.chain = options.chain;
    this.head = options.head ?? '';
    if (this.counterId !== undefined && (options.head === undefined || !options.chain)) {
      throw new Error(
        'un store en modo contador necesita `head` y `chain`: sin ellos los eventos ' +
          'no quedan encadenados ni en la bandeja de salida, y un evento que no está ' +
          'en la bandeja no se sube nunca',
      );
    }

    for (const event of events) {
      // `byItem` is the per-article index the screens fold from, so the
      // session-scoped kinds have no bucket here. They are still in
      // `snapshot.events`; nothing about an article is derived from them.
      if (!isItemEvent(event)) continue;
      const bucket = this.byItem.get(event.idarticulo);
      if (bucket) bucket.push(event);
      else this.byItem.set(event.idarticulo, [event]);
    }

    // From the device row, not from the log. The watermark is advanced inside
    // the transaction that writes each event (DOMAIN.md §6), so it is correct
    // whether or not this session's log — or any log — is in memory.
    this.seq = options.nextSeq;

    // The time watermark, seeded from this device's own stamps in the log.
    //
    // A fresh store starts with no memory of the last stamp, so without this a
    // reload after a backward clock correction reintroduces exactly the bug
    // `stamp` exists to prevent: the tablet drifts forward in a storeroom with
    // no signal, reconnects, NTP pulls it back, somebody reloads, and the next
    // correction they type sorts *before* the value they are correcting.
    //
    // Only this device's events. Another tablet's stamps are not this clock's
    // to be bound by — cross-device ordering stays wall-clock (DOMAIN.md §3),
    // and clamping to a peer whose clock ran fast would freeze this one's
    // stamps at that peer's time for as long as the drift lasted.
    let highWater = '';
    for (const event of events) {
      if (event.deviceId === this.deviceId && event.at > highWater) highWater = event.at;
    }
    // Seeded from the caller when this device is continuing somebody else's
    // tablet — see `CountStoreOptions.highWater`.
    this.highWater = options.highWater !== undefined && options.highWater > highWater
      ? options.highWater
      : highWater;

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

  /** A keypad entry: the only way a quantity gets into the log (§2.1). */
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
   * Withdraw everything recorded against this item — **P1 only** (§3).
   *
   * The item goes back to `untouched` and to blocking a post, which is the
   * point: a withdrawn count should make somebody deal with it rather than
   * quietly resolving into a number nobody counted.
   *
   * **Refused in P2 mode**, and this is the gate P2.2 opens with. Under several
   * counters "this article returns to untouched" is a data-loss bug that
   * nothing downstream catches: Ana withdrawing her own mis-tap on article 4471
   * silently discards Luis's count of it, the chain stays intact because nothing
   * was tampered with, the export is well-formed, `verifyWriteBack` passes — and
   * it surfaces as a variance nobody can explain, weeks later. It is never what
   * the person tapping it intends, so it is not offered.
   *
   * `canRetract` returns false in P2 mode for the same reason, which is what
   * takes «Descartar conteo» off the screen: the button is derived from the
   * fold, not from a flag a component sets (`EntryCard`).
   */
  retract(idarticulo: number): CountEvent {
    if (this.counterId !== undefined) {
      throw new Error(
        'descartar el conteo completo de un artículo no existe en el flujo de varios ' +
          'contadores: borraría también lo que contó otra persona en el mismo artículo. ' +
          'Para deshacer lo propio, usa «Deshacer» (P2.2)',
      );
    }
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
    return undoLast(this.byItem.get(idarticulo) ?? [], this.counterId) !== null;
  }

  /**
   * Whether this store offers a whole-item withdrawal **at all**.
   *
   * Distinct from `canRetract`, which is "would it change anything right now".
   * A screen must not render the control as permanently disabled in P2 mode: a
   * dead button is an action somebody keeps trying, and the action does not
   * exist there. False in P2 mode, always.
   */
  get offersWholeItemDiscard(): boolean {
    return this.counterId === undefined;
  }

  /**
   * True when a whole-item withdrawal would actually withdraw something.
   *
   * Always false in P2 mode: there is no such action there, so there is no
   * state in which it is available. Everything that reads this — the
   * «Descartar conteo» button in `EntryCard` is the only caller — disappears
   * with it, which is how the gate reaches the screen without the screen
   * knowing which phase it is in.
   */
  canRetract(idarticulo: number): boolean {
    if (this.counterId !== undefined) return false;
    return changesResolution(this.byItem.get(idarticulo) ?? [], { kind: 'retract' });
  }

  /**
   * Undo by **appending**, never by deleting (DOMAIN.md §3).
   *
   * The rule lives in the domain, because undoing a `set` has to restore the
   * previous *resolution* and only a fold knows what that was.
   */
  undo(idarticulo: number): CountEvent | null {
    // Scoped to this counter in P2 mode: a counter may withdraw only what they
    // wrote (DOMAIN.md §6), which needs no cross-device agreement and no clock
    // at all. In P1 mode `counterId` is undefined and this is the whole log,
    // which is the single-counter case and what the existing callers pass.
    const draft = undoLast(this.byItem.get(idarticulo) ?? [], this.counterId);
    if (!draft) return null;
    return this.append(idarticulo, draft);
  }

  // --- the P2 counter's session-scoped events -------------------------------

  /**
   * "I am done" — a **manifest**, not a marker (§2a).
   *
   * `finalSeq` is this counter's last content event and `headHash` is the chain
   * head at it, both taken from the store's own running state, so the claim is
   * one the server can check rather than one it has to accept. A counter who
   * recorded nothing finishes with `finalSeq = 0`, `headHash = genesis` and
   * `finish.seq = 1`; that is a valid and entirely ordinary morning — assigned
   * a section, walked over, found it already counted by receiving — and it is
   * tested explicitly, because an off-by-one here fails on the least suspicious
   * person's tablet.
   *
   * The event is appended **before** any attempt to upload it. Finishing is
   * something the counter did; whether the network cooperated is a separate
   * fact, and a button that waited on a network that is not there would be a
   * force-close, which is the one thing that loses data.
   */
  finish(): CountEvent {
    this.requireCounter('finish');
    return this.append(null, {
      kind: 'finish',
      finalSeq: this.seq - 1,
      headHash: this.head,
    });
  }

  /**
   * Withdraw a `finish`: this counter found a stray box and is counting again.
   *
   * `seq` carries on unbroken. A new chain would defeat the manifest — the
   * point of `finalSeq`/`headHash` is that the server can walk one numbering
   * from 1 and find no hole, and a second chain starting over is exactly the
   * hole it is looking for.
   */
  reopen(): CountEvent {
    this.requireCounter('reopen');
    return this.append(null, { kind: 'reopen' });
  }

  /** A remark, about one article or about the session (§4). */
  note(texto: string, idarticulo: number | null = null): CountEvent {
    this.requireCounter('note');
    return this.append(idarticulo, { kind: 'note', texto, idarticulo });
  }

  /** This counter's chain head, for the manifest and for the push. */
  chainHead(): string {
    return this.head;
  }

  private requireCounter(kind: string): void {
    if (this.counterId === undefined) {
      throw new Error(
        `un evento ${kind} pertenece a un contador y este store se abrió sin counterId ` +
          '(sesión P1, local y sin cadena)',
      );
    }
  }

  // --- the write path -------------------------------------------------------

  private append(
    idarticulo: number | null,
    draft: CountEventDraft | CounterEventDraft,
    /** Overrides for an event a different person is signing — see `waiveMany`. */
    stamp?: { usuario: string; zona: string },
  ): CountEvent {
    if (this.snapshot.halted) {
      throw new Error(
        'el guardado está detenido; no se aceptan más conteos hasta reintentar',
      );
    }
    // The gate, at runtime as well as in the type. `CounterEventDraft` makes an
    // unscoped withdrawal unspellable in the P2 path, but this method is also
    // where a draft that came from `undoLast` — typed as the wider
    // `CountEventDraft` — arrives, and a domain function that returned one
    // without a target would otherwise walk straight past the compiler.
    if (
      this.counterId !== undefined &&
      draft.kind === 'retract' &&
      draft.retractsEventId === undefined
    ) {
      throw new Error(
        'una retractación sin `retractsEventId` retira el artículo completo, ' +
          'incluido lo que contó otra persona. En una sesión con varios contadores ' +
          'no existe (P2.2)',
      );
    }

    const { session } = this.snapshot;
    const usuario = stamp?.usuario ?? this.snapshot.usuario;
    const zona = stamp?.zona ?? this.snapshot.zona;
    const base = {
      id: this.newId(),
      sessionId: session.id,
      ...(this.counterId === undefined ? {} : { counterId: this.counterId }),
      usuario,
      zona,
      at: this.stamp(),
      deviceId: this.deviceId,
      seq: this.seq++,
    };
    // The item-scoped kinds narrow `idarticulo` back to a number. Checked
    // rather than asserted: this method is now the write path for the
    // session-scoped kinds too, and a `set` that arrived with no primary key
    // would otherwise be stored as an event the fold cannot bucket
    // (ZEUS_FORMAT.md §4).
    const key = (): number => {
      if (idarticulo === null) {
        throw new Error(
          `un evento ${draft.kind} afirma algo sobre un artículo y llegó sin idarticulo`,
        );
      }
      return idarticulo;
    };

    let event: CountEvent;
    switch (draft.kind) {
      case 'set':
        event = { ...base, idarticulo: key(), kind: 'set', qty: draft.qty };
        break;
      case 'add':
        event = { ...base, idarticulo: key(), kind: 'add', qty: draft.qty };
        break;
      case 'unchanged':
        event = {
          ...base,
          idarticulo: key(),
          kind: 'unchanged',
          ...(draft.motivo ? { motivo: draft.motivo } : {}),
        };
        break;
      case 'retract':
        event = {
          ...base,
          idarticulo: key(),
          kind: 'retract',
          // Present when `undoLast` named a target; absent when the screen's
          // "withdraw everything" button asked for the P1 whole-item
          // withdrawal, which is still correct on a single device. Giving that
          // button event-scoped semantics is P2.2's job, not this layer's.
          ...(draft.retractsEventId ? { retractsEventId: draft.retractsEventId } : {}),
        };
        break;
      case 'note':
        event = { ...base, kind: 'note', texto: draft.texto, idarticulo: draft.idarticulo };
        break;
      case 'finish':
        event = {
          ...base,
          kind: 'finish',
          idarticulo: null,
          finalSeq: draft.finalSeq,
          headHash: draft.headHash,
        };
        break;
      case 'reopen':
        event = { ...base, kind: 'reopen', idarticulo: null };
        break;
    }

    // In P2 mode the chain advances *here*, in memory, before anything is
    // written. It has to: the next event's `prevHash` is this event's hash, so
    // a device that waited for the database between two taps would be a device
    // that queues on IndexedDB — the exact thing the optimistic write exists to
    // avoid. The hash is a pure function of the event, so nothing about it is a
    // guess; what the durable write decides is whether the row survives, and a
    // write that fails halts the store.
    let link: ChainedEvent | null = null;
    if (this.counterId !== undefined) {
      const prevHash = this.head;
      const hash = chainHash(prevHash, event);
      this.head = hash;
      link = { event, prevHash, hash };
    }

    this.apply(event);
    // P1's lifeboat: synchronous and durable, between the render and the flush,
    // the only line standing between an optimistic write and a tab closed at
    // the wrong moment.
    //
    // **Not used in P2 mode.** There the durable outbox is a flag on the event
    // row itself (`CounterChainRepository`), and P2.2 §1a is explicit that it
    // must be a projection of that flag and not a second copy — two stores that
    // can disagree about what happened is the failure the whole design avoids.
    // A `localStorage` queue would also be replayed through `appendEvent`,
    // which writes no chain metadata, so a replayed event would land unhashed
    // and unpushable: a lifeboat that quietly drops the passenger.
    const held = link === null ? this.outbox.hold(event) : true;
    if (!held && this.snapshot.protected) this.emit({ protected: false });
    this.persist(event, held, link);
    return event;
  }

  /**
   * This device's clock, made non-decreasing.
   *
   * `compareEvents` orders by `at` first and only then by `deviceId` and
   * `seq` (DOMAIN.md §3), so `seq` — which *is* monotonic — decides nothing
   * but same-millisecond ties. A tablet whose clock corrects **backwards**
   * mid-session therefore sorts everything after the correction before
   * everything before it, and a `set` is last-writer-wins: an operator's
   * correction silently loses to the value they were correcting, no screen
   * shows it, and the wrong number reaches the file.
   *
   * A tablet spends the afternoon in a storeroom with no signal and then
   * reconnects, which is when NTP pulls it back. This is not a hypothetical
   * ordering concern.
   *
   * So this device never stamps an event earlier than one it has already
   * stamped. Two events can now share an `at`, which is fine and already
   * handled: same device, so `seq` breaks the tie in the order the taps
   * actually happened — which is the true order, and better than the one a
   * corrected clock would have claimed.
   *
   * String comparison rather than `Date.parse`: `assertNormalisedInstant`
   * guarantees a fixed-width UTC instant, which is the same guarantee the fold
   * relies on to compare these as strings at all. It is asserted here rather
   * than left to `appendEvent`, because a malformed stamp would make the
   * comparison below meaningless *before* the repository ever saw it.
   *
   * `compareEvents` itself is untouched. Cross-device ordering stays
   * wall-clock, which is the right trade for a single-bodega pilot with no
   * sync — clamping one device against another's stamps would be inventing a
   * consensus clock for a system that has one device.
   */
  private stamp(): string {
    const now = this.clock();
    assertNormalisedInstant(now, `el reloj de esta tableta devolvió ${JSON.stringify(now)}`);
    if (now > this.highWater) this.highWater = now;
    return this.highWater;
  }

  /** In-memory first: this is what the screen re-renders from. */
  private apply(event: CountEvent): void {
    if (!isItemEvent(event)) {
      // Nothing about an article changed, so no resolution is recomputed and
      // the tally is untouched. The event is still appended: the log is the
      // record, and `finish`/`reopen`/a session-wide `note` are part of it.
      this.emit({ events: [...this.snapshot.events, event] });
      return;
    }

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
  private persist(event: CountEvent, held: boolean, link: ChainedEvent | null = null): void {
    this.emit({ pending: this.snapshot.pending + 1 });
    const written =
      link === null ? this.repo.appendEvent(event) : this.chain!.appendChained(link);
    void written.then(
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
          failures: [...this.snapshot.failures, { event, message, link }],
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
    for (const { event, link } of failures) {
      const held = link === null ? this.outbox.hold(event) : true;
      this.persist(event, held, link);
    }
  }

  /** Resolves once every optimistic write has settled. Tests await it. */
  async settled(): Promise<void> {
    while (this.snapshot.pending > 0) {
      await new Promise((done) => setTimeout(done, 0));
    }
  }
}
