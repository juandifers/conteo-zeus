/**
 * Persistence port.
 *
 * The interface lives in the domain and the implementation lives in
 * src/store/ (Dexie over IndexedDB), so the domain — and its tests — never
 * depend on a browser database. `MemoryRepository` below is the second
 * implementation, which is what keeps the port honest.
 */
import { assertNormalisedInstant } from './time';
import type { CountEvent, ExportRecord, Item, Session, SessionMeta } from './types';

/** What a device needs to know about itself before it may stamp an event. */
export interface DeviceIdentity {
  /** Stable for the life of the install. A tie-break key in the fold (§3). */
  deviceId: string;
  /** The first `seq` this device has not used. */
  nextSeq: number;
}

/**
 * Where a device's own identity is kept.
 *
 * Separate from `CountRepository` because it answers a different question — not
 * "what happened" but "who am I" — and because a merge server would implement
 * the first and not the second. Both local implementations satisfy both.
 *
 * There is no fallback. If this cannot be read, the app must refuse to count
 * rather than improvise an id: an event stamped with a `deviceId` that will not
 * be there next time is an event nothing can order afterwards (DOMAIN.md §6).
 */
export interface DeviceRepository {
  identify(): Promise<DeviceIdentity>;
}

/**
 * Where the record of a generated file is kept (DOMAIN.md §4).
 *
 * Separate from `CountRepository` for the same reason `DeviceRepository` is:
 * it answers a different question. The count is what happened in the bodega;
 * this is what left the building. A merge server would hold the first and
 * would not necessarily hold the second, since a file generated on one laptop
 * is not an event that happened to the stock.
 *
 * Append-only, like the log. Generating a second file does not supersede the
 * first — the ERP may well have received both.
 */
export interface ExportRepository {
  /** Rejects a re-used `id`: the bytes it describes have already been written. */
  recordExport(record: ExportRecord): Promise<void>;

  /** Every file generated for this session, unordered — callers sort on `at`. */
  exportsForSession(sessionId: string): Promise<ExportRecord[]>;
}

/**
 * Where a counter's own event stands on the way to the server (P2.2 §1a).
 *
 * `pendiente` is the outbox. It is a **flag on the event**, not a second table:
 * two stores that can disagree about what happened is the bug this whole
 * architecture exists to avoid, so "what is unsynced" is a query rather than a
 * copy.
 *
 * `rechazado_sesion_sellada` is the ugly case and it is a state rather than a
 * deletion. A tablet that was offline when the admin sealed will eventually
 * push events that can no longer be accepted; the counter's afternoon still
 * happened, and it has to remain on the device where somebody can export it and
 * attach it to the acta.
 */
export type SyncState = 'pendiente' | 'confirmado' | 'rechazado_sesion_sellada';

/** One event and where it sits in its counter's chain (src/domain/chain.ts). */
export interface ChainedEvent {
  event: CountEvent;
  prevHash: string;
  hash: string;
}

/**
 * The device side of sync — a second port, for the same reason `DeviceRepository`
 * is one: it answers a different question.
 *
 * `CountRepository` is "what happened in this bodega". This is "what of it has
 * reached the server", which only a counting *device* has, and which a merge
 * server would not implement at all.
 *
 * Nothing here deletes. An event leaves the outbox by having its flag moved,
 * and only ever on a **definite** ack naming the sequence range accepted — never
 * on a timeout, a 5xx, or an aborted request. Over-delivery is free, since
 * events are immutable and keyed by a device-generated uuid, and under-delivery
 * is a lost morning of counting.
 */
export interface CounterChainRepository {
  /**
   * Append a chained event and its flag in **one** transaction.
   *
   * One transaction and not two: an event whose chain metadata did not land is
   * an event that can never be pushed, and an event that landed without its
   * flag is an event that will never be pushed. Neither is recoverable by
   * looking at the row afterwards, because both look exactly like a row that
   * was never written.
   */
  appendChained(link: ChainedEvent): Promise<void>;

  /**
   * Several chained events, in **one** transaction, all or none.
   *
   * What «Corregir» needs (P2.3 §3). An edit is a scoped withdrawal followed by
   * a fresh `add`, never a mutation — and the two halves are not independently
   * meaningful: a withdrawal that landed without its replacement is a count
   * somebody deleted, and a replacement that landed without its withdrawal is a
   * count entered twice. Both appear in «Mis registros» or neither does.
   *
   * The links must be contiguous in `seq` and chained onto each other, which is
   * what the caller already has: the store advances its head in memory as it
   * builds them.
   */
  appendChainedBatch(links: readonly ChainedEvent[]): Promise<void>;

