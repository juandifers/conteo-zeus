/**
 * IndexedDB schema (Dexie).
 *
 * The adapter side of the port defined in src/domain/repository.ts. Nothing
 * here is imported by the domain; the arrow points this way only.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { CountEvent, ExportRecord, Item } from '../domain';

/** A session without its items — the items live in their own table. */
export interface SessionRow {
  id: string;
  bodega: string;
  fechaCorte: string;
  sourceHash: string;
  createdAt: string;
  itemCount: number;
  /** The imported file's name. The bytes are in `sources`. */
  sourceName?: string;
}

/**
 * The imported file, kept whole and kept out of the session row.
 *
 * Its own table because it is the one large value in the database and the one
 * nothing reads until somebody posts: a session list that carried sixty
 * kilobytes per row would read every byte of every file to draw a list of
 * names. Written in the same transaction as the session, so a session either
 * has its file or does not exist.
 */
export interface SourceRow {
  sessionId: string;
  name: string;
  bytes: Uint8Array;
}

/**
 * A session's frozen items.
 *
 * `ord` is the item's position in the source file, kept because IndexedDB
 * returns rows in key order — without it, reading a session back would silently
 * re-sort it by `idarticulo`, and the count sheet would no longer match the
 * order the file (and the shelf) is in.
 */
export interface ItemRow extends Item {
  sessionId: string;
  ord: number;
}

export type EventRow = CountEvent;

/**
 * This install's identity. Exactly one row, keyed on a constant.
 *
 * Lives here rather than in `localStorage` because both fields are load-bearing
 * for the fold (DOMAIN.md §6). `deviceId` is a tie-break key, so an id that
 * regenerated on a cleared storage bucket would silently reorder this tablet's
 * own history against itself. `lastSeq` is the watermark that lets a reload
 * resume sequence numbers **without** having the whole log in memory — it is
 * advanced inside the same transaction that writes an event, so it cannot fall
 * behind what was actually stored.
 */
export interface DeviceRow {
  /** Always `DEVICE_KEY`. One row, and the schema says so. */
  key: string;
  deviceId: string;
  /** The next unused `seq` for this device. */
  lastSeq: number;
}

/** One generated adjustment file (DOMAIN.md §4). Append-only, like events. */
export type ExportRow = ExportRecord;

export const DEVICE_KEY = 'this';

export class ConteoDb extends Dexie {
  sessions!: EntityTable<SessionRow, 'id'>;
  items!: EntityTable<ItemRow, 'sessionId'>;
  countEvents!: EntityTable<EventRow, 'id'>;
  device!: EntityTable<DeviceRow, 'key'>;
  sources!: EntityTable<SourceRow, 'sessionId'>;
  exports!: EntityTable<ExportRow, 'id'>;

  constructor(name = 'conteo-zeus') {
    super(name);
    this.version(1).stores({
      sessions: 'id, createdAt, bodega',
      // Compound primary key: one row per item per session, and a re-import
      // cannot collide with the session it is replacing.
      items: '[sessionId+idarticulo], sessionId',
      // [sessionId+idarticulo] is the index the fold reads: resolving one item
      // touches only that item's events, never the session's whole log.
      countEvents: 'id, sessionId, [sessionId+idarticulo]',
    });
    // v2 adds the device row. A new version rather than an edit to v1: a
    // browser that already opened v1 must migrate, not fail to open.
    this.version(2).stores({
      device: 'key',
    });
    // v3 indexes one device's own numbering, so `appendEvent` can reject a
    // reissued seq without scanning the session's log (DOMAIN.md §3). The full
    // index list is restated because a version declaration replaces it.
    this.version(3).stores({
      countEvents:
        'id, sessionId, [sessionId+idarticulo], [sessionId+deviceId+seq]',
    });
    // v4 closes the loop: the file a session came from, and a record of every
    // file generated out of it (DOMAIN.md §4). Sessions imported under v1-v3
    // simply have no source row, and the review screen says so rather than
    // failing at the moment somebody presses the button.
    this.version(4).stores({
      sources: 'sessionId',
      exports: 'id, sessionId, at',
    });
  }
}
