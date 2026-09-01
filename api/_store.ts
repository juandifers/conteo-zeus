/**
 * Everything `api/` reads from and writes to Postgres, in one file.
 *
 * The handlers hold the decisions; this holds the SQL. Two reasons for the
 * split beyond tidiness:
 *
 *   - **The server never reads `raw_row`.** It selects it, hands it back and
 *     stores it, and nothing in `api/` indexes into it. That is the property
 *     `raw_row text[]` exists for: `writeTxt` re-emits 22 columns from those
 *     strings, and a serverless function that knew what field 4 was would be a
 *     third place the file format lives (ZEUS_FORMAT.md §5, §8).
 *   - **Every quantity crosses as text.** `existencia`, `costo` and
 *     `ultimo_conteo` are `numeric` and are selected `::text`, because a driver
 *     that renders `numeric` through a float is a driver that changes the
 *     number. They are display and ranking figures only — never a posting
 *     input — but "never a posting input" is not a reason to let them drift.
 */
import { eventFromRow, type CountEvent, type EventWire, type Item } from '../src/domain/index.js';
import type { CatalogueRowWire } from '../src/app/index.js';
import { fromBase64, toBase64 } from '../src/lib/base64.js';
import type { Db, Row, Statement } from './_db.js';

/** A session as the database holds it, before anything is derived from it. */
export interface SessionRow {
  id: string;
  bodega: string;
  fechaCorte: string;
  nombre: string | null;
  estado: string;
  countTargetColumn: string;
  uncountedPolicy: string;
  differenceColumn: string;
  mostrarMarcaRegistrado: boolean;
  sourceName: string | null;
  sourceHash: string;
  createdAt: string;
  dispatchedAt: string | null;
  itemCount: number;
  /** Optimistic concurrency over the partition (P2.3.5 §7). Zero until the first change. */
  assignmentsVersion: number;
  /** P2.5. Null until the seal; set in the same transaction as `estado = 'sellado'`. */
  sealedAt: string | null;
  sessionHash: string | null;
  /** Null until the export; set with `estado = 'cerrado'` and `export_bytes`. */
  exportedAt: string | null;
  fileHash: string | null;
}

/**
 * A `timestamptz`, as a normalised UTC ISO-8601 string.
 *
 * Two things this is not: it is not the driver's idea of a timestamp — `pg`
 * hands back a `Date` and the Neon HTTP driver hands back something else, and a
 * response whose shape depends on which driver the deploy used is a response no
 * test can pin down. And it is not `to_json`, which renders in whatever
 * `TimeZone` the connection happens to carry, so a server in Bogotá would
 * answer `2026-08-31T10:05:00-05:00` and one in CI would answer the same
 * instant differently.
 *
 * The shape is the one `INSTANT_PATTERN` accepts (DOMAIN.md §3), so a timestamp
 * from the database and an event's `at` are the same kind of string.
 */