  /**
   * Where this counter's chain stands **on this device**, or `null` when this
   * device holds none of it.
   *
   * `null` is not "the counter has nothing". A replacement tablet — the spare
   * somebody picks up when the first one dies mid-shift — holds nothing and the
   * counter has forty events on the server, so the device asks the server where
   * to resume rather than assuming it is at the beginning. Starting over at seq
   * 1 would be a fork, and a fork is the one failure in this system that does
   * not resolve itself.
   */
  localChain(sessionId: string, counterId: string): Promise<{ maxSeq: number; head: string } | null>;

  /**
   * The outbox: unsynced events, ascending `seq`, contiguous from the lowest.
   *
   * Contiguous because the push protocol requires it — a batch with a hole in it
   * is a batch the server refuses as a gap — and ascending because the chain is.
   */
  unsynced(sessionId: string, counterId: string, limit: number): Promise<ChainedEvent[]>;

  /** A definite ack: everything up to and including `throughSeq` is on the server. */
  markSynced(sessionId: string, counterId: string, throughSeq: number): Promise<void>;

  /**
   * Put everything from `fromSeq` on back into the outbox.
   *
   * The answer to `SEQUENCE_GAP`: the server says it holds nothing past
   * `expectedFrom - 1`, and this device believes otherwise. The device is the
   * one that is wrong — the server is the record — so it resends. Safe in the
   * direction that matters: over-delivery is a no-op, since events are
   * immutable and keyed by a device-generated uuid, and the alternative is a
   * hole nobody ever fills.
   */
  resetFrom(sessionId: string, counterId: string, fromSeq: number): Promise<void>;

  /** The session was sealed before these arrived. Kept, never deleted. */
  markRejected(sessionId: string, counterId: string): Promise<void>;

  /** Everything the server refused because the session was sealed, for export. */
  rejected(sessionId: string, counterId: string): Promise<ChainedEvent[]>;

  /**
   * Every counter on **this device** with something still in the outbox
   * (P2.3.5 §6a).
   *
   * The handover case, and the reason it is a query rather than a field on a
   * screen. Pedro takes over Luis's physical tablet; Luis's rows are still here,
   * some unsynced. Everything in this port is already keyed by
   * `(sessionId, counterId)` rather than by device or by "current session" —
   * which is what stops Pedro's arrival stranding or, worse, re-attributing
   * Luis's morning — but a queue whose owner went home is a queue nothing looks
   * at, and a queue nothing looks at never drains.
   *
   * So the drain runs for every counter listed here, in the background,
   * foreground or not, and the sync indicator can say «Luis: 23 registros sin
   * subir» while Pedro is counting.
   *
   * There is deliberately no companion that *deletes* one. There is no state in
   * which discarding another person's unsynced counts is the right thing for a
   * tablet to do on its own.
   */
  pendingOutboxes(): Promise<PendingOutbox[]>;
}

/** One counter's queue on this device, whoever is using it right now. */
export interface PendingOutbox {
  sessionId: string;
  counterId: string;
  /** Events still flagged `pendiente`. Never zero: an empty queue is not listed. */
  pendientes: number;
}

export interface CountRepository {
  /**
   * Persist a new session and its frozen items.
   *
   * Rejects if the id already exists: items are immutable once the session
   * exists, so a re-import is a new session, not an overwrite (see `Session`).
   */
  createSession(session: Session): Promise<void>;

  getSession(id: string): Promise<Session | undefined>;

  listSessions(): Promise<SessionMeta[]>;

  itemsForSession(sessionId: string): Promise<Item[]>;

  /**
   * The only write path for events. There is no update and no delete —
   * correcting a count means appending another event (DOMAIN.md §3).
   *
   * Idempotent by `id`: re-appending a byte-identical event is a no-op, so a
   * merge that re-delivers events it already has is safe. Re-using an `id` for
   * a *different* event is rejected, because that would be an edit wearing an
   * append's clothes.
   *
   * Rejects an `at` that is not a normalised UTC instant. This is the last
   * point at which a badly stamped event can be stopped: once it is in the log
   * it orders differently on different devices, and nothing downstream can tell.
   * Every implementation must enforce it — see `validateEvent`.
   *
   * Rejects a second event at an existing `(sessionId, deviceId, seq)`. That
   * triple is one device's own numbering, so a collision is a bug in the
   * allocator, never a case to arbitrate. Left in, it would put the fold's
   * `id` tie-break — a dedupe guard, not a decision mechanism (DOMAIN.md §3) —
   * in charge of whether a `set` or a `retract` wins, which is the difference
   * between an item posting and an item blocking the post.
   */
  appendEvent(event: CountEvent): Promise<void>;

