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
  assertNormalisedInstant(event.at, `event ${event.id} (idarticulo ${event.idarticulo})`);
}

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
