/**
 * Dexie implementation of `CountRepository`.
 *
 * The domain defines the port; this satisfies it. Domain tests run against
 * `MemoryRepository` and never touch IndexedDB — that both implementations
 * pass the same contract test is the point of the split.
 */
import Dexie from 'dexie';
import type {
  ChainedEvent,
  CountEvent,
  CounterChainRepository,
  CountRepository,
  DeviceIdentity,
  DeviceRepository,
  ExportRecord,
  ExportRepository,
  Item,
  Session,
  SessionMeta,
} from '../domain';
import {
  EventConflictError,
  SequenceConflictError,
  sameEvent,
  validateEvent,
} from '../domain';
import { ConteoDb, DEVICE_KEY, type EventRow, type ItemRow } from './db';

/**
 * A stored row back as a plain `CountEvent`.
 *
 * The chain metadata is *ours*: it describes where the event sits on the way to
 * the server, not what the counter did. It must not reach the fold, and above
 * all it must not reach `sameEvent`, whose whole job is to answer "is this the
 * same event" by comparing the two as JSON — a stored row carrying `sync:
 * 'confirmado'` would never equal the event a replay hands back, and an
 * idempotent append would start throwing `EventConflictError` on its second
 * attempt.
 */
function toEvent(row: EventRow): CountEvent {
  const { prevHash: _prevHash, hash: _hash, sync: _sync, ...event } = row;
  return event as CountEvent;
}

function toItem(row: ItemRow): Item {
  return {
    idarticulo: row.idarticulo,
    codigo: row.codigo,
    nombre: row.nombre,
    presentacion: row.presentacion,
    existencia: row.existencia,
    ultimoConteo: row.ultimoConteo,
    costo: row.costo,
  };
}

export class DexieCountRepository
  implements CountRepository, DeviceRepository, ExportRepository
{
  readonly db: ConteoDb;

  constructor(db: ConteoDb = new ConteoDb()) {
    this.db = db;
  }

  /**
   * This install's `deviceId` and the first `seq` it has not used.
   *
   * Written once, on first run, and read on every boot thereafter. Both fields
   * were in `localStorage` until DOMAIN.md §6 moved them: the fold breaks ties
   * on `deviceId`, so an id a cleared storage bucket could regenerate would
   * silently reorder this tablet's own history, and `seq` resumption must not
   * depend on the whole log being in memory.
   */
  async identify(): Promise<DeviceIdentity> {
    return this.db.transaction('rw', this.db.device, async () => {
      const existing = await this.db.device.get(DEVICE_KEY);
      if (existing) return { deviceId: existing.deviceId, nextSeq: existing.lastSeq };
      const fresh = { key: DEVICE_KEY, deviceId: crypto.randomUUID(), lastSeq: 0 };
      await this.db.device.add(fresh);
      return { deviceId: fresh.deviceId, nextSeq: fresh.lastSeq };
    });
  }

  /**
   * Persist a session, its items and the file it came from, atomically.
   *
   * The source goes in with the rest rather than in a follow-up write: a
   * session that exists without its file can never generate an adjustment, and
   * a half-written import is exactly the state nobody would think to check for.
   */
  async createSession(session: Session): Promise<void> {
    const { items, source, ...meta } = session;
    await this.db.transaction(
      'rw',
      this.db.sessions,
      this.db.items,
      this.db.sources,
      async () => {
        if (await this.db.sessions.get(session.id)) {
          throw new Error(
            `session ${session.id} already exists; a re-import creates a new session ` +
              'rather than mutating one',
          );
        }
        await this.db.sessions.add({
          ...meta,
          itemCount: items.length,
          ...(source ? { sourceName: source.name } : {}),
        });
        await this.db.items.bulkAdd(
          items.map((item, ord) => ({ ...item, sessionId: session.id, ord })),
        );
        if (source) {
          await this.db.sources.add({
            sessionId: session.id,
            name: source.name,
            bytes: source.bytes,
          });
        }
      },
    );
  }

  async getSession(id: string): Promise<Session | undefined> {
    const meta = await this.db.sessions.get(id);
    if (!meta) return undefined;
    const { itemCount: _itemCount, sourceName: _sourceName, ...rest } = meta;
    const source = await this.db.sources.get(id);
    return {
      ...rest,
      ...(source ? { source: { name: source.name, bytes: source.bytes } } : {}),
      items: Object.freeze(await this.itemsForSession(id)),
    };
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.db.sessions.orderBy('createdAt').toArray();
  }

  async itemsForSession(sessionId: string): Promise<Item[]> {
    const rows = await this.db.items.where('sessionId').equals(sessionId).toArray();
    // Restore file order; IndexedDB hands them back in key order (§ see db.ts).
    rows.sort((a, b) => a.ord - b.ord);
    return rows.map(toItem);
  }

  /**
   * The only write path for events (DOMAIN.md §3). Idempotent by id, so a merge
   * that re-delivers an event it already has is a no-op; re-using an id for
   * different content is rejected rather than treated as an edit.
   */
  async appendEvent(event: CountEvent): Promise<void> {
    validateEvent(event);
    await this.db.transaction('rw', this.db.countEvents, this.db.device, async () => {
      const existing = await this.db.countEvents.get(event.id);
      if (existing) {
        if (sameEvent(toEvent(existing), event)) return;
        throw new EventConflictError(event.id);
      }
      // One device, one sequence number. A collision here is an allocator bug,
      // and leaving it in would hand the fold's `id` tie-break — a dedupe
      // guard, not a decision mechanism — the choice between an item posting
      // and an item blocking the post (DOMAIN.md §3).
      const slot = await this.db.countEvents
        .where('[sessionId+deviceId+seq]')
        .equals([event.sessionId, event.deviceId, event.seq])
        .first();
      if (slot) throw new SequenceConflictError(event, slot.id);

      await this.db.countEvents.add(event);
      // Same transaction, deliberately (DOMAIN.md §6). The watermark can then
      // never sit below a `seq` that was actually written, whatever happens
      // between here and the next boot — a tab closed mid-flush, a crash, a
      // battery. A separate transaction would leave exactly the window in
      // which a reload reissues a number the log already holds.
      const device = await this.db.device.get(DEVICE_KEY);
      if (device && device.deviceId === event.deviceId && device.lastSeq <= event.seq) {
        await this.db.device.update(DEVICE_KEY, { lastSeq: event.seq + 1 });
      }
    });
  }

  async eventsForItem(sessionId: string, idarticulo: number): Promise<CountEvent[]> {
    const rows = await this.db.countEvents
      .where('[sessionId+idarticulo]')
      .equals([sessionId, idarticulo])
      .toArray();
    return rows.map(toEvent);
  }

  async eventsForSession(sessionId: string): Promise<CountEvent[]> {
    const rows = await this.db.countEvents.where('sessionId').equals(sessionId).toArray();
    return rows.map(toEvent);
  }

  /**
   * Record that a file was generated (DOMAIN.md §4).
   *
   * `add`, not `put`: an export record is a statement about bytes that already
   * exist, so overwriting one would be rewriting history about a file the ERP
   * may already have received.
   */
  async recordExport(record: ExportRecord): Promise<void> {
    await this.db.exports.add(record);
  }

  async exportsForSession(sessionId: string): Promise<ExportRecord[]> {
    return this.db.exports.where('sessionId').equals(sessionId).toArray();
  }
}


