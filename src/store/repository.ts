/**
 * Dexie implementation of `CountRepository`.
 *
 * The domain defines the port; this satisfies it. Domain tests run against
 * `MemoryRepository` and never touch IndexedDB — that both implementations
 * pass the same contract test is the point of the split.
 */
import type {
  CountEvent,
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
import { ConteoDb, DEVICE_KEY, type ItemRow } from './db';

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
        if (sameEvent(existing, event)) return;
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
    return this.db.countEvents.where('[sessionId+idarticulo]').equals([sessionId, idarticulo]).toArray();
  }

  async eventsForSession(sessionId: string): Promise<CountEvent[]> {
    return this.db.countEvents.where('sessionId').equals(sessionId).toArray();
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
