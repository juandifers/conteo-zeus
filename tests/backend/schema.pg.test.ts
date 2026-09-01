/**
 * The schema against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set, so `npm test` on a laptop with no
 * database still runs the whole suite. CI sets it against a throwaway
 * `postgres:16-alpine`; `docs/BACKEND.md` says how to get one locally.
 *
 * What is worth a database rather than a regex over the SQL: the three column
 * types P2 is betting on have to survive a **round trip through the driver**,
 * and that is not something reading the DDL can tell you. `raw_row text[]` is
 * the property that stops this app shearing a file; `cantidad text` is the
 * property that stops the hash chain breaking silently; `source_bytes bytea` is
 * the file an export has to be built from months later.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { EXPECTED_MIGRATION_VERSION } from '../../api/_schemaVersion';

const URL = process.env.DATABASE_URL;
const suite = URL ? describe : describe.skip;

let client: pg.Client;
const SESSION = '11111111-1111-4111-8111-111111111111';
const COUNTER = '22222222-2222-4222-8222-222222222222';
const SECTION = '44444444-4444-4444-8444-444444444444';

/** A real Zeus row: 24 fields, verbatim, order preserved (ZEUS_FORMAT.md §2). */
const RAW_ROW = [
  '0103005', 'PANCETA SV', 'KILO', '97.5', '96', '-1.5', '3990.626866', '0', '0', '', '',
  '1181', '01', '2026/04/30', '-1', '66.5', '-1', '-1', '', '', '', '', '', '3990.62686567164',
];

/** Arbitrary bytes, including a NUL and the CP850 high bytes the format uses. */
const SOURCE_BYTES = Buffer.from([0x00, 0xa5, 0xd6, 0xe0, 0x0d, 0x0a, 0xff, 0x09]);

