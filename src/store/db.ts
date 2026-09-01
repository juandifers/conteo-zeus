/**
 * IndexedDB schema (Dexie).
 *
 * The adapter side of the port defined in src/domain/repository.ts. Nothing
 * here is imported by the domain; the arrow points this way only.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { CountEvent, CounterPayload, ExportRecord, Item, SyncState } from '../domain';

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

/**
 * An event, plus where it sits in its counter's chain and whether it has been
 * pushed (P2.2 §1a).
 *
 * **One table, not two.** The outbox is `sync === 'pendiente'` — a query over
 * this store — rather than a second copy of the event somewhere else. Two
 * tables that can disagree about what happened is the failure this whole
 * architecture is built to avoid, and an outbox is exactly the shape that
 * disagreement takes: a queue holding an event the log does not have, or a log
 * holding an event the queue forgot to enqueue.
 *
 * All three fields are optional because P1 rows do not have them. Those events
 * carry no `counterId`, cannot be hashed (`canonicalEvent` refuses rather than
 * inventing one) and are never pushed anywhere; they stay local, read-only and
 * unchained (docs/MIGRATION-P1-P2.md). A P1 row is therefore absent from both
 * compound indexes below, which is what we want — Dexie skips a row whose index
 * key is undefined.
 */
export type EventRow = CountEvent & {
  /** The chain hash of the link before this one. */
  prevHash?: string;
  /** `chainHash(prevHash, event)` — computed on the device, re-checked on arrival. */
  hash?: string;
  sync?: SyncState;
};

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

/**
 * What a counter's tablet pulled from `GET /api/c/:token`, kept whole.
 *
 * Stored **verbatim**, exactly as it came off the wire, and not unpacked into
 * the tables above. Three reasons, in order of how much they matter:
 *
 *   - The tablet is loaded on office wifi and then walks into a bodega with no
 *     signal. Whatever is not in this row is not available again, so the row
 *     has to be the whole response rather than a projection somebody chose.
 *   - `sessions` and `items` are P1's shape and carry `existencia` and `costo`.
 *     Unpacking a counter's assignment into them would give those columns a
 *     place to exist on a counting device, and DOMAIN.md §2.1 is that they
 *     must not — the server's allowlist is the guarantee, and it is only a
 *     guarantee if nothing downstream re-inflates the missing fields.
 *   - "What the device holds is exactly what the server sent" is a property a
 *     test can state in one line.
 */
export interface CounterAssignmentRow {
  /** The token the link carried. One row per counter link on this device. */
  token: string;
  sessionId: string;
  counterId: string;
  /** When this device fetched, normalised UTC. Shown as «descargado». */
  fetchedAt: string;
  payload: CounterPayload;
}

export const DEVICE_KEY = 'this';

export class ConteoDb extends Dexie {
  sessions!: EntityTable<SessionRow, 'id'>;
  items!: EntityTable<ItemRow, 'sessionId'>;
  countEvents!: EntityTable<EventRow, 'id'>;
  device!: EntityTable<DeviceRow, 'key'>;
  sources!: EntityTable<SourceRow, 'sessionId'>;
  exports!: EntityTable<ExportRow, 'id'>;
  counterAssignments!: EntityTable<CounterAssignmentRow, 'token'>;

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

    // v5 is the counter's own assignment, downloaded once on office wifi and
    // read from there onwards with no network (P2.1 §4c). A new table and
    // nothing else: no existing store is touched, so a tablet holding an
    // unposted P1 count opens v5 with that count intact.
    this.version(5).stores({
      counterAssignments: 'token, sessionId, counterId',
    });

    // v6 is the outbox (P2.2 §1a). No new table and no reshaping: three
    // optional fields on `countEvents` and two compound indexes over them.
    //
    //   `[sessionId+counterId+seq]` is the chain's own order. P1 indexed
    //   `[sessionId+deviceId+seq]` because a P1 session is one device; a P2
    //   counter's numbering follows the *counter*, across the spare tablet
    //   somebody picks up when the first one dies mid-shift.
    //
    //   `[sessionId+counterId+sync]` is the outbox query. Draining reads it,
    //   ascending, and pushes what it finds.
    //
    // The v3 index list is restated in full because a version declaration
    // replaces it rather than adding to it.
    this.version(6).stores({
      countEvents:
        'id, sessionId, [sessionId+idarticulo], [sessionId+deviceId+seq], ' +
        '[sessionId+counterId+seq], [sessionId+counterId+sync]',
    });

    // ---- before adding v7 -------------------------------------------------
    //
    // From the pilot onwards this database is not empty when a new version
    // arrives. Tablets in the field hold counts that have not been posted, and
    // a count that has not been posted exists nowhere else — there is no
    // backend and no sync, so a migration that drops a table drops the only
    // copy of somebody's afternoon.
    //
    // So:
    //
    //   - Never delete or rewrite a store in a migration during a pilot. Add
    //     tables and add indexes; both are non-destructive, and a session
    //     written by an older version simply lacks the new field, which is how
    //     v4 and v6 above are already handled.
    //   - Verify against a *populated* profile, not a fresh one. An upgrade
    //     path only has bugs when there is data to move; opening v5 on an
    //     empty database proves nothing, which is why v3's index change was
    //     checked against a profile that already held a session and its log.
    //   - Never renumber or edit a version that has shipped. Dexie replays
    //     them in order from whatever the browser has, so an edited v3 runs on
    //     tablets that already ran the old one, and does not run on tablets
    //     that skipped it.
  }
}