  /** Events for one item, unordered — `resolve()` sorts them. */
  eventsForItem(sessionId: string, idarticulo: number): Promise<CountEvent[]>;

  /** Every event in the session, unordered. */
  eventsForSession(sessionId: string): Promise<CountEvent[]>;
}

/** Thrown when an `id` is re-used for a different event (see `appendEvent`). */
export class EventConflictError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `event ${id} already exists with different content. Events are append-only: ` +
        'to correct a count, append another event with a new id (DOMAIN.md §3).',
    );
    this.name = 'EventConflictError';
    this.id = id;
  }
}

/**
 * Thrown when a device reissues a sequence number it has already spent.
 *
 * Carries both ids because the useful question is which write is the stray one:
 * the stored event is the log's, the incoming one is whatever just tried to
 * claim its place.
 */
export class SequenceConflictError extends Error {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly existingId: string;
  readonly incomingId: string;

  constructor(event: CountEvent, existingId: string) {
    super(
      `device ${event.deviceId} already used seq ${event.seq} in session ` +
        `${event.sessionId} for event ${existingId}; event ${event.id} cannot ` +
        'reuse it. (sessionId, deviceId, seq) identifies one event — `id` breaks ' +
        'ties to keep the order total, it does not decide which of two events ' +
        'wins (DOMAIN.md §3).',
    );
    this.name = 'SequenceConflictError';
    this.sessionId = event.sessionId;
    this.deviceId = event.deviceId;
    this.seq = event.seq;
    this.existingId = existingId;
    this.incomingId = event.id;
  }
}

/**
 * Checks every implementation of `appendEvent` must run before storing.
 *
 * Shared rather than duplicated: a rule enforced by one adapter and not the
 * other is worse than no rule, because it holds right up until the day
 * persistence changes.
 */
export function validateEvent(event: CountEvent): void {
  const where = `event ${event.id} (idarticulo ${String(event.idarticulo)})`;
  assertNormalisedInstant(event.at, where);

  // A non-finite quantity is caught here rather than at the fold or the hash.
  // `chain.ts` would otherwise hash `String(NaN)` — `"NaN"` — which is a
  // perfectly good chain input that no two NaNs can be told apart by, and the
  // fold would throw somewhere far from the write that caused it.
  if ('qty' in event && !Number.isFinite(event.qty)) {
    throw new Error(`${where} carries a non-finite qty: ${String(event.qty)}`);
  }

  // A note is free text and its bytes go into the hash. Control characters
  // cannot forge a field boundary — `canonicalEvent` escapes through
  // `JSON.stringify` for exactly that reason — but they can make a note that
  // renders as one thing and hashes as another, and there is no reason a person
  // standing at a shelf needs one.
  if (event.kind === 'note') {
    const offending = [...event.texto].find(
      (ch) => ch !== '\n' && ch.codePointAt(0)! < 0x20,
    );
    if (offending !== undefined) {
      throw new Error(
        `${where}: the note carries the control character ` +
          `U+${offending.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}. ` +
          'Notes are free text, and free text is the one field a person types ' +
          'straight into the hash chain',
      );
    }
  }

  // A session-scoped kind may carry `idarticulo: null`; nothing else may.
  //
  // TypeScript proves this unreachable — the union says so — and that is
  // exactly why it is here. The repository is where an event arrives from a
  // merge or from a database row, and neither of those has been through the
  // compiler. `kind` is read off a widened value for the same reason: at this
  // point in the narrowing there is no type left to read it from.
  const { kind, idarticulo } = event as { kind: string; idarticulo: number | null };
  if (idarticulo === null && !SESSION_SCOPED_KINDS.has(kind)) {
    throw new Error(
      `${where}: a ${kind} event asserts something about one article and cannot ` +
        'carry a null idarticulo (ZEUS_FORMAT.md §4)',
    );
  }
}