/**
 * Dexie implementation of `CounterChainRepository` — the device's outbox.
 *
 * Same database, same `countEvents` table. A separate class rather than more
 * methods on the one above because the two answer different questions and the
 * P1 app must not acquire a sync surface it has no use for; sharing the table
 * is the whole point, and sharing it through one store is what makes the outbox
 * a projection rather than a copy.
 */
export class DexieCounterChain implements CounterChainRepository {
  readonly db: ConteoDb;

  constructor(db: ConteoDb = new ConteoDb()) {
    this.db = db;
  }

  /**
   * The event, its chain metadata and its `pendiente` flag, in one transaction.
   *
   * Idempotent by id like `appendEvent`, and for the same reason: a drain that
   * re-delivers, or a retry after a write whose acknowledgement was lost, must
   * be a no-op rather than a conflict. The comparison is over the event only —
   * the flag moves under it as the push protocol progresses, and a row whose
   * flag has advanced is still the same event.
   */
  async appendChained(link: ChainedEvent): Promise<void> {
    const { event, prevHash, hash } = link;
    validateEvent(event);
    if (!event.counterId) {
      throw new Error(
        `event ${event.id} has no counterId and so has no chain to be appended to; ` +
          'P1 events stay local, read-only and unchained (docs/MIGRATION-P1-P2.md)',
      );
    }
    await this.db.transaction('rw', this.db.countEvents, async () => {
      const existing = await this.db.countEvents.get(event.id);
      if (existing) {
        if (sameEvent(toEvent(existing), event)) return;
        throw new EventConflictError(event.id);
      }
      const slot = await this.db.countEvents
        .where('[sessionId+counterId+seq]')
        .equals([event.sessionId, event.counterId!, event.seq])
        .first();
      if (slot) throw new SequenceConflictError(event, slot.id);

      await this.db.countEvents.add({ ...event, prevHash, hash, sync: 'pendiente' });
    });
  }

