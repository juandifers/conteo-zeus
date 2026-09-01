/**
 * Session creation and dispatch, end to end, against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set, like the schema suite beside it. What
 * needs a database rather than a stub is the whole point of these paths: the
 * catalogue has to come back out of `text[]` and `numeric` as the bytes and the
 * decimals it went in as, the unique constraint on a token has to be the thing
 * that refuses a collision, and `borrador -> abierto` has to be a transition
 * two admins cannot both win.
 */
// Must precede any import that reaches Dexie: Dexie binds the global
// indexedDB at module load, so a shim installed afterwards is too late. The
// last test in this file puts the *real* response through the *real* device
// store, which is the only way to assert what actually lands on a tablet.
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSession, listSessions } from '../../api/sessions/index';
import { deleteSession, getSession, updateSession } from '../../api/sessions/[id]/index';
import { dispatchSession } from '../../api/sessions/[id]/dispatch';
import { counterFetch } from '../../api/c/[token]';
import { dispatchStatements, fromBase64, loadCatalogue, toBase64 } from '../../api/_store';
import {
  COUNTER_COUNTER_FIELDS,
  COUNTER_ITEM_FIELDS,
  COUNTER_PAYLOAD_FIELDS,
  COUNTER_SECTION_FIELDS,
  COUNTER_SESSION_FIELDS,
  type Item,
} from '../../src/domain';
import { ingestZeusBytes, toWire } from '../../src/app';
import { encodeCp850, parseXls, reencode } from '../../src/zeus';
import { isTokenShaped } from '../../src/lib/token';
import { NEVER_SENT_TO_A_COUNTER, type CounterPayload } from '../../src/domain';
import { ConteoDb, DexieAssignmentStore } from '../../src/store';
import { readSample, SAMPLE_TXT, SAMPLE_XLS } from '../helpers';
import { openTestDb, type TestDb } from './pgDb';

const URL = process.env.DATABASE_URL;
const suite = URL ? describe : describe.skip;

let db: TestDb;

const XLS = readSample(SAMPLE_XLS);
/**
 * The same catalogue as a canonical `.txt`.
 *
 * Used wherever the test needs `source_bytes` to be something a catalogue can
 * be reassembled *into*: an OLE2 compound file cannot be rebuilt from 24 text
 * fields, and the sample `.txt` beside the `.xls` is the sheared one the §4.1
 * check refuses (DOMAIN.md, `catalogueFaults`). This is bodega 01's real 298
 * rows in the representation both sources share.
 */
const TXT = reencode(parseXls(XLS));