/** The kinds that are about the session rather than about one item — see `SessionScopedEvent`. */
const SESSION_SCOPED_KINDS: ReadonlySet<string> = new Set(['note', 'finish', 'reopen']);

/** True when two events are the same event — used to make `appendEvent` idempotent. */
export function sameEvent(a: CountEvent, b: CountEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * In-memory `CountRepository`.
 *
 * For tests and for a session that has not been persisted yet. Deliberately in
 * the domain: it proves the port is expressible without IndexedDB.
 */
export class MemoryRepository
  implements CountRepository, DeviceRepository, ExportRepository
{
  private readonly sessions = new Map<string, Session>();
  private readonly events = new Map<string, CountEvent[]>();
  private readonly exports: ExportRecord[] = [];
  private device: DeviceIdentity | null = null;

  /**
   * Stable for the life of this instance, which is exactly as long as this
   * "install" lasts. `nextSeq` advances with every accepted event, for the same
   * reason the Dexie row does: so a second store opened against the same
   * repository does not reissue numbers the first one spent.
   */
  async identify(): Promise<DeviceIdentity> {
    this.device ??= { deviceId: crypto.randomUUID(), nextSeq: 0 };
    return { ...this.device };
  }

  async createSession(session: Session): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(
        `session ${session.id} already exists; a re-import creates a new session ` +
          'rather than mutating one',
      );
    }
    this.sessions.set(session.id, { ...session, items: session.items.slice() });
    this.events.set(session.id, []);
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map(({ items, source, ...meta }) => ({
      ...meta,
      itemCount: items.length,
      ...(source ? { sourceName: source.name } : {}),
    }));
  }

  async itemsForSession(sessionId: string): Promise<Item[]> {
    return (this.sessions.get(sessionId)?.items ?? []).slice();
  }

  async appendEvent(event: CountEvent): Promise<void> {
    validateEvent(event);
    const log = this.events.get(event.sessionId);
    if (!log) throw new Error(`no such session: ${event.sessionId}`);
    const existing = log.find((candidate) => candidate.id === event.id);
    if (existing) {
      if (sameEvent(existing, event)) return;
      throw new EventConflictError(event.id);
    }
    const sameSlot = log.find(
      (candidate) => candidate.deviceId === event.deviceId && candidate.seq === event.seq,
    );
    if (sameSlot) throw new SequenceConflictError(event, sameSlot.id);

    log.push({ ...event });
    this.advanceSeq(event);
  }

  /** The in-memory twin of the Dexie watermark — see `DeviceRow`. */
  private advanceSeq(event: CountEvent): void {
    if (this.device && event.deviceId === this.device.deviceId) {
      this.device.nextSeq = Math.max(this.device.nextSeq, event.seq + 1);
    }
  }

  async eventsForItem(sessionId: string, idarticulo: number): Promise<CountEvent[]> {
    return (this.events.get(sessionId) ?? []).filter(
      (event) => event.idarticulo === idarticulo,
    );
  }

  async eventsForSession(sessionId: string): Promise<CountEvent[]> {
    return (this.events.get(sessionId) ?? []).slice();
  }

  async recordExport(record: ExportRecord): Promise<void> {
    if (this.exports.some((existing) => existing.id === record.id)) {
      throw new Error(
        `export ${record.id} already exists; a record describes bytes that have ` +
          'already been written and cannot be rewritten',
      );
    }
    this.exports.push({ ...record, counts: { ...record.counts } });
  }

  async exportsForSession(sessionId: string): Promise<ExportRecord[]> {
    return this.exports
      .filter((record) => record.sessionId === sessionId)
      .map((record) => ({ ...record, counts: { ...record.counts } }));
  }
}


/**
 * In-memory `CounterChainRepository`.
 *
 * Deliberately in the domain, beside `MemoryRepository` and for the same
 * reason: a port with one implementation is a port nobody has checked is
 * expressible. This one is written against nothing but a `Map`, which is the
 * proof that "the outbox is a flag on the event" needs no database feature to
 * be true.
 */
export class MemoryChain implements CounterChainRepository {
  private readonly rows = new Map<string, ChainedEvent & { sync: SyncState }>();

  private mine(sessionId: string, counterId: string): (ChainedEvent & { sync: SyncState })[] {
    return [...this.rows.values()]
      .filter((row) => row.event.sessionId === sessionId && row.event.counterId === counterId)
      .sort((a, b) => a.event.seq - b.event.seq);
  }

