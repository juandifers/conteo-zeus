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
import type { Item } from '../src/domain';
import type { CatalogueRowWire } from '../src/app';
import { fromBase64, toBase64 } from '../src/lib/base64';
import type { Db, Row, Statement } from './_db';

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
  ${utc('dispatched_at')} as "dispatchedAt"
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

export interface CounterRow {
  id: string;
  nombre: string;
  token: string;
  estado: string;
  fetchedAt: string | null;
  fetchCount: number;
  /** The device bound on first push, or `null` before there was one (P2.2 §3a). */
  deviceId: string | null;
}

export async function loadCounters(db: Db, sessionId: string): Promise<CounterRow[]> {
  return db.query<CounterRow>(
    `select id, nombre, token, estado,
            ${utc('fetched_at')} as "fetchedAt",
            fetch_count as "fetchCount",
            device_id   as "deviceId"
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
            ${utc('fetched_at')} as "fetchedAt",
            fetch_count as "fetchCount",
            device_id   as "deviceId",
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
export interface EventWire {
  id: string;
  sessionId: string;
  counterId: string;
  seq: number;
  kind: string;
  idarticulo: number | null;
  cantidad: string | null;
  retractsEventId: string | null;
  motivo: string | null;
  texto: string | null;
  finalSeq: number | null;
  headHash: string | null;
  usuario: string;
  zona: string;
  clientAt: string;
  deviceId: string;
  prevHash: string;
  hash: string;
}

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
    // The lock, and nothing else before it.
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
             where ${untouched}`,
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
      text: `update counters set
               estado          = $2,
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