/** Deterministic ids, so a failure names a row rather than a uuid. */
function ids(prefix: string) {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`;
}

async function upload(bytes: Uint8Array, name = 'COMESTIBLES ALMACEN.xls') {
  const parsed = ingestZeusBytes(bytes);
  return createSession(
    db,
    {
      sourceBytesBase64: toBase64(bytes),
      sourceName: name,
      rows: parsed.rows.map(toWire),
    },
    { newId: ids('a') },
  );
}

/** A plan that covers the whole catalogue with two counters and three sections. */
function wholePlan(items: Item[]) {
  const third = Math.floor(items.length / 3);
  return {
    counters: [
      {
        nombre: 'Ana',
        secciones: [
          { nombre: 'ALMACEN', idarticulos: items.slice(0, third).map((i) => i.idarticulo) },
          { nombre: 'NEVERA', idarticulos: items.slice(third, third * 2).map((i) => i.idarticulo) },
        ],
      },
      {
        nombre: 'Luis',
        secciones: [
          { nombre: 'BAR', idarticulos: items.slice(third * 2).map((i) => i.idarticulo) },
        ],
      },
    ],
  };
}

suite('POST /api/sessions', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'a');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });

  it('stores the file and the whole catalogue, in one act', async () => {
    const result = await upload(XLS);
    expect(result.status).toBe(201);
    const body = result.body as { id: string; itemCount: number; bodega: string; familias: number };
    expect(body.bodega).toBe('01');
    expect(body.itemCount).toBe(298);
    expect(body.familias).toBe(11);

    const rows = await db.query<{ n: string }>('select count(*) as n from catalog_rows');
    expect(Number(rows[0].n)).toBe(298);
  });

  it('reassembles from Postgres to bytes identical to source_bytes', async () => {
    // The property everything downstream rests on. `writeTxt` re-emits 22
    // columns from `raw_row` and `verifyWriteBack` compares the emitted bytes
    // against the source they came from, so if a driver coerces a zero-padded
    // `codigo` to a number or a `text[]` drops an empty trailing field, it has
    // to surface here — not three tasks later, in an export, after a count.
    const result = await upload(TXT, 'COMESTIBLES ALMACEN.txt');
    const { id } = result.body as { id: string };

    const catalogue = await loadCatalogue(db, id);
    const reassembled = encodeCp850(
      catalogue.map((row) => `${row.rawRow.join('\t')}\r\n`).join(''),
    );

    const stored = await db.query<{ source_bytes: Buffer }>(
      'select source_bytes from sessions where id = $1',
      [id],
    );
    const source = new Uint8Array(stored[0].source_bytes);

    expect(reassembled.length).toBe(source.length);
    expect([...reassembled]).toEqual([...source]);
    // And the same bytes the session was hashed against.
    expect([...source]).toEqual([...TXT]);
  });

  it('keeps every empty field an empty string, not a null', async () => {
    // `Grupo1..5`, `ubicacion` and `serial` are empty in all 298 rows and are
    // re-emitted verbatim. A `text[]` that turned `''` into `null` would write
    // the four characters `NULL` into the ERP, or drop a tab.
    const { id } = (await upload(XLS)).body as { id: string };
    const catalogue = await loadCatalogue(db, id);
    for (const row of catalogue) {
      expect(row.rawRow).toHaveLength(24);
      expect(row.rawRow.every((field) => typeof field === 'string')).toBe(true);
    }
    const empties = catalogue.flatMap((row) => row.rawRow.filter((f) => f === ''));
    expect(empties.length).toBeGreaterThan(1000);
  });

  it('keeps the catalogue in source order rather than in key order', async () => {
    // Zeus does not always export ascending: the verified bodega 22 file is
    // 91069 then 15450 (ZEUS_FORMAT.md §7.5). A read ordered by the primary key
    // silently re-sorts the catalogue away from the shelf and the printed list.
    const { id } = (await upload(XLS)).body as { id: string };
    const catalogue = await loadCatalogue(db, id);
    const source = ingestZeusBytes(XLS).rows.map((row) => row.item.idarticulo);
    expect(catalogue.map((row) => row.item.idarticulo)).toEqual(source);
  });

  it('keeps quantities out of a float on the way in and out', async () => {
    const { id } = (await upload(XLS)).body as { id: string };
    const catalogue = await loadCatalogue(db, id);
    const source = new Map(
      ingestZeusBytes(XLS).rows.map((row) => [row.item.idarticulo, row.item]),
    );
    for (const row of catalogue) {
      const original = source.get(row.item.idarticulo)!;
      expect(row.item.existencia).toBe(original.existencia);
      expect(row.item.costo).toBe(original.costo);
      expect(row.item.ultimoConteo).toBe(original.ultimoConteo);
    }
    // 20.8 is the one that catches a float: `21 - 20.8` is
    // `0.20000000000000107` (ZEUS_FORMAT.md §3).
    expect(catalogue.some((row) => row.item.existencia === 20.8)).toBe(true);
  });

  it('stores the family prefix, and only when one was derived', async () => {
    const { id } = (await upload(XLS)).body as { id: string };
    const rows = await db.query<{ familia: string; codigo: string }>(
      'select familia, codigo from catalog_rows where session_id = $1',
      [id],
    );
    expect(rows.every((row) => row.familia === row.codigo.slice(2, 4))).toBe(true);
  });

  it('refuses a sheared file and persists nothing at all', async () => {
    // The sample `.txt` beside the `.xls` is the real one: same bodega, same
    // corte, and its `nombre` column has been sorted away from its keys.
    const sheared = readSample(SAMPLE_TXT);
    const result = await createSession(db, {
      sourceBytesBase64: toBase64(sheared),
      rows: [],
    });
    expect(result.status).toBe(422);
    const body = result.body as { error: string; detalle: { faults: unknown[] } };
    expect(body.error).toMatch(/columna de nombres|se contradice/);
    expect(body.detalle.faults.length).toBeGreaterThan(0);

    const rows = await db.query<{ n: string }>('select count(*) as n from sessions');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('refuses when the browser and the server read the file differently', async () => {
    // The cached-build case §1b exists for. The deployed build is the one that
    // will still be running when the count is posted, so the upload is refused
    // rather than quietly stored under the server's reading.
    const parsed = ingestZeusBytes(XLS);
    const rows = parsed.rows.map(toWire);
    rows[7] = { ...rows[7], nombre: 'ALGO QUE EL SERVIDOR NO LEE' };

    const result = await createSession(db, { sourceBytesBase64: toBase64(XLS), rows });
    expect(result.status).toBe(409);
    const body = result.body as { error: string; detalle: { differences: string[] } };
    expect(body.error).toMatch(/Recarga la página/);
    expect(body.detalle.differences[0]).toMatch(/nombre/);
    expect(Number((await db.query<{ n: string }>('select count(*) as n from sessions'))[0].n)).toBe(0);
  });

  it('refuses a posting parameter that does not exist', async () => {
    const result = await createSession(db, {
      sourceBytesBase64: toBase64(XLS),
      rows: [],
      parameters: { uncountedPolicy: 'existenca' as 'existencia' },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/uncountedPolicy/);
  });

  it('defaults to the verified triple and to showing the registrado mark', async () => {
    const { id } = (await upload(XLS)).body as { id: string };
    const shown = (await getSession(db, id)).body as {
      session: { parameters: unknown; mostrarMarcaRegistrado: boolean; parametrosVerificados: boolean };
    };
    expect(shown.session.parameters).toEqual({
      countTargetColumn: 'toma',
      uncountedPolicy: 'existencia',
      differenceColumn: 'computed',
    });
    expect(shown.session.parametrosVerificados).toBe(true);
    expect(shown.session.mostrarMarcaRegistrado).toBe(true);
  });

  it('lists what exists', async () => {
    await upload(XLS);
    const body = (await listSessions(db)).body as { sessions: { itemCount: number }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].itemCount).toBe(298);
  });
});

suite('dispatch', () => {
  let sessionId: string;
  let items: Item[];

  beforeAll(async () => {
    db = await openTestDb(URL!, 'a');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    sessionId = ((await upload(XLS)).body as { id: string }).id;
    items = ((await getSession(db, sessionId)).body as { items: Item[] }).items;
  });

  it('refuses a partition with a gap, and names the articles', async () => {
    const plan = wholePlan(items);
    plan.counters[1].secciones[0].idarticulos.pop();
    const result = await dispatchSession(db, sessionId, plan);
    expect(result.status).toBe(409);
    const blockers = (result.body as { detalle: { blockers: { kind: string; idarticulos: number[] }[] } })
      .detalle.blockers;
    const gap = blockers.find((blocker) => blocker.kind === 'sin-asignar')!;
    expect(gap.idarticulos).toEqual([items[items.length - 1].idarticulo]);

    // And nothing was written: a refused dispatch leaves a draft.
    const counters = await db.query<{ n: string }>('select count(*) as n from counters');
    expect(Number(counters[0].n)).toBe(0);
    const session = await db.query<{ estado: string }>('select estado from sessions where id = $1', [
      sessionId,
    ]);
    expect(session[0].estado).toBe('borrador');
  });

  it('refuses an article assigned to two counters', async () => {
    const plan = wholePlan(items);
    plan.counters[1].secciones[0].idarticulos.push(items[0].idarticulo);
    const result = await dispatchSession(db, sessionId, plan);
    expect(result.status).toBe(409);
    const blockers = (result.body as { detalle: { blockers: { kind: string }[] } }).detalle.blockers;
    expect(blockers.map((b) => b.kind)).toContain('doble-asignacion');
  });

  it('refuses a counter with nothing to count', async () => {
    const plan = wholePlan(items);
    plan.counters.push({ nombre: 'Marta', secciones: [] });
    const result = await dispatchSession(db, sessionId, plan);
    expect(result.status).toBe(409);
    expect(
      (result.body as { detalle: { blockers: { kind: string }[] } }).detalle.blockers.map((b) => b.kind),
    ).toContain('contador-vacio');
  });

  it('refuses two counters with the same name before minting anything', async () => {
    const plan = wholePlan(items);
    plan.counters[1].nombre = 'Ana';
    const result = await dispatchSession(db, sessionId, plan);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/dos contadores llamados «Ana»/);
  });

  it('refuses two sections with the same name — that name becomes a zona', async () => {
    const plan = wholePlan(items);
    plan.counters[1].secciones[0].nombre = 'ALMACEN';
    const result = await dispatchSession(db, sessionId, plan);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/dos secciones/);
  });

  it('refuses a session on untested posting parameters', async () => {
    await db.query("update sessions set uncounted_policy = 'zero' where id = $1", [sessionId]);
    const result = await dispatchSession(db, sessionId, wholePlan(items));
    expect(result.status).toBe(409);
    expect(
      (result.body as { detalle: { blockers: { kind: string }[] } }).detalle.blockers.map((b) => b.kind),
    ).toContain('parametros-sin-verificar');
  });

  it('refuses a session whose stored file no longer hashes to what it was', async () => {
    await db.query("update sessions set source_hash = $2 where id = $1", [sessionId, 'f'.repeat(64)]);
    const result = await dispatchSession(db, sessionId, wholePlan(items));
    expect(
      (result.body as { detalle: { blockers: { kind: string }[] } }).detalle.blockers.map((b) => b.kind),
    ).toContain('archivo-cambiado');
  });

  it('opens the session, mints one token per counter, and covers everything', async () => {
    const result = await dispatchSession(db, sessionId, wholePlan(items));
    expect(result.status).toBe(200);
    const body = result.body as {
      counters: { id: string; nombre: string; token: string; articulos: number }[];
    };
    expect(body.counters.map((c) => c.nombre)).toEqual(['Ana', 'Luis']);
    expect(body.counters.reduce((total, c) => total + c.articulos, 0)).toBe(items.length);

    for (const counter of body.counters) {
      expect(isTokenShaped(counter.token)).toBe(true);
    }
    expect(new Set(body.counters.map((c) => c.token)).size).toBe(2);

    const session = await db.query<{ estado: string; dispatched_at: Date }>(
      'select estado, dispatched_at from sessions where id = $1',
      [sessionId],
    );
    expect(session[0].estado).toBe('abierto');
    expect(session[0].dispatched_at).not.toBeNull();

    const assignments = await db.query<{ n: string }>(
      'select count(*) as n from assignments where session_id = $1',
      [sessionId],
    );
    expect(Number(assignments[0].n)).toBe(items.length);
  });

  it('is the only transition: an open session cannot be dispatched again', async () => {
    await dispatchSession(db, sessionId, wholePlan(items));
    const again = await dispatchSession(db, sessionId, wholePlan(items));
    expect(again.status).toBe(409);
    expect(
      (again.body as { detalle: { blockers: { kind: string }[] } }).detalle.blockers.map((b) => b.kind),
    ).toContain('estado');

    // The first dispatch's tokens still work, which is the thing that matters:
    // re-minting under counters already holding links is the failure mode.
    const counters = await db.query<{ n: string }>(
      'select count(*) as n from counters where session_id = $1',
      [sessionId],
    );
    expect(Number(counters[0].n)).toBe(2);
  });

  it('replaces a draft partition rather than adding to it', async () => {
    // The admin who pressed dispatch, saw a blocker, fixed it and pressed
    // again must end up with one set of counters.
    const plan = wholePlan(items);
    plan.counters.push({ nombre: 'Marta', secciones: [] });
    await dispatchSession(db, sessionId, plan);
    await dispatchSession(db, sessionId, wholePlan(items));
    const counters = await db.query<{ nombre: string }>(
      'select nombre from counters where session_id = $1 order by nombre',
      [sessionId],
    );
    expect(counters.map((c) => c.nombre)).toEqual(['Ana', 'Luis']);
  });

  it('is guarded in the SQL too, not only by the handler that calls it', async () => {
    // `dispatchBlockers` refuses an open session before the transaction is
    // built, so this reaches past it to the statements themselves. Two admins
    // on two laptops is the case: without the guard the loser's deletes and
    // inserts land, the final `update … where estado = 'borrador'` matches
    // nothing, no error is raised, and the batch commits — leaving the winner's
    // counters replaced by tokens nobody printed.
    await dispatchSession(db, sessionId, wholePlan(items));
    const before = await db.query<{ id: string; token: string }>(
      'select id, token from counters where session_id = $1 order by nombre',
      [sessionId],
    );

    const results = await db.transaction(
      dispatchStatements(
        sessionId,
        {
          counters: [{ id: ids('b')(), nombre: 'Intruso', token: 'x'.repeat(22) }],
          sections: [],
          assignments: [],
        },
        '2026-08-31T16:00:00.000Z',
      ),
    );
    expect(results[results.length - 1]).toHaveLength(0);

    const after = await db.query<{ id: string; token: string }>(
      'select id, token from counters where session_id = $1 order by nombre',
      [sessionId],
    );
    expect(after).toEqual(before);
  });

  it('stores the resolved assignment per article, not the rule behind it', async () => {
    // A rule re-evaluated later against a changed catalogue is a silent
    // reassignment nobody authorised.
    await dispatchSession(db, sessionId, wholePlan(items));
    const rows = await db.query<{ idarticulo: number; section_id: string }>(
      'select idarticulo, section_id from assignments where session_id = $1',
      [sessionId],
    );
    expect(rows).toHaveLength(items.length);
    expect(new Set(rows.map((row) => row.idarticulo)).size).toBe(items.length);
    expect(rows.every((row) => row.section_id !== null)).toBe(true);
  });
});

suite('GET /api/c/:token', () => {
  let sessionId: string;
  let items: Item[];
  let tokens: { nombre: string; token: string; id: string }[];

  beforeAll(async () => {
    db = await openTestDb(URL!, 'a');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    sessionId = ((await upload(XLS)).body as { id: string }).id;
    items = ((await getSession(db, sessionId)).body as { items: Item[] }).items;
    const dispatched = await dispatchSession(db, sessionId, wholePlan(items));
    tokens = (dispatched.body as { counters: typeof tokens }).counters;
  });

  it('serves exactly the allowlist, at every level of nesting', async () => {
    const result = await counterFetch(db, tokens[0].token);
    expect(result.status).toBe(200);
    const payload = JSON.parse(JSON.stringify(result.body)) as Record<string, unknown>;

    const seen = new Map<string, Set<string>>();
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, `${path}[]`);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const keys = seen.get(path) ?? new Set<string>();
      for (const key of Object.keys(value)) {
        keys.add(key);
        walk((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
      seen.set(path, keys);
    };
    walk(payload, '$');

    const expected: Record<string, readonly string[]> = {
      $: COUNTER_PAYLOAD_FIELDS,
      '$.session': COUNTER_SESSION_FIELDS,
      '$.counter': COUNTER_COUNTER_FIELDS,
      '$.secciones[]': COUNTER_SECTION_FIELDS,
      '$.secciones[].items[]': COUNTER_ITEM_FIELDS,
    };
    expect([...seen.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [path, allowed] of Object.entries(expected)) {
      expect([...seen.get(path)!].sort()).toEqual([...allowed].sort());
    }
  });

  it('carries no value equal to a book quantity or a cost', async () => {
    const result = await counterFetch(db, tokens[0].token);
    const payload = JSON.parse(JSON.stringify(result.body)) as {
      secciones: { items: Record<string, unknown>[] }[];
    };
    const byId = new Map(items.map((item) => [item.idarticulo, item]));

    let checked = 0;
    for (const section of payload.secciones) {
      for (const article of section.items) {
        const source = byId.get(article.idarticulo as number)!;
        const values = Object.values(article);
        for (const forbidden of [source.existencia, source.costo, source.ultimoConteo]) {
          if (forbidden === null) continue;
          expect(values).not.toContain(forbidden);
          expect(values).not.toContain(String(forbidden));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('and none of it survives the trip onto the tablet', async () => {
    /**
     * The same leak test, run against **what actually landed on the device**.
     *
     * The two assertions above are about the response. This one is about the
     * artefact: the response goes through the real `AssignmentStore` into a
     * real IndexedDB, comes back out, and is walked again. A store that spread
     * the payload together with something else, or a schema upgrade that merged
     * two tables, would leave the projection perfectly correct and the tablet
     * holding `existencia` anyway — and the tablet is what a counter's screen
     * renders from.
     *
     * `counterAssignments` is also a *durable* table: a figure that reaches it
     * stays on that tablet across sessions, across upgrades, and until somebody
     * clears site data.
     */
    const result = await counterFetch(db, tokens[0].token);
    // Through JSON, because that is what crosses the wire.
    const overTheWire = JSON.parse(JSON.stringify(result.body)) as CounterPayload;

    const device = new ConteoDb(`landed-${Math.random().toString(36).slice(2)}`);
    const store = new DexieAssignmentStore(device);
    await store.save(tokens[0].token, overTheWire, '2026-08-31T12:00:00.000Z');
    const row = await store.load(tokens[0].token);
    expect(row).not.toBeNull();

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return void value.forEach(walk);
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    };
    // The whole row, not only the payload: the wrapper carries `token`,
    // `sessionId`, `counterId` and `fetchedAt`, and a future column on that
    // table is exactly as durable as one inside the payload.
    walk(row);
    for (const forbidden of NEVER_SENT_TO_A_COUNTER) {
      expect(keys.has(forbidden), `the tablet is holding ${forbidden}`).toBe(false);
    }
    expect(Object.keys(row!.payload).sort()).toEqual([...COUNTER_PAYLOAD_FIELDS].sort());
    for (const section of row!.payload.secciones) {
      for (const article of section.items) {
        expect(Object.keys(article).sort()).toEqual([...COUNTER_ITEM_FIELDS].sort());
      }
    }
    device.close();
  });

  it('serves only this counter’s articles, grouped into their sections', async () => {
    const ana = (await counterFetch(db, tokens[0].token)).body as {
      counter: { nombre: string };
      secciones: { nombre: string; items: { idarticulo: number }[] }[];
    };
    expect(ana.counter.nombre).toBe('Ana');
    expect(ana.secciones.map((s) => s.nombre)).toEqual(['ALMACEN', 'NEVERA']);

    const luis = (await counterFetch(db, tokens[1].token)).body as {
      secciones: { items: { idarticulo: number }[] }[];
    };
    const mine = new Set(ana.secciones.flatMap((s) => s.items.map((i) => i.idarticulo)));
    const theirs = luis.secciones.flatMap((s) => s.items.map((i) => i.idarticulo));
    expect(theirs.some((id) => mine.has(id))).toBe(false);
    expect(mine.size + theirs.length).toBe(items.length);
  });

  it('is enough on its own: one fetch loads the whole assignment', async () => {
    // The tablet is prepared on office wifi and then walks into a bodega with
    // no signal. Anything not in this response is not available again.
    const ana = (await counterFetch(db, tokens[0].token)).body as {
      secciones: { items: { idarticulo: number; nombre: string; codigo: string; unidad: string }[] }[];
    };
    const delivered = ana.secciones.flatMap((s) => s.items);
    expect(delivered.length).toBeGreaterThan(100);
    for (const article of delivered) {
      expect(article.nombre).not.toBe('');
      expect(article.codigo).toHaveLength(7);
      expect(article.unidad).not.toBe('');
    }
  });

  it('records that the device fetched, and how many times', async () => {
    await counterFetch(db, tokens[0].token, { now: () => '2026-08-31T15:00:00.000Z' });
    await counterFetch(db, tokens[0].token, { now: () => '2026-08-31T15:05:00.000Z' });

    const shown = (await getSession(db, sessionId)).body as {
      counters: { nombre: string; fetchedAt: string | null; fetchCount: number }[];
    };
    const ana = shown.counters.find((c) => c.nombre === 'Ana')!;
    const luis = shown.counters.find((c) => c.nombre === 'Luis')!;
    expect(ana.fetchCount).toBe(2);
    expect(ana.fetchedAt).toContain('2026-08-31T15:05');
    // The one nobody has loaded. This is the whole reason the column exists.
    expect(luis.fetchedAt).toBeNull();
    expect(luis.fetchCount).toBe(0);
  });

  it('answers a malformed token and an unknown one the same way', async () => {
    // Telling them apart is telling somebody their guess had the right shape.
    const malformed = await counterFetch(db, 'ana');
    const unknown = await counterFetch(db, 'A'.repeat(22));
    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.body).toEqual(unknown.body);
  });

  it('refuses a session that is still a draft', async () => {
    await db.query("update sessions set estado = 'borrador' where id = $1", [sessionId]);
    const result = await counterFetch(db, tokens[0].token);
    expect(result.status).toBe(409);
  });

  it('reflects the registrado toggle without a deploy', async () => {
    await updateSession(db, sessionId, { mostrarMarcaRegistrado: false });
    const payload = (await counterFetch(db, tokens[0].token)).body as {
      session: { mostrarMarcaRegistrado: boolean };
    };
    expect(payload.session.mostrarMarcaRegistrado).toBe(false);
  });

  it('never returns the token it was called with', async () => {
    const result = await counterFetch(db, tokens[0].token);
    expect(JSON.stringify(result.body)).not.toContain(tokens[0].token);
  });
});

suite('DELETE /api/sessions/:id', () => {
  let sessionId: string;
  let items: Item[];

  beforeAll(async () => {
    db = await openTestDb(URL!, 'a');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    const created = await upload(XLS);
    sessionId = (created.body as { id: string }).id;
    items = (await loadCatalogue(db, sessionId)).map((row) => row.item);
  });

  it('deletes a draft, file and catalogue included', async () => {
    const result = await deleteSession(db, sessionId);
    expect(result.status).toBe(200);
    expect((await getSession(db, sessionId)).status).toBe(404);
    const rows = await db.query('select 1 from catalog_rows where session_id = $1', [sessionId]);
    expect(rows).toHaveLength(0);
  });

  it('takes a dispatched session and everything under it in one cascade', async () => {
    // The 0003 migration exists for exactly this delete: `assignments`
    // references both `counters` and `catalog_rows`, and without its cascade
    // fix the two paths raced and the whole statement failed.
    await dispatchSession(db, sessionId, wholePlan(items));
    const result = await deleteSession(db, sessionId);
    expect(result.status).toBe(200);
    for (const table of ['counters', 'sections', 'assignments', 'catalog_rows']) {
      const rows = await db.query(`select 1 from ${table} where session_id = $1`, [sessionId]);
      expect(rows, table).toHaveLength(0);
    }
  });

  it('refuses a sealed session — the acta cites it', async () => {
    await db.query(`update sessions set estado = 'sellado' where id = $1`, [sessionId]);
    const result = await deleteSession(db, sessionId);
    expect(result.status).toBe(409);
    expect((await getSession(db, sessionId)).status).toBe(200);
  });

  it('answers an unknown id with 404, not with success', async () => {
    const result = await deleteSession(db, 'a9999999-0000-4000-8000-000000000000');
    expect(result.status).toBe(404);
  });
});

suite('base64 in and out', () => {
  it('round-trips arbitrary bytes, including the ones a text codec would break', async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    for (let length = 0; length < 8; length++) {
      const short = bytes.subarray(0, length);
      expect([...fromBase64(toBase64(short))]).toEqual([...short]);
    }
  });
});