  async appendChained(link: ChainedEvent): Promise<void> {
    await this.appendChainedBatch([link]);
  }

  /**
   * All or none, which in a `Map` means: decide everything first, write after.
   *
   * The staging is not ceremony. A batch whose second link conflicts must leave
   * the first unwritten, or the caller's next append chains onto a head this
   * store rejected — and the in-memory implementation is the one that has to
   * make that property explicit, since it has no transaction to inherit it from.
   */
  async appendChainedBatch(links: readonly ChainedEvent[]): Promise<void> {
    const staged: (ChainedEvent & { sync: SyncState })[] = [];
    for (const link of links) {
      validateEvent(link.event);
      if (!link.event.counterId) {
        throw new Error(`event ${link.event.id} has no counterId and so has no chain`);
      }
      const existing = this.rows.get(link.event.id);
      if (existing) {
        if (sameEvent(existing.event, link.event)) continue;
        throw new EventConflictError(link.event.id);
      }
      const taken = this.mine(link.event.sessionId, link.event.counterId).find(
        (row) => row.event.seq === link.event.seq,
      );
      const staging = staged.find(
        (row) =>
          row.event.sessionId === link.event.sessionId &&
          row.event.counterId === link.event.counterId &&
          row.event.seq === link.event.seq,
      );
      const slot = taken ?? staging;
      if (slot) throw new SequenceConflictError(link.event, slot.event.id);
      staged.push({ ...link, sync: 'pendiente' });
    }
    for (const row of staged) this.rows.set(row.event.id, row);
  }

  async localChain(
    sessionId: string,
    counterId: string,
  ): Promise<{ maxSeq: number; head: string } | null> {
    const mine = this.mine(sessionId, counterId);
    const last = mine[mine.length - 1];
    return last ? { maxSeq: last.event.seq, head: last.hash } : null;
  }

  async unsynced(sessionId: string, counterId: string, limit: number): Promise<ChainedEvent[]> {
    const pending = this.mine(sessionId, counterId).filter((row) => row.sync === 'pendiente');
    const batch: ChainedEvent[] = [];
    for (const row of pending) {
      if (batch.length >= limit) break;
      if (batch.length > 0 && row.event.seq !== batch[batch.length - 1].event.seq + 1) break;
      batch.push({ event: row.event, prevHash: row.prevHash, hash: row.hash });
    }
    return batch;
  }

  async markSynced(sessionId: string, counterId: string, throughSeq: number): Promise<void> {
    for (const row of this.mine(sessionId, counterId)) {
      if (row.event.seq <= throughSeq && row.sync === 'pendiente') row.sync = 'confirmado';
    }
  }

  async resetFrom(sessionId: string, counterId: string, fromSeq: number): Promise<void> {
    for (const row of this.mine(sessionId, counterId)) {
      if (row.event.seq >= fromSeq && row.sync === 'confirmado') row.sync = 'pendiente';
    }
  }

  async markRejected(sessionId: string, counterId: string): Promise<void> {
    for (const row of this.mine(sessionId, counterId)) {
      if (row.sync === 'pendiente') row.sync = 'rechazado_sesion_sellada';
    }
  }

  async rejected(sessionId: string, counterId: string): Promise<ChainedEvent[]> {
    return this.mine(sessionId, counterId)
      .filter((row) => row.sync === 'rechazado_sesion_sellada')
      .map((row) => ({ event: row.event, prevHash: row.prevHash, hash: row.hash }));
  }

  async pendingOutboxes(): Promise<PendingOutbox[]> {
    const counts = new Map<string, PendingOutbox>();
    for (const row of this.rows.values()) {
      if (row.sync !== 'pendiente') continue;
      const counterId = row.event.counterId;
      if (counterId === undefined) continue;
      const key = `${row.event.sessionId} ${counterId}`;
      const held = counts.get(key);
      if (held) held.pendientes++;
      else counts.set(key, { sessionId: row.event.sessionId, counterId, pendientes: 1 });
    }
    return [...counts.values()].sort((a, b) =>
      a.counterId < b.counterId ? -1 : a.counterId > b.counterId ? 1 : 0,
    );
  }

  /** Test-only view: every stored row with its flag. */
  all(sessionId: string, counterId: string): (ChainedEvent & { sync: SyncState })[] {
    return this.mine(sessionId, counterId).map((row) => ({ ...row }));
  }
}