function utc(column: string): string {
  return `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

const SESSION_COLUMNS = `
  id,
  bodega,
  fecha_corte                as "fechaCorte",
  nombre,
  estado,
  count_target_column        as "countTargetColumn",
  uncounted_policy           as "uncountedPolicy",
  difference_column          as "differenceColumn",
  mostrar_marca_registrado   as "mostrarMarcaRegistrado",
  source_name                as "sourceName",
  source_hash                as "sourceHash",
  ${utc('created_at')}    as "createdAt",
  ${utc('dispatched_at')} as "dispatchedAt",
  assignments_version     as "assignmentsVersion",
  ${utc('sealed_at')}     as "sealedAt",
  session_hash            as "sessionHash",
  ${utc('exported_at')}   as "exportedAt",
  file_hash               as "fileHash"
`;

export async function listSessionRows(db: Db): Promise<SessionRow[]> {
  return db.query<SessionRow>(`
    select ${SESSION_COLUMNS},
           (select count(*)::int from catalog_rows c where c.session_id = s.id) as "itemCount"
    from sessions s
    order by created_at desc
  `);
}

export async function loadSessionRow(db: Db, id: string): Promise<SessionRow | null> {
  const rows = await db.query<SessionRow>(
    `select ${SESSION_COLUMNS},
            (select count(*)::int from catalog_rows c where c.session_id = s.id) as "itemCount"
     from sessions s where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The imported bytes, back out again.
 *
 * `bytea` comes off the two drivers differently — `pg` gives a Buffer, the Neon
 * HTTP driver gives a `\x…` hex string — so both are normalised here rather
 * than in whichever handler happens to be first to notice.
 */
export async function loadSourceBytes(db: Db, id: string): Promise<Uint8Array | null> {
  const rows = await db.query<{ source_bytes: unknown }>(
    'select source_bytes from sessions where id = $1',
    [id],
  );
  const value = rows[0]?.source_bytes;
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  throw new Error(`source_bytes came back as ${typeof value}, which no driver should produce`);
}

export interface CatalogueRecord {
  item: Item;
  familia: string | null;
  rawRow: string[];
}

/**
 * The catalogue, in the order Zeus exported it.
 *
 * `order by ord` and never `order by idarticulo`: bodega 22's verified export
 * runs `91069` then `15450` (ZEUS_FORMAT.md §7.5), and a catalogue re-sorted by
 * its key stops matching the shelf and the printed list the counters hold.
 */
export async function loadCatalogue(db: Db, sessionId: string): Promise<CatalogueRecord[]> {
  const rows = await db.query<{
    idarticulo: number;
    codigo: string;
    nombre: string;
    presentacion: string;
    existencia: string;
    costo: string;
    ultimoConteo: string | null;
    familia: string | null;
    raw_row: string[];
  }>(
    `select idarticulo, codigo, nombre, presentacion,
            existencia::text    as existencia,
            costo::text         as costo,
            ultimo_conteo::text as "ultimoConteo",
            familia, raw_row
     from catalog_rows where session_id = $1 order by ord`,
    [sessionId],
  );
  return rows.map((row) => ({
    item: {
      idarticulo: row.idarticulo,
      codigo: row.codigo,
      nombre: row.nombre,
      presentacion: row.presentacion,
      existencia: Number(row.existencia),
      costo: Number(row.costo),
      ultimoConteo: row.ultimoConteo === null ? null : Number(row.ultimoConteo),
    },
    familia: row.familia,
    rawRow: row.raw_row,
  }));
}

/**
 * Just the keys, in catalogue order.
 *
 * `loadCatalogue` drags 298 `raw_row` arrays across the wire and every
 * coverage question needs nothing but the primary key. Reassignment asks that
 * question on every request, so it asks it cheaply.
 */
export async function loadCatalogueIds(db: Db, sessionId: string): Promise<number[]> {
  const rows = await db.query<{ idarticulo: number }>(
    'select idarticulo from catalog_rows where session_id = $1 order by ord',
    [sessionId],
  );
  return rows.map((row) => row.idarticulo);
}

export interface CounterRow {
  id: string;
  nombre: string;
  token: string;
  estado: string;
  fetchedAt: string | null;
  fetchCount: number;
  /** The device bound on first push, or `null` before there was one (P2.2 §3a). */
  deviceId: string | null;
  /**
   * When the server last accepted anything from them, or `null`.
   *
   * On the reassignment screen (P2.3.5 §4b), because handing a counter's shelves
   * to somebody else while their tablet has been silent for an hour is the one
   * decision in this system that can produce a double count nothing can prevent.
   */
  lastServerAt: string | null;
}

export async function loadCounters(db: Db, sessionId: string): Promise<CounterRow[]> {
  return db.query<CounterRow>(
    `select id, nombre, token, estado,
            ${utc('fetched_at')}     as "fetchedAt",
            fetch_count as "fetchCount",
            device_id   as "deviceId",
            ${utc('last_server_at')} as "lastServerAt"
     from counters where session_id = $1 order by created_at, nombre`,
    [sessionId],
  );
}

export interface SectionRow {
  id: string;
  nombre: string;
  counterId: string | null;
}

export async function loadSections(db: Db, sessionId: string): Promise<SectionRow[]> {
  return db.query<SectionRow>(
    `select id, nombre, counter_id as "counterId"
     from sections where session_id = $1 order by created_at, nombre`,
    [sessionId],
  );
}

export interface AssignmentRow {
  idarticulo: number;
  counterId: string;
  sectionId: string;
}

export async function loadAssignments(db: Db, sessionId: string): Promise<AssignmentRow[]> {
  return db.query<AssignmentRow>(
    `select idarticulo, counter_id as "counterId", section_id as "sectionId"
     from assignments where session_id = $1 order by idarticulo`,
    [sessionId],
  );
}

/** A counter, found by the token in their link. `null` for a token nobody holds. */
export async function findByToken(
  db: Db,
  token: string,
): Promise<{ counter: CounterRow; sessionId: string } | null> {
  const rows = await db.query<CounterRow & { sessionId: string }>(
    `select id, nombre, token, estado,
            ${utc('fetched_at')}     as "fetchedAt",
            fetch_count as "fetchCount",
            device_id   as "deviceId",
            ${utc('last_server_at')} as "lastServerAt",
            session_id  as "sessionId"
     from counters where token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  const { sessionId, ...counter } = row;
  return { counter, sessionId };
}

/**
 * Note that a device pulled its assignment.
 *
 * Both columns: the timestamp says a device fetched, the count says *this* one
 * is the third that did — which is what a shared tablet handed round the office
 * looks like, and is worth being able to see on the dispatch screen.
 */
export async function recordFetch(db: Db, counterId: string, at: string): Promise<void> {
  await db.query(
    'update counters set fetched_at = $2, fetch_count = fetch_count + 1 where id = $1',
    [counterId, at],
  );
}

export interface NewSession {
  id: string;
  bodega: string;
  fechaCorte: string;
  nombre: string | null;
  sourceName: string | null;
  sourceHash: string;
  sourceBytes: Uint8Array;
  countTargetColumn: string;
  uncountedPolicy: string;
  differenceColumn: string;
  mostrarMarcaRegistrado: boolean;
}

/**
 * The session and its whole catalogue, in one transaction.
 *
 * All of it or none of it: a session row with half a catalogue under it is a
 * session somebody can open, assign and dispatch, missing the shelves whose
 * insert failed.
 *
 * The rows go over as one JSON document rather than 298 statements. `numeric`
 * columns are fed from **text** and cast in SQL, so no quantity is ever a
 * JavaScript float on this path, and `raw_row` is rebuilt with
 * `with ordinality` rather than by letting an aggregate choose an order — the
 * 24 fields are positional and an array in the wrong order is a sheared file.
 */
export function insertSessionStatements(
  session: NewSession,
  rows: readonly CatalogueRowWire[],
  familia: (row: CatalogueRowWire) => string | null,
): Statement[] {
  const catalogue = rows.map((row, ord) => ({
    ord,
    idarticulo: row.idarticulo,
    codigo: row.codigo,
    nombre: row.nombre,
    presentacion: row.presentacion,
    existencia: row.existencia,
    costo: row.costo,
    ultimo_conteo: row.ultimoConteo,
    familia: familia(row),
    raw_row: row.rawRow,
  }));

  return [
    {
      text: `insert into sessions (
               id, bodega, fecha_corte, nombre, estado,
               count_target_column, uncounted_policy, difference_column,
               mostrar_marca_registrado, source_name, source_hash, source_bytes)
             values ($1, $2, $3, $4, 'borrador', $5, $6, $7, $8, $9, $10, decode($11, 'base64'))`,
      params: [
        session.id,
        session.bodega,
        session.fechaCorte,
        session.nombre,
        session.countTargetColumn,
        session.uncountedPolicy,
        session.differenceColumn,
        session.mostrarMarcaRegistrado,
        session.sourceName,
        session.sourceHash,
        toBase64(session.sourceBytes),
      ],
    },
    {
      text: `insert into catalog_rows
               (session_id, ord, idarticulo, codigo, nombre, presentacion,
                existencia, costo, ultimo_conteo, familia, raw_row)
             select $1::uuid, r.ord, r.idarticulo, r.codigo, r.nombre, r.presentacion,
                    r.existencia::numeric, r.costo::numeric, r.ultimo_conteo::numeric, r.familia,
                    (select array_agg(v order by o)
                       from jsonb_array_elements_text(r.raw_row) with ordinality as t(v, o))
             from jsonb_to_recordset($2::jsonb) as r(
               ord int, idarticulo int, codigo text, nombre text, presentacion text,
               existencia text, costo text, ultimo_conteo text, familia text, raw_row jsonb)`,
      params: [session.id, JSON.stringify(catalogue)],
    },
  ];
}

export interface DispatchPlan {
  counters: { id: string; nombre: string; token: string }[];
  sections: { id: string; nombre: string; counterId: string }[];
  assignments: { idarticulo: number; counterId: string; sectionId: string }[];
}

/**
 * Replace a draft's whole partition and open the session, in one transaction.
 *
 * The delete first is what makes dispatching a draft twice safe: the admin who
 * pressed the button, saw a blocker they had already fixed in another tab, and
 * pressed it again gets one set of counters rather than two.
 *
 * **Every statement is guarded on the session still being a `borrador`, and the
 * first one takes the row lock.** That is not belt and braces over the handler's
 * own check — it is the only thing standing between two admins on two laptops
 * and a session dispatched twice. Without the lock, both read `borrador`, both
 * write their counters, and the second `update … where estado = 'borrador'`
 * simply matches nothing: no error, so the transaction commits, and the loser's
 * counters are sitting in the database under the winner's session with tokens
 * nobody printed.
 *
 * With it, the second transaction blocks on `for update` before it has written
 * anything; when it wakes the row is `abierto`, the lock is not granted, every
 * guard below reads `abierto`, and the whole batch is a sequence of no-ops that
 * commits nothing. The handler sees an empty result from the final statement
 * and says so.
 *
 * The alternative — an interactive transaction that reads, branches and rolls
 * back — needs a session held open across statements, which is the one thing
 * Neon's HTTP protocol does not give a serverless function.
 */
export function dispatchStatements(
  sessionId: string,
  plan: DispatchPlan,
  at: string,
): Statement[] {
  /** Appended to every write below. Cheap: the row is already locked and in cache. */
  const draft = `(select estado from sessions where id = $1) = 'borrador'`;

  return [
    // The lock, and nothing else. Anything written before this point could be
    // written by a transaction that is about to lose.
    { text: `select id from sessions where id = $1 and estado = 'borrador' for update`, params: [sessionId] },
    // `assignments` and `sections` fall with the counters they hang off, by
    // cascade. Named here anyway rather than relied on: a cascade is a property
    // of the schema and this is a statement about what the handler intends.
    { text: `delete from assignments where session_id = $1 and ${draft}`, params: [sessionId] },
    { text: `delete from sections    where session_id = $1 and ${draft}`, params: [sessionId] },
    { text: `delete from counters    where session_id = $1 and ${draft}`, params: [sessionId] },
    {
      text: `insert into counters (id, session_id, nombre, token, estado)
             select r.id::uuid, $1::uuid, r.nombre, r.token, 'asignado'
             from jsonb_to_recordset($2::jsonb) as r(id text, nombre text, token text)
             where ${draft}`,
      params: [sessionId, JSON.stringify(plan.counters)],
    },
    {
      text: `insert into sections (id, session_id, nombre, counter_id)
             select r.id::uuid, $1::uuid, r.nombre, r.counter_id::uuid
             from jsonb_to_recordset($2::jsonb) as r(id text, nombre text, counter_id text)
             where ${draft}`,
      params: [
        sessionId,
        JSON.stringify(
          plan.sections.map((s) => ({ id: s.id, nombre: s.nombre, counter_id: s.counterId })),
        ),
      ],
    },
    {
      text: `insert into assignments (session_id, idarticulo, counter_id, section_id)
             select $1::uuid, r.idarticulo, r.counter_id::uuid, r.section_id::uuid
             from jsonb_to_recordset($2::jsonb) as r(idarticulo int, counter_id text, section_id text)
             where ${draft}`,
      params: [
        sessionId,
        JSON.stringify(
          plan.assignments.map((a) => ({
            idarticulo: a.idarticulo,
            counter_id: a.counterId,
            section_id: a.sectionId,
          })),
        ),
      ],
    },
    {
      // `borrador -> abierto` is the only transition P2.1 implements. An empty
      // result here means the guards above all declined, and the handler
      // answers 409 rather than reporting a dispatch that did not happen.
      text: `update sessions set estado = 'abierto', dispatched_at = $2
             where id = $1 and estado = 'borrador'
             returning id`,
      params: [sessionId, at],
    },
  ];
}

export { fromBase64, toBase64 };
export type { Row };

// --- P2.2: events, chains and device binding --------------------------------

/**
 * One stored event as the chain machinery reads it.
 *
 * Deliberately not the whole row: `deriveCounterEstado` and
 * `checkFinishManifest` need a position, a kind and two hashes, and handing
 * them the quantity as well would invite a future check to depend on it.
 */
export interface StoredEventRow {
  seq: number;
  kind: string;
  hash: string;
  prevHash: string;
  finalSeq: number | null;
  headHash: string | null;
}

export async function loadCounterChain(db: Db, counterId: string): Promise<StoredEventRow[]> {
  return db.query<StoredEventRow>(
    `select seq, kind, hash, prev_hash as "prevHash",
            final_seq as "finalSeq", head_hash as "headHash"
     from events where counter_id = $1 order by seq`,
    [counterId],
  );
}

/**
 * The latest `client_at` this counter's devices have stamped.
 *
 * Read by `/resume` and fed to a replacement tablet's clock watermark. The fold
 * orders by `at` before `deviceId` and `seq` (DOMAIN.md §3), so a spare tablet
 * whose clock runs behind the one it replaced would stamp events that sort
 * *before* the ones they follow — and for a counter's own article that is the
 * difference between an `unchanged` withdrawing a count and the count
 * overriding the waiver. Seeding the spare with this closes it: no device ever
 * stamps earlier than the counter has already been stamped.
 *
 * `max` over text, which is chronological because every `client_at` is a
 * normalised UTC instant of fixed width — the same guarantee the fold relies on
 * to compare these as strings at all.
 */
export async function lastClientAt(db: Db, counterId: string): Promise<string | null> {
  const rows = await db.query<{ at: string | null }>(
    'select max(client_at) as at from events where counter_id = $1',
    [counterId],
  );
  return rows[0]?.at ?? null;
}

/**
 * The event as it crosses the wire, both ways.
 *
 * `cantidad` is a **string** and stays one all the way to the `text` column
 * (see 0001): `21 - 20.8` is `0.20000000000000107` in IEEE754, the canonical
 * decimal string is what was hashed, and a `numeric` column a driver
 * round-trips through a float breaks the chain silently — which is
 * indistinguishable from a chain somebody tampered with.
 */
/**
 * The wire shape of one stored event, and the reader that turns it back into a
 * domain event, both from `src/domain/wire.ts`.
 *
 * They moved down into the domain in P2.4: the admin's review screen pulls
 * these rows through `GET /api/sessions/:id/events` and folds them in the
 * browser, and a second `eventFromRow` written in `src/ui/` would be a second
 * definition of what a stored `add` means. Re-exported here so every existing
 * caller in `api/` is unchanged.
 */
export type { EventWire };
export { eventFromRow };


/**
 * Insert a batch, guarded on the counter's chain being exactly where the handler
 * read it.
 *
 * All of them or none of them. Partial acceptance would leave the device
 * guessing which half landed, and the guess would be wrong exactly when it
 * matters — a tablet that concluded it had delivered 200 events when 60 arrived
 * would clear 140 out of its outbox.
 *
 * The guard is the same shape `dispatchStatements` uses and exists for the same
 * reason: the decision — replay, gap, fork or accept — is taken *outside* the
 * transaction, because Neon's HTTP protocol has no session to hold one open
 * across. Two devices pushing at once would both read `storedMax = 40`, both
 * decide their batch starts at 41, and the second would either violate
 * `unique (counter_id, seq)` — aborting a transaction that had already inserted
 * — or, worse, succeed against a chain that had moved. `for update` on the
 * counter row serialises them, and the predicate makes the loser's insert a
 * no-op it can detect and re-decide from.
 */
/**
 * Session states that still accept counter events.
 *
 * Here rather than in the handler because it is a **database** predicate: the
 * handler's copy (`OPEN_TO_PUSH`) decides what to tell the counter, and this one
 * decides what actually lands. They agree, and they are two different jobs.
 */
export const OPEN_TO_EVENTS = ['abierto', 'revision'];

export function insertEventsStatements(
  counterId: string,
  expectedMaxSeq: number,
  events: readonly EventWire[],
  counterUpdate: {
    /** The batch's last link, which is what the counter row is guarded on. */
    headSeq: number;
    chainHead: string;
    estado: string;
    finishReason: string | null;
    finalSeq: number | null;
    headHash: string | null;
    deviceId: string;
    clockSkewMs: number;
    serverAt: string;
  },
): Statement[] {
  /**
   * Nothing has been written yet: the chain is exactly where the handler read
   * it. Guards the insert.
   */
  const untouched = `(select coalesce(max(seq), 0) from events where counter_id = $1) = $2`;
  /**
   * The session is still taking events — checked **inside** the transaction.
   *
   * P2.5 §1: `sellado` is the point after which nothing can be appended, and
   * `api/c/[token]/events.ts` refuses a sealed session before it gets here. That
   * check reads the session outside any transaction, though, and the window it
   * leaves is exactly the one that matters: a push that read «abierto» at
   * 17:03:59.8 and a seal that commits at 17:04:00.0 would put events into
   * `events` that `session_hash` does not cover — a count in the database and
   * outside the certificate, which is the one inconsistency the whole task
   * exists to prevent.
   *
   * The `for share` below is the other half. Without it this predicate reads the
   * committed state at statement start and the seal could commit immediately
   * afterwards; with it, a push and a seal cannot overlap at all, and the loser
   * finds out which one it is. `for share` rather than `for update` because
   * pushes do not conflict with *each other* — two counters draining at once is
   * the normal afternoon — and only the seal needs to exclude them.
   */
  const open = `(select estado from sessions where id =
                  (select session_id from counters where id = $1)) = any($4::text[])`;
  /**
   * The insert landed: the row at the batch's head is *ours*, by hash.
   *
   * The counter update cannot reuse `untouched` — by the time it runs, inside
   * the same transaction, the insert has already moved `max(seq)`. Nor can it
   * be guarded on the new maximum alone: two transactions pushing the same
   * range would both pass that, and the loser would then stamp a state it
   * computed against a chain it never saw. Comparing the hash at the head says
   * exactly what needs saying — the chain now ends on the link this batch
   * ended on — and it is true for a replay, which is the one case where the
   * loser's state *is* the right one.
   */
  const landed = `(select hash from events where counter_id = $1 and seq = $9) = $10`;

  return [
    // The session, shared: this transaction is one of possibly several pushes,
    // and it excludes only the seal (`sealStatements` takes the same row `for
    // update`). Taken before the counter lock, in the same order every other
    // write path here takes them, so no two of them can deadlock.
    {
      text: `select id from sessions where id = (select session_id from counters where id = $1)
             for share`,
      params: [counterId],
    },
    // The counter lock, and nothing that writes before it.
    { text: `select id from counters where id = $1 for update`, params: [counterId] },
    {
      text: `insert into events (
               id, session_id, counter_id, seq, kind, idarticulo, cantidad,
               retracts_event_id, motivo, texto, final_seq, head_hash,
               usuario, zona, client_at, device_id, prev_hash, hash)
             select r.id::uuid, r.session_id::uuid, $1::uuid, r.seq, r.kind, r.idarticulo,
                    r.cantidad, r.retracts_event_id::uuid, r.motivo, r.texto,
                    r.final_seq, r.head_hash, r.usuario, r.zona, r.client_at,
                    r.device_id, r.prev_hash, r.hash
             from jsonb_to_recordset($3::jsonb) as r(
               id text, session_id text, seq int, kind text, idarticulo int,
               cantidad text, retracts_event_id text, motivo text, texto text,
               final_seq int, head_hash text, usuario text, zona text,
               client_at text, device_id text, prev_hash text, hash text)
             where ${untouched} and ${open}`,
      params: [
        counterId,
        expectedMaxSeq,
        JSON.stringify(
          events.map((event) => ({
            id: event.id,
            session_id: event.sessionId,
            seq: event.seq,
            kind: event.kind,
            idarticulo: event.idarticulo,
            cantidad: event.cantidad,
            retracts_event_id: event.retractsEventId,
            motivo: event.motivo,
            texto: event.texto,
            final_seq: event.finalSeq,
            head_hash: event.headHash,
            usuario: event.usuario,
            zona: event.zona,
            client_at: event.clientAt,
            device_id: event.deviceId,
            prev_hash: event.prevHash,
            hash: event.hash,
          })),
        ),
        OPEN_TO_EVENTS,
      ],
    },
    {
      // Device binding, and it never rejects (P2.2 §3a). A second device is
      // appended to `device_ids_seen` and flagged for the admin, because a
      // tablet dying mid-shift is a real morning and a hard block would cost
      // the counter theirs to prevent something a warning handles.
      //
      // `first_device_at` is set once, by `coalesce`. The skew is kept at its
      // largest magnitude ever seen rather than its latest value: a tablet that
      // was nine minutes fast at eleven and correct at four was still nine
      // minutes fast in the log the acta is read from.
      // `retirado` is the one state in this column that is not derived from the
      // chain (P2.3.5 §5a): it is an admin decision, recorded in
      // `session_actions` with a reason. Luis's tablet draining at 17:40 is
      // welcome — his events are his and they belong in the file — but the push
      // must not quietly put him back into the count, so the case below keeps
      // the decision and lets everything else be re-derived.
      text: `update counters set
               estado          = case when counters.estado = 'retirado'
                                      then 'retirado' else $2 end,
               finish_reason   = $3,
               final_seq       = $4,
               head_hash       = $5,
               device_id       = $6,
               first_device_at = coalesce(first_device_at, $8::timestamptz),
               device_ids_seen = case when $6 = any(device_ids_seen)
                                      then device_ids_seen
                                      else array_append(device_ids_seen, $6) end,
               clock_skew_ms   = case when clock_skew_ms is null
                                        or abs($7::int) > abs(clock_skew_ms)
                                      then $7::int else clock_skew_ms end,
               last_server_at  = $8::timestamptz,
               finished_at     = case when $2 in ('terminado_confirmado', 'terminado_incompleto')
                                      then coalesce(finished_at, $8::timestamptz)
                                      else null end
             where id = $1 and ${landed}
             returning (select coalesce(max(seq), 0) from events where counter_id = $1) as "maxSeq"`,
      params: [
        counterId,
        counterUpdate.estado,
        counterUpdate.finishReason,
        counterUpdate.finalSeq,
        counterUpdate.headHash,
        counterUpdate.deviceId,
        counterUpdate.clockSkewMs,
        counterUpdate.serverAt,
        counterUpdate.headSeq,
        counterUpdate.chainHead,
      ],
    },
  ];
}

/** Latch the fork flag. Nothing about a fork resolves itself, so nothing clears it here. */
export async function markForked(db: Db, counterId: string): Promise<void> {
  await db.query('update counters set forked = true where id = $1', [counterId]);
}

export interface CounterSyncRow {
  id: string;
  nombre: string;
  estado: string;
  storedMaxSeq: number;
  /**
   * How many events the server holds for this counter.
   *
   * Beside `storedMaxSeq` because the two together answer «is this chain whole»
   * exactly: `seq` starts at 1 and `unique (counter_id, seq)` forbids a
   * repeat, so `count(*) = max(seq)` is contiguity and nothing else. That is the
   * gate a **retired** counter is held to (P2.3.5 §5a), and it is one query
   * rather than one per counter.
   */
  storedCount: number;
  headHash: string | null;
  finalSeq: number | null;
  finishReason: string | null;
  lastServerAt: string | null;
  fetchedAt: string | null;
  deviceIds: string[];
  clockSkewMs: number | null;
  forked: boolean;
}

/** Everything the admin's `/sync` poll shows, per counter, in one query. */
export async function loadCounterSync(db: Db, sessionId: string): Promise<CounterSyncRow[]> {
  return db.query<CounterSyncRow>(
    `select c.id, c.nombre, c.estado,
            coalesce((select max(seq) from events e where e.counter_id = c.id), 0) as "storedMaxSeq",
            (select count(*)::int from events e where e.counter_id = c.id) as "storedCount",
            c.head_hash      as "headHash",
            c.final_seq      as "finalSeq",
            c.finish_reason  as "finishReason",
            ${utc('c.last_server_at')} as "lastServerAt",
            ${utc('c.fetched_at')}     as "fetchedAt",
            c.device_ids_seen as "deviceIds",
            c.clock_skew_ms   as "clockSkewMs",
            c.forked
     from counters c where c.session_id = $1 order by c.created_at, c.nombre`,
    [sessionId],
  );
}

export interface AdminEventRow extends EventWire {
  serverSeq: string;
  serverAt: string;
}

/**
 * A page of one session's events in **arrival** order.
 *
 * `server_seq` is a `bigserial` and carries the standard cursor trap: under
 * concurrent transactions a lower value can become visible after a higher one,
 * so a strict `> cursor` poll can skip an event permanently. The caller polls
 * from `cursor - overlap` and merges by `id` — events are immutable and keyed
 * by a device-generated uuid, so redelivery costs nothing and a skipped event is
 * a wrong total on a screen somebody signs.
 *
 * `server_seq` comes back as **text**: it is a `bigint`, and a driver that hands
 * it back as a JavaScript number is a driver that will one day hand back a
 * rounded one.
 */
export async function loadEventsSince(
  db: Db,
  sessionId: string,
  since: string,
  limit: number,
): Promise<AdminEventRow[]> {
  return db.query<AdminEventRow>(
    `select id, session_id as "sessionId", counter_id as "counterId", seq, kind, idarticulo,
            cantidad, retracts_event_id as "retractsEventId", motivo, texto,
            final_seq as "finalSeq", head_hash as "headHash",
            usuario, zona, client_at as "clientAt", device_id as "deviceId",
            prev_hash as "prevHash", hash,
            server_seq::text as "serverSeq",
            ${utc('server_at')} as "serverAt"
     from events
     where session_id = $1 and server_seq > $2::bigint
     order by server_seq
     limit $3`,
    [sessionId, since, limit],
  );
}

// --- P2.3.5: admin actions, reassignment, retirement -------------------------

/**
 * One stored admin action, as it comes back out.
 *
 * `payload` arrives from the driver already parsed — both `pg` and the Neon
 * HTTP driver decode `jsonb` — so nothing here re-parses it. What matters for
 * the chain is that the object it hands back re-canonicalises to the same bytes
 * that were hashed, which is what `canonicalJson`'s key sorting and its refusal
 * of non-integer numbers exist for.
 */
export interface SessionActionRow {
  id: string;
  sessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  usuario: string;
  clientAt: string;
  serverAt: string;
  prevHash: string;
  hash: string;
}

export async function loadSessionActions(
  db: Db,
  sessionId: string,
): Promise<SessionActionRow[]> {
  return db.query<SessionActionRow>(
    `select id, session_id as "sessionId", seq, kind, payload, usuario,
            client_at as "clientAt",
            ${utc('server_at')} as "serverAt",
            prev_hash as "prevHash", hash
     from session_actions where session_id = $1 order by seq`,
    [sessionId],
  );
}

/** An action on its way in. Hashed by the handler with `chainActionHash`. */
export interface ActionWire {
  id: string;
  seq: number;
  kind: string;
  payload: unknown;
  usuario: string;
  clientAt: string;
  prevHash: string;
  hash: string;
}

function actionRows(sessionId: string, actions: readonly ActionWire[]): string {
  return JSON.stringify(
    actions.map((action) => ({
      id: action.id,
      session_id: sessionId,
      seq: action.seq,
      kind: action.kind,
      // Stringified here and cast back in SQL. `jsonb_to_recordset` would give
      // us a `jsonb` column directly, but only if the value were nested in the
      // document — and a payload that is itself an object then has to be
      // distinguished from the record's own fields. One less thing to get wrong.
      payload: JSON.stringify(action.payload),
      usuario: action.usuario,
      client_at: action.clientAt,
      prev_hash: action.prevHash,
      hash: action.hash,
    })),
  );
}

const INSERT_ACTIONS = `
  insert into session_actions
    (id, session_id, seq, kind, payload, usuario, client_at, prev_hash, hash)
  select r.id::uuid, r.session_id::uuid, r.seq, r.kind, r.payload::jsonb, r.usuario,
         r.client_at, r.prev_hash, r.hash
  from jsonb_to_recordset($ACTIONS::jsonb) as r(
    id text, session_id text, seq int, kind text, payload text, usuario text,
    client_at text, prev_hash text, hash text)
`;

export interface ReassignWrites {
  /** The action rows, in order. The last one is what everything after is guarded on. */
  actions: readonly ActionWire[];
  /** `coalesce(max(seq), 0)` over `session_actions` as the handler read it. */
  expectedActionSeq: number;
  /** `sessions.assignments_version` as the handler read it. */
  version: number;
  /** Which session states may still be repartitioned (`REASSIGNABLE`). */
  estados: readonly string[];
  counters: readonly { id: string; nombre: string; token: string }[];
  createSections: readonly { id: string; nombre: string; counterId: string }[];
  repointSections: readonly { id: string; to: string }[];
  moves: readonly { idarticulo: number; from: string; to: string; sectionId: string }[];
}

/**
 * A reassignment, in one transaction, with every write guarded.
 *
 * The same shape `dispatchStatements` and `insertEventsStatements` use, for the
 * same reason and against the same failure: **in a non-interactive transaction
 * an unmatched `update` raises nothing.** Neon's HTTP protocol has no session to
 * hold a transaction open across, so the decision is taken outside it, and a
 * guard on the last statement guards nothing — the first six would already have
 * committed. Every statement below therefore carries its own predicate, and the
 * first one takes the row lock before anything has been written.
 *
 * There are two predicates, and the split is what makes this all-or-nothing:
 *
 *   - **`prechecked`** — the session is still open, `assignments_version` is
 *     still what the admin planned against, every `from` really does hold its
 *     article, and the action chain is where the handler read it. Evaluated once,
 *     on the statement that appends the actions.
 *   - **`landed`** — the action row at the chain's new head is *ours*, by hash.
 *     Everything after is guarded on that instead, because by then the first
 *     predicate is no longer true of the transaction's own state (the actions it
 *     tested for are now there). It is the same trick `insertEventsStatements`
 *     uses to guard the counter update after its own insert has moved `max(seq)`.
 *
 * So either the actions were appended — in which case every precondition held —
 * or nothing at all happened. There is no ordering in which the partition moves
 * and the record of why does not.
 *
 * The version bump is last and is what the handler reads: an empty result means
 * somebody else reassigned while this admin was planning, and the answer is a
 * `409` and a reload. **Move lists are never merged.**
 */
export function reassignStatements(sessionId: string, writes: ReassignWrites): Statement[] {
  const head = writes.actions[writes.actions.length - 1];
  const estados = [...writes.estados];
  const plan = JSON.stringify(
    writes.moves.map((move) => ({
      idarticulo: move.idarticulo,
      from_id: move.from,
      to_id: move.to,
      section_id: move.sectionId,
    })),
  );

  /**
   * The batch's own last action row is here, by hash.
   *
   * Every statement after the action insert is guarded on this rather than on
   * `prechecked`, because by then the first predicate is no longer true of the
   * transaction's own state — the actions it tests for are now present. Same
   * trick, and same reason, as the counter update in `insertEventsStatements`.
   *
   * `$1` is always the session, `$2` the head seq, `$3` its hash. Parameters are
   * numbered **per statement** rather than shared, because Postgres refuses a
   * bind that supplies more parameters than the statement uses.
   */
  const landed = `(select hash from session_actions where session_id = $1 and seq = $2) = $3`;
  const landedParams = [sessionId, head.seq, head.hash];

  return [
    // The lock, and nothing else before it. Anything written first could be
    // written by a transaction that is about to lose.
    {
      text: `select id from sessions
             where id = $1 and estado = any($2::text[]) and assignments_version = $3
             for update`,
      params: [sessionId, estados, writes.version],
    },
    {
      // Everything hangs off this one statement landing. `prechecked` is the
      // whole precondition — the session is still open, `assignments_version` is
      // still what the admin planned against, every `from` really does hold its
      // article, and the action chain is where the handler read it.
      text: `${INSERT_ACTIONS.replace('$ACTIONS', '$7')}
             where (select estado from sessions where id = $1) = any($2::text[])
               and (select assignments_version from sessions where id = $1) = $3
               and (select count(*) from assignments a
                      join jsonb_to_recordset($4::jsonb)
                        as p(idarticulo int, from_id text, to_id text, section_id text)
                        on a.idarticulo = p.idarticulo and a.counter_id = p.from_id::uuid
                     where a.session_id = $1) = $5
               and (select coalesce(max(seq), 0) from session_actions where session_id = $1) = $6`,
      params: [
        sessionId,
        estados,
        writes.version,
        plan,
        writes.moves.length,
        writes.expectedActionSeq,
        actionRows(sessionId, writes.actions),
      ],
    },
    {
      // New counters, minted with the same generator and the same 128-bit token
      // as dispatch (P2.1). `asignado`, because they have not opened the link.
      text: `insert into counters (id, session_id, nombre, token, estado)
             select r.id::uuid, $1::uuid, r.nombre, r.token, 'asignado'
             from jsonb_to_recordset($4::jsonb) as r(id text, nombre text, token text)
             where ${landed}`,
      params: [...landedParams, JSON.stringify(writes.counters)],
    },
    {
      text: `insert into sections (id, session_id, nombre, counter_id)
             select r.id::uuid, $1::uuid, r.nombre, r.counter_id::uuid
             from jsonb_to_recordset($4::jsonb) as r(id text, nombre text, counter_id text)
             where ${landed}`,
      params: [
        ...landedParams,
        JSON.stringify(
          writes.createSections.map((section) => ({
            id: section.id,
            nombre: section.nombre,
            counter_id: section.counterId,
          })),
        ),
      ],
    },
    {
      // A whole section changing hands: same row, same name, same `zona`. A
      // second name for one shelf would put two zones on one place in the acta.
      text: `update sections s set counter_id = r.to_id::uuid
             from jsonb_to_recordset($4::jsonb) as r(id text, to_id text)
             where s.id = r.id::uuid and s.session_id = $1 and ${landed}`,
      params: [
        ...landedParams,
        JSON.stringify(writes.repointSections.map((section) => ({ id: section.id, to_id: section.to }))),
      ],
    },
    {
      // The move itself. `a.counter_id = p.from_id` stays in the predicate even
      // though the action insert already verified it: a row that is not where
      // the plan said must not be silently overwritten, and under the version
      // guard the two can only disagree if there is a bug.
      text: `update assignments a
             set counter_id = p.to_id::uuid, section_id = p.section_id::uuid
             from jsonb_to_recordset($4::jsonb)
               as p(idarticulo int, from_id text, to_id text, section_id text)
             where a.session_id = $1 and a.idarticulo = p.idarticulo
               and a.counter_id = p.from_id::uuid and ${landed}
             returning a.idarticulo`,
      params: [...landedParams, plan],
    },
    {
      // The handler reads this one. Empty means somebody else moved first, and
      // — because everything above hangs off `landed` — nothing at all happened.
      text: `update sessions set assignments_version = assignments_version + 1
             where id = $1 and estado = any($4::text[]) and assignments_version = $5
               and ${landed}
             returning assignments_version as "assignmentsVersion"`,
      params: [...landedParams, estados, writes.version],
    },
  ];
}

export interface RetireWrites {
  counterId: string;
  action: ActionWire;
  expectedActionSeq: number;
  estados: readonly string[];
}

/**
 * Retire a counter, and record why, in one transaction.
 *
 * **Refused while they still hold an article.** Retirement is not a way to
 * abandon coverage, so the reassignment comes first; sequencing it that way
 * keeps the coverage gate one rule rather than one rule with an exception. The
 * check is inside the transaction, on the assignments as they are at that
 * instant, because an admin who reassigns in one tab and retires in another is
 * the ordinary way this gets done.
 *
 * The state change is guarded on the action having landed, so there is no
 * ordering in which somebody is retired and the reason is not on the chain.
 */
export function retireStatements(sessionId: string, writes: RetireWrites): Statement[] {
  const estados = [...writes.estados];
  return [
    {
      text: `select id from counters where id = $2::uuid and session_id = $1 for update`,
      params: [sessionId, writes.counterId],
    },
    {
      text: `${INSERT_ACTIONS.replace('$ACTIONS', '$5')}
             where (select estado from sessions where id = $1) = any($3::text[])
               and (select count(*) from assignments
                     where session_id = $1 and counter_id = $2::uuid) = 0
               and (select estado from counters where id = $2::uuid) <> 'retirado'
               and (select coalesce(max(seq), 0) from session_actions where session_id = $1) = $4`,
      params: [
        sessionId,
        writes.counterId,
        estados,
        writes.expectedActionSeq,
        actionRows(sessionId, [writes.action]),
      ],
    },
    {
      text: `update counters set estado = 'retirado'
             where id = $2::uuid and session_id = $1
               and (select hash from session_actions where session_id = $1 and seq = $3) = $4
             returning id`,
      params: [sessionId, writes.counterId, writes.action.seq, writes.action.hash],
    },
  ];
}

export interface ActionOnlyWrites {
  action: ActionWire;
  expectedActionSeq: number;
  estados: readonly string[];
  /**
   * A counter this action is *about*, and the state they must still be in.
   *
   * A parameter rather than a predicate string the caller composes: an id
   * interpolated into SQL text is an id somebody will one day take from a
   * request body. `sellar_sin_registros` is the case — it may only be signed
   * against a counter who is already `retirado`, and that has to be re-checked
   * under the lock because the read that established it was outside one.
   */
  counter?: { id: string; estado: string };
}

/**
 * An admin action with no other write behind it — `sellar_sin_registros`.
 *
 * It changes nothing about the partition or about any counter's state. What it
 * changes is the sealing gate, and it does that by *being on the chain*: the
 * gate reads the action log (`sealOverrides`), so the only way to satisfy it is
 * to sign something that will be printed on the acta.
 */
export function actionStatements(sessionId: string, writes: ActionOnlyWrites): Statement[] {
  const estados = [...writes.estados];
  const counterGuard = writes.counter
    ? `and (select estado from counters where id = $5::uuid) = $6`
    : '';

  return [
    { text: `select id from sessions where id = $1 for update`, params: [sessionId] },
    {
      text: `${INSERT_ACTIONS.replace('$ACTIONS', '$4')}
             where (select estado from sessions where id = $1) = any($2::text[])
               and (select coalesce(max(seq), 0) from session_actions where session_id = $1) = $3
               ${counterGuard}`,
      params: [
        sessionId,
        estados,
        writes.expectedActionSeq,
        actionRows(sessionId, [writes.action]),
        ...(writes.counter ? [writes.counter.id, writes.counter.estado] : []),
      ],
    },
    // Read back, so the handler answers on what is stored rather than on what it
    // sent. An empty result is somebody else having appended this seq first.
    {
      text: `select seq from session_actions where session_id = $1 and seq = $2`,
      params: [sessionId, writes.action.seq],
    },
  ];
}

/**
 * One session's item events, reconstructed as domain events.
 *
 * Read by `GET /api/c/:token` to compute `yaRegistrados` (P2.3.5 §6b), and the
 * one place the server folds anything. It folds with `registeredArticles`, the
 * same function the tablet uses — deciding what "registered" means in SQL would
 * be a second definition, and the two would disagree the first time a scoped
 * retraction landed.
 *
 * Session-scoped kinds are excluded by the `idarticulo is not null` predicate:
 * a `finish` says nothing about an article and would only be dropped by the
 * fold anyway.
 */
export async function loadItemEvents(
  db: Db,
  sessionId: string,
  idarticulos: readonly number[],
): Promise<CountEvent[]> {
  if (idarticulos.length === 0) return [];
  const rows = await db.query<EventWire>(
    `select id, session_id as "sessionId", counter_id as "counterId", seq, kind, idarticulo,
            cantidad, retracts_event_id as "retractsEventId", motivo, texto,
            final_seq as "finalSeq", head_hash as "headHash",
            usuario, zona, client_at as "clientAt", device_id as "deviceId",
            prev_hash as "prevHash", hash
     from events
     where session_id = $1 and idarticulo = any($2::int[])
     order by counter_id, seq`,
    [sessionId, [...idarticulos]],
  );
  return rows.map(eventFromRow);
}

// --- P2.5: the seal, the export, and the bundle ------------------------------

/**
 * Every event in a session, in `(counterId, seq)` order.
 *
 * `loadItemEvents` beside it is filtered to a set of articles and drops the
 * session-scoped kinds; this one drops nothing. Three readers need all of it and
 * for the same reason: the export folds the whole log, the acta reports on
 * `finish` and `reopen` positions, and the bundle has to carry every link or the
 * verifier cannot walk a chain from genesis.
 *
 * Ordered by `(counter_id, seq)` so the bundle's byte sequence does not depend
 * on what the planner felt like doing. `canonicalJson` sorts object keys; it
 * does not sort arrays, and it must not — an array's order is part of what it
 * means.
 */
export async function loadSessionEvents(db: Db, sessionId: string): Promise<EventWire[]> {
  return db.query<EventWire>(
    `select id, session_id as "sessionId", counter_id as "counterId", seq, kind, idarticulo,
            cantidad, retracts_event_id as "retractsEventId", motivo, texto,
            final_seq as "finalSeq", head_hash as "headHash",
            usuario, zona, client_at as "clientAt", device_id as "deviceId",
            prev_hash as "prevHash", hash
     from events where session_id = $1 order by counter_id, seq`,
    [sessionId],
  );
}

export interface SealWrites {
  /**
   * The `sellar_sin_registros` action signed with this seal, when there is one.
   *
   * In the **same transaction** and written **first**, so it is inside the chain
   * the seal covers. An override recorded afterwards would sit outside the hash
   * that is supposed to attest to it — which is to say, outside the only thing
   * that makes it more than a note.
   */
  action?: ActionWire;
  /** `coalesce(max(seq), 0)` over `session_actions` as the handler read it. */
  expectedActionSeq: number;
  /** The counter the override is about, and the state they must still be in. */
  counter?: { id: string; estado: string };
  /** Which session states may still be sealed. */
  estados: readonly string[];
  sessionHash: string;
}

/**
 * Seal a session: freeze both chains and record what they hashed to.
 *
 * **`sealed_at` comes from `now()` in the database, not from the handler.**
 * `events.server_at` defaults to the same clock, and the two are compared:
 * «which events arrived after the seal» is only a meaningful question if both
 * sides of it are read off one clock. A serverless function's `Date.now()` and
 * its database's are close and are not the same, and a handler running a few
 * seconds behind would stamp a seal that made legitimately earlier events look
 * late — a false alarm on the one screen that must not cry wolf.
 *
 * Every write guarded inside the transaction, for the third time in this
 * codebase and for the same reason as the first two (P2.2's dispatch bug):
 * Neon's HTTP protocol has no session to hold an interactive transaction open
 * across, so the decision is made outside it — and **an unmatched `update`
 * raises nothing**. A guard on only the last statement would guard nothing,
 * because the earlier ones would already have committed.
 *
 * The guard on the update includes `session_hash is null`, which makes the seal
 * idempotent in the only direction that matters: two admins pressing the button
 * at once produce one seal and one refusal, never a session whose recorded hash
 * is over a chain that grew between the two reads.
 */
export function sealStatements(sessionId: string, writes: SealWrites): Statement[] {
  const statements: Statement[] = [
    { text: `select id from sessions where id = $1 for update`, params: [sessionId] },
  ];

  if (writes.action) {
    const counterGuard = writes.counter
      ? `and (select estado from counters where id = $5::uuid) = $6`
      : '';
    statements.push({
      text: `${INSERT_ACTIONS.replace('$ACTIONS', '$4')}
             where (select estado from sessions where id = $1) = any($2::text[])
               and (select coalesce(max(seq), 0) from session_actions where session_id = $1) = $3
               ${counterGuard}`,
      params: [
        sessionId,
        [...writes.estados],
        writes.expectedActionSeq,
        actionRows(sessionId, [writes.action]),
        ...(writes.counter ? [writes.counter.id, writes.counter.estado] : []),
      ],
    });
  }

  statements.push({
    text: `update sessions
             set estado = 'sellado', sealed_at = now(), session_hash = $2
           where id = $1
             and estado = any($3::text[])
             and session_hash is null
             and (select coalesce(max(seq), 0) from session_actions where session_id = $1) = $4
           returning ${utc('sealed_at')} as "sealedAt", session_hash as "sessionHash"`,
    params: [
      sessionId,
      writes.sessionHash,
      [...writes.estados],
      // The chain must be exactly where the hash was taken over: the override
      // this transaction just wrote, or nothing at all. An action that landed
      // between the read and this statement would be one the seal does not cover.
      writes.expectedActionSeq + (writes.action ? 1 : 0),
    ],
  });

  return statements;
}

export interface ExportWrites {
  bytes: Uint8Array;
  fileHash: string;
}

/**
 * Store the generated file and close the session.
 *
 * One statement, guarded on `estado = 'sellado'` and on there being no bytes
 * yet. Generation happens once: a second export would produce a second
 * `file_hash` for a session whose acta names the first, and the honest name for
 * that is two files.
 *
 * `decode($2, 'hex')` rather than a driver-side `bytea` parameter, because the
 * two drivers disagree about how to send one — `pg` wants a Buffer and the Neon
 * HTTP driver serialises through JSON — and hex is what both can carry as text.
 * The same asymmetry `loadSourceBytes` handles on the way out.
 */
export function exportStatements(sessionId: string, writes: ExportWrites): Statement[] {
  const hex = Array.from(writes.bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    { text: `select id from sessions where id = $1 for update`, params: [sessionId] },
    {
      text: `update sessions
               set estado = 'cerrado',
                   exported_at = now(),
                   file_hash = $2,
                   export_bytes = decode($3, 'hex')
             where id = $1 and estado = 'sellado' and export_bytes is null
             returning ${utc('exported_at')} as "exportedAt", file_hash as "fileHash"`,
      params: [sessionId, writes.fileHash, hex],
    },
  ];
}

/**
 * The generated file, back out again.
 *
 * The same two-driver normalisation as `loadSourceBytes`, and the same reason
 * it is worth a function: a re-download that served a `\\x…` string as though it
 * were bytes would produce a file that is twice the size and entirely wrong,
 * and it would do so only on whichever driver the deploy happened to use.
 */
export async function loadExportBytes(db: Db, id: string): Promise<Uint8Array | null> {
  const rows = await db.query<{ export_bytes: unknown }>(
    'select export_bytes from sessions where id = $1',
    [id],
  );
  const value = rows[0]?.export_bytes;
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  throw new Error(`export_bytes came back as ${typeof value}, which no driver should produce`);
}

/**
 * Events the server accepted **after** the seal.
 *
 * This list should always be empty, and it is read anyway.
 *
 * `insertEventsStatements` guards the insert on the session still being open
 * and takes the session row `for share`, so a push and a seal cannot overlap
 * and a late batch is refused rather than stored. That is an argument, and the
 * screen this feeds is the one place where an argument is not good enough: an
 * event in `events` that `session_hash` does not cover is a count in the
 * database and outside the certificate, and the admin has to be able to see one
 * rather than be told it cannot happen.
 *
 * A non-empty answer means the guard failed — a hand-run `insert`, a restored
 * backup, a future migration that forgot. It is shown apart from the sealed set,
 * because those events are real work and are **not** part of what was certified.
 *
 * **`sealed_at` is read in SQL, never passed in.** The value this endpoint hands
 * to a browser is rendered to milliseconds (`utc()`), and `timestamptz` keeps
 * microseconds; comparing against the rendered string flags every event that
 * landed in the same millisecond as the seal — which, on a fast machine, is the
 * last push before it. A false «events arrived after the seal» on the one panel
 * whose whole job is integrity is worse than no panel.
 */
export async function loadEventsAfter(db: Db, sessionId: string): Promise<AdminEventRow[]> {
  return db.query<AdminEventRow>(
    `select id, session_id as "sessionId", counter_id as "counterId", seq, kind, idarticulo,
            cantidad, retracts_event_id as "retractsEventId", motivo, texto,
            final_seq as "finalSeq", head_hash as "headHash",
            usuario, zona, client_at as "clientAt", device_id as "deviceId",
            prev_hash as "prevHash", hash,
            server_seq::text as "serverSeq",
            ${utc('server_at')} as "serverAt"
     from events
     where session_id = $1
       and server_at > (select sealed_at from sessions where id = $1)
     order by server_at`,
    [sessionId],
  );
}