  async localChain(
    sessionId: string,
    counterId: string,
  ): Promise<{ maxSeq: number; head: string } | null> {
    const last = await this.db.countEvents
      .where('[sessionId+counterId+seq]')
      .between([sessionId, counterId, Dexie.minKey], [sessionId, counterId, Dexie.maxKey])
      .last();
    if (!last || last.hash === undefined) return null;
    return { maxSeq: last.seq, head: last.hash };
  }

  /**
   * The outbox, ascending and **contiguous**.
   *
   * Contiguity is enforced here rather than assumed: the server refuses a batch
   * with a hole in it as a gap, and a drain that shipped one would spend the
   * afternoon being told `SEQUENCE_GAP` by a server that was right. A hole can
   * only appear if an append failed between two that succeeded, which the store
   * halts on — so this truncating is a belt on top of that, and it truncates
   * rather than throwing because shipping the prefix is strictly better than
   * shipping nothing.
   */
  async unsynced(sessionId: string, counterId: string, limit: number): Promise<ChainedEvent[]> {
    const rows = await this.db.countEvents
      .where('[sessionId+counterId+sync]')
      .equals([sessionId, counterId, 'pendiente'])
      .toArray();
    rows.sort((a, b) => a.seq - b.seq);

    const batch: ChainedEvent[] = [];
    for (const row of rows) {
      if (batch.length >= limit) break;
      if (row.hash === undefined || row.prevHash === undefined) break;
      if (batch.length > 0 && row.seq !== batch[batch.length - 1].event.seq + 1) break;
      batch.push({ event: toEvent(row), prevHash: row.prevHash, hash: row.hash });
    }
    return batch;
  }

  /**
   * Move everything up to `throughSeq` out of the outbox.
   *
   * Called **only** on a definite ack naming the range the server accepted. A
   * timeout, a 5xx or an aborted request never reaches here: over-delivery is
   * free — events are immutable and keyed by a device-generated uuid, so a
   * replay is a no-op on both sides — and under-delivery is a lost morning of
   * counting.
   */
  async markSynced(sessionId: string, counterId: string, throughSeq: number): Promise<void> {
    await this.db.transaction('rw', this.db.countEvents, async () => {
      const rows = await this.db.countEvents
        .where('[sessionId+counterId+seq]')
        .between([sessionId, counterId, Dexie.minKey], [sessionId, counterId, throughSeq], true, true)
        .toArray();
      for (const row of rows) {
        if (row.sync === 'pendiente') await this.db.countEvents.update(row.id, { sync: 'confirmado' });
      }
    });
  }

  /** Put everything from `fromSeq` on back into the outbox — the answer to a gap. */
  async resetFrom(sessionId: string, counterId: string, fromSeq: number): Promise<void> {
    await this.db.transaction('rw', this.db.countEvents, async () => {
      const rows = await this.db.countEvents
        .where('[sessionId+counterId+seq]')
        .between([sessionId, counterId, fromSeq], [sessionId, counterId, Dexie.maxKey], true, true)
        .toArray();
      for (const row of rows) {
        if (row.sync === 'confirmado') {
          await this.db.countEvents.update(row.id, { sync: 'pendiente' });
        }
      }
    });
  }

  /**
   * The session was sealed before these arrived (P2.2 §1d).
   *
   * They are flagged, never deleted. The counter's work exists; it did not make
   * it into the file, and the admin needs to know — which is a different thing
   * from the counter having done nothing, and the difference has to survive on
   * the device long enough for somebody to export it.
   */
  async markRejected(sessionId: string, counterId: string): Promise<void> {
    await this.db.transaction('rw', this.db.countEvents, async () => {
      const rows = await this.db.countEvents
        .where('[sessionId+counterId+sync]')
        .equals([sessionId, counterId, 'pendiente'])
        .toArray();
      for (const row of rows) {
        await this.db.countEvents.update(row.id, { sync: 'rechazado_sesion_sellada' });
      }
    });
  }

  async rejected(sessionId: string, counterId: string): Promise<ChainedEvent[]> {
    const rows = await this.db.countEvents
      .where('[sessionId+counterId+sync]')
      .equals([sessionId, counterId, 'rechazado_sesion_sellada'])
      .toArray();
    rows.sort((a, b) => a.seq - b.seq);
    return rows.map((row) => ({
      event: toEvent(row),
      prevHash: row.prevHash ?? '',
      hash: row.hash ?? '',
    }));
  }
}