suite('the schema, against Postgres', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    await client.query('begin');
    await client.query(
      `insert into sessions (id, bodega, fecha_corte, estado, source_hash, source_bytes)
       values ($1, '01', '2026/04/30', 'abierto', $2, $3)`,
      [SESSION, 'a'.repeat(64), SOURCE_BYTES],
    );
    await client.query(
      `insert into catalog_rows
         (session_id, ord, idarticulo, codigo, nombre, presentacion, existencia, costo, raw_row)
       values ($1, 0, 1181, '0103005', 'PANCETA SV', 'KILO', 97.5, 3990.62686567164, $2)`,
      [SESSION, RAW_ROW],
    );
    await client.query(
      `insert into counters (id, session_id, nombre, token, estado)
       values ($1, $2, 'Ana', 'tok-ana', 'contando')`,
      [COUNTER, SESSION],
    );
    await client.query(
      `insert into sections (id, session_id, nombre, counter_id) values ($1, $2, 'ALMACEN', $3)`,
      [SECTION, SESSION, COUNTER],
    );
  });

  afterAll(async () => {
    // Rolled back rather than deleted: the test leaves the database exactly as
    // it found it, so a developer can point it at one they are also using.
    if (client) {
      await client.query('rollback');
      await client.end();
    }
  });

  it('is at the version this build expects', async () => {
    // Pinned to the literal `/api/health` compares against rather than to a
    // number written here, so adding a migration is one edit rather than two.
    const { rows } = await client.query(
      'select coalesce(max(version), 0)::int as version from schema_migrations',
    );
    expect(rows[0].version).toBe(EXPECTED_MIGRATION_VERSION);
  });

  it('round-trips raw_row as 24 strings, order preserved, empties intact', async () => {
    // The property `writeTxt` depends on. An array that came back re-ordered,
    // trimmed, or with its empty strings turned into nulls would produce a file
    // that looks like a Zeus export and posts somebody else's numbers.
    const { rows } = await client.query(
      'select raw_row from catalog_rows where session_id = $1 and idarticulo = 1181',
      [SESSION],
    );
    expect(rows[0].raw_row).toEqual(RAW_ROW);
    expect(rows[0].raw_row).toHaveLength(24);
    expect(rows[0].raw_row[9]).toBe('');
    expect(rows[0].raw_row.every((f: unknown) => typeof f === 'string')).toBe(true);
  });

  it('round-trips source_bytes byte for byte, NUL included', async () => {
    const { rows } = await client.query(
      'select source_bytes from sessions where id = $1',
      [SESSION],
    );
    expect([...rows[0].source_bytes]).toEqual([...SOURCE_BYTES]);
  });

  it('round-trips cantidad as the exact string it was hashed as', async () => {
    // The reason the column is `text`. Every one of these is a value a `numeric`
    // or a float would have handed back differently, and the canonical decimal
    // string is what `canonicalEvent` put into the chain.
    const quantities = ['20.8', '0.20000000000000107', '10.50', '0', '-0', '1e21', '97.5'];
    for (const [index, cantidad] of quantities.entries()) {
      await client.query(
        `insert into events
           (id, session_id, counter_id, seq, kind, idarticulo, cantidad,
            usuario, zona, client_at, device_id, prev_hash, hash)
         values (gen_random_uuid(), $1, $2, $3, 'set', 1181, $4,
                 'ana', 'CAVA', '2026-04-30T13:00:00.000Z', 'tablet-a', 'p', 'h')`,
        [SESSION, COUNTER, index, cantidad],
      );
    }
    const { rows } = await client.query(
      'select seq, cantidad from events where counter_id = $1 order by seq',
      [COUNTER],
    );
    expect(rows.map((r) => r.cantidad)).toEqual(quantities);
  });

  it('rejects a second event at the same (counter_id, seq)', async () => {
    // The single most important constraint in the schema: it makes pushes
    // idempotent under retry and makes gaps detectable.
    await client.query('savepoint dupe');
    await expect(
      client.query(
        `insert into events
           (id, session_id, counter_id, seq, kind, idarticulo, cantidad,
            usuario, zona, client_at, device_id, prev_hash, hash)
         values (gen_random_uuid(), $1, $2, 0, 'set', 1181, '1',
                 'ana', 'CAVA', '2026-04-30T13:00:00.000Z', 'tablet-a', 'p', 'h')`,
        [SESSION, COUNTER],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
    await client.query('rollback to savepoint dupe');
  });

  it('accepts a null idarticulo on a session-scoped event', async () => {
    await client.query(
      `insert into events
         (id, session_id, counter_id, seq, kind, idarticulo, final_seq, head_hash,
          usuario, zona, client_at, device_id, prev_hash, hash)
       values (gen_random_uuid(), $1, $2, 99, 'finish', null, 6, $3,
               'ana', 'CAVA', '2026-04-30T14:00:00.000Z', 'tablet-a', 'p', 'h')`,
      [SESSION, COUNTER, 'b'.repeat(64)],
    );
    const { rows } = await client.query(
      "select idarticulo, final_seq from events where counter_id = $1 and kind = 'finish'",
      [COUNTER],
    );
    expect(rows[0].idarticulo).toBeNull();
    expect(rows[0].final_seq).toBe(6);
  });

  it('lets two counters be assigned to one article', async () => {
    // Blind double-counting is out of scope for P2 and the schema does not
    // foreclose it.
    const second = '33333333-3333-4333-8333-333333333333';
    await client.query(
      `insert into counters (id, session_id, nombre, token, estado)
       values ($1, $2, 'Luis', 'tok-luis', 'contando')`,
      [second, SESSION],
    );
    await client.query(
      `insert into assignments (session_id, idarticulo, counter_id, section_id)
       values ($1, 1181, $2, $4), ($1, 1181, $3, $4)`,
      [SESSION, COUNTER, second, SECTION],
    );
    const { rows } = await client.query(
      'select count(*)::int as n from assignments where session_id = $1 and idarticulo = 1181',
      [SESSION],
    );
    expect(rows[0].n).toBe(2);
  });

  it('refuses an assignment to an article that is not in the catalogue', async () => {
    await client.query('savepoint fk');
    await expect(
      client.query(
        `insert into assignments (session_id, idarticulo, counter_id, section_id)
         values ($1, 999999, $2, $3)`,
        [SESSION, COUNTER, SECTION],
      ),
    ).rejects.toThrow(/foreign key/i);
    await client.query('rollback to savepoint fk');
  });

  it('gives the catalogue an order of its own, separate from its key', async () => {
    // Zeus does not always export ascending (ZEUS_FORMAT.md §7.5), so `ord` is
    // the file's order and `idarticulo` is the key. Two rows cannot claim one
    // position, or the catalogue sorts arbitrarily between them.
    await client.query('savepoint ord');
    await expect(
      client.query(
        `insert into catalog_rows
           (session_id, ord, idarticulo, codigo, nombre, presentacion, existencia, costo, raw_row)
         values ($1, 0, 9999, '0109999', 'OTRO', 'KILO', 1, 1, $2)`,
        [SESSION, RAW_ROW],
      ),
    ).rejects.toThrow(/catalog_rows_ord_unique|duplicate key/i);
    await client.query('rollback to savepoint ord');
  });

  it('keeps the prior count as a nullable numeric beside the balance', async () => {
    // `-1` is Zeus's not-applicable sentinel and is mapped to null in
    // `src/app/`, so the column has to accept one.
    await client.query('update catalog_rows set ultimo_conteo = null where session_id = $1', [
      SESSION,
    ]);
    await client.query('update catalog_rows set ultimo_conteo = 66.5 where session_id = $1', [
      SESSION,
    ]);
    const { rows } = await client.query(
      'select ultimo_conteo::text as prior from catalog_rows where session_id = $1',
      [SESSION],
    );
    expect(rows[0].prior).toBe('66.5');
  });

  it('refuses two sections with one name in one session', async () => {
    // The section name becomes `zona` on every event from it, and two zones
    // with one name are two places nobody can separate afterwards.
    await client.query('savepoint dup');
    await expect(
      client.query(
        `insert into sections (id, session_id, nombre, counter_id)
         values ('55555555-5555-4555-8555-555555555555', $1, 'ALMACEN', $2)`,
        [SESSION, COUNTER],
      ),
    ).rejects.toThrow(/duplicate key/i);
    await client.query('rollback to savepoint dup');
  });

  it('releases a section’s articles when the section goes, rather than orphaning them', async () => {
    // Dissolving a section is the admin's editing motion before dispatch. The
    // articles have to come back as a visible gap the coverage gate refuses —
    // the alternative is assignment rows pointing at a section that no longer
    // exists, which is the same articles unreachable instead of unassigned.
    await client.query('savepoint cascade');
    const before = await client.query(
      'select count(*)::int as n from assignments where session_id = $1',
      [SESSION],
    );
    expect(before.rows[0].n).toBeGreaterThan(0);
    await client.query('delete from sections where id = $1', [SECTION]);
    const { rows } = await client.query(
      'select count(*)::int as n from assignments where session_id = $1',
      [SESSION],
    );
    expect(rows[0].n).toBe(0);
    await client.query('rollback to savepoint cascade');
  });

  it('leaves a counter’s sections behind when the counter goes', async () => {
    // `set null`, not `cascade`: deleting a counter must produce a visible gap
    // the admin has to reassign, not silently delete the articles they held.
    await client.query('savepoint counter');
    // A fresh counter with no events: `events.counter_id` has no on-delete
    // action at all, so a counter that has recorded anything cannot be deleted
    // — which is the append-only log refusing to lose its author, and is worth
    // knowing separately from this.
    const fresh = '66666666-6666-4666-8666-666666666666';
    await client.query(
      `insert into counters (id, session_id, nombre, token, estado)
       values ($1, $2, 'Marta', 'tok-marta', 'asignado')`,
      [fresh, SESSION],
    );
    await client.query(
      `insert into sections (id, session_id, nombre, counter_id)
       values ('77777777-7777-4777-8777-777777777777', $1, 'CAVA', $2)`,
      [SESSION, fresh],
    );
    await client.query('delete from counters where id = $1', [fresh]);
    const { rows } = await client.query(
      `select counter_id from sections where id = '77777777-7777-4777-8777-777777777777'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].counter_id).toBeNull();
    await client.query('rollback to savepoint counter');
  });

  it('refuses to delete a counter that has recorded anything', async () => {
    // The log is append-only and its author is part of it. Dispatch only ever
    // deletes counters from a `borrador`, which by definition has none.
    await client.query('savepoint author');
    await expect(client.query('delete from counters where id = $1', [COUNTER])).rejects.toThrow(
      /foreign key|events_counter_id_fkey/i,
    );
    await client.query('rollback to savepoint author');
  });

  it('starts a session at assignments_version 0', async () => {
    // P2.3.5 §7. Every session already open when the column arrived gets `0`,
    // and a client that has never seen one sends `0` and is right until the
    // first change.
    const { rows } = await client.query(
      'select assignments_version from sessions where id = $1',
      [SESSION],
    );
    expect(rows[0].assignments_version).toBe(0);
  });

  it('takes the admin’s chain with the session, and refuses a repeated seq', async () => {
    await client.query(
      `insert into session_actions (id, session_id, seq, kind, payload, usuario,
                                    client_at, prev_hash, hash)
       values (gen_random_uuid(), $1, 1, 'retirar_contador', '{"nombre":"Luis"}', 'Marta',
               '2026-08-31T11:00:00.000Z', 'p', 'h')`,
      [SESSION],
    );
    // `unique (session_id, seq)` is what stops two admins writing action 1, and
    // it is a constraint rather than a check in a handler for the same reason
    // `unique (counter_id, seq)` is.
    await client.query('savepoint dup');
    await expect(
      client.query(
        `insert into session_actions (id, session_id, seq, kind, payload, usuario,
                                      client_at, prev_hash, hash)
         values (gen_random_uuid(), $1, 1, 'reasignar', '{}', 'Otro',
                 '2026-08-31T11:01:00.000Z', 'p', 'h2')`,
        [SESSION],
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
    await client.query('rollback to savepoint dup');

    // And `jsonb` really does hand the object back, which is what
    // `canonicalJson`'s key sorting exists to survive.
    const { rows } = await client.query(
      'select payload from session_actions where session_id = $1',
      [SESSION],
    );
    expect(rows[0].payload).toEqual({ nombre: 'Luis' });
  });

  it('defaults a session to the verified triple', async () => {
    const { rows } = await client.query(
      `select count_target_column, uncounted_policy, difference_column
       from sessions where id = $1`,
      [SESSION],
    );
    expect(rows[0]).toEqual({
      count_target_column: 'toma',
      uncounted_policy: 'existencia',
      difference_column: 'computed',
    });
  });
});
