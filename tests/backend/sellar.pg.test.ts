/**
 * Sellar, generar, cerrar — P2.5, against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set, like the suites beside it. What needs a
 * database here is the whole of the task's load-bearing claim:
 *
 *   - the **ordering** is enforced by SQL predicates, not by a state variable
 *     in a handler — `estado = 'sellado'`, `session_hash is null`,
 *     `export_bytes is null`, and the guard on the action chain being exactly
 *     where the hash was taken over;
 *   - **nothing can be appended between the seal and the export**, and that is
 *     a property of the insert's predicate plus a row lock, which nothing that
 *     mocks the driver can exercise;
 *   - `export_bytes` is a real `bytea` round trip, and a re-download that came
 *     back as a `\x…` string would be a file twice the size and entirely wrong.
 */
// Must precede any import that reaches Dexie: Dexie binds the global
// `indexedDB` at module load, so a shim installed afterwards is too late.
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSession } from '../../api/sessions/index';
import { dispatchSession } from '../../api/sessions/[id]/dispatch';
import { postAction } from '../../api/sessions/[id]/acciones';
import { sealSession } from '../../api/sessions/[id]/sellar';
import { downloadExport, exportSession } from '../../api/sessions/[id]/exportar';
import { sessionBundle } from '../../api/sessions/[id]/bundle';
import { sessionSync } from '../../api/sessions/[id]/sync';
import { counterFetch } from '../../api/c/[token]';
import { pushEvents } from '../../api/c/[token]/events';
import { loadExportBytes, toBase64 } from '../../api/_store';
import {
  actionGenesisHash,
  chainHash,
  genesisHash,
  sessionHash,
  type ChainedEvent,
  type CountEvent,
  type SealBlocker,
} from '../../src/domain';
import { ingestZeusBytes, toWire, type SessionBundle } from '../../src/app';
import { parseTxt, parseXls, reencode } from '../../src/zeus';
import { fromBase64 } from '../../src/lib/base64';
import { sha256Hex } from '../../src/lib/hash';
import { readSample, SAMPLE_XLS } from '../helpers';
import { openTestDb, type TestDb } from './pgDb';

const URL = process.env.DATABASE_URL;
const suite = URL ? describe : describe.skip;

let db: TestDb;
const TXT = reencode(parseXls(readSample(SAMPLE_XLS)));

/** Deterministic uuids. The prefix must be **hex**: these become `uuid` columns. */
function ids(prefix: string) {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`;
}

const EPOCH = Date.UTC(2026, 8, 1, 14, 0, 0);
const NOW = new Date(EPOCH).toISOString();

interface Fixture {
  sessionId: string;
  ana: { id: string; token: string };
  luis: { id: string; token: string };
  idarticulos: number[];
  /** Ana's half of the bodega, then Luis's. */
  suyosAna: number[];
  suyosLuis: number[];
}

async function dispatched(): Promise<Fixture> {
  const parsed = ingestZeusBytes(TXT);
  const created = await createSession(
    db,
    {
      sourceBytesBase64: toBase64(TXT),
      sourceName: 'COMESTIBLES ALMACEN.txt',
      rows: parsed.rows.map(toWire),
    },
    { newId: ids('f') },
  );
  const sessionId = (created.body as { id: string }).id;
  const idarticulos = parsed.rows.map((row) => row.item.idarticulo);
  const half = Math.floor(idarticulos.length / 2);

  const result = await dispatchSession(
    db,
    sessionId,
    {
      counters: [
        { nombre: 'Ana', secciones: [{ nombre: 'ALMACEN', idarticulos: idarticulos.slice(0, half) }] },
        { nombre: 'Luis', secciones: [{ nombre: 'BAR', idarticulos: idarticulos.slice(half) }] },
      ],
    },
    { newId: ids('a') },
  );
  expect(result.status).toBe(200);
  const body = result.body as { counters: { id: string; nombre: string; token: string }[] };

  // Both tablets pull their assignment on office wifi, which is what P2.1 says
  // has to happen before anybody walks into the bodega — and what stops
  // `contador-sin-descargar` from blocking every seal in this file.
  for (const counter of body.counters) await counterFetch(db, counter.token);

  return {
    sessionId,
    ana: body.counters.find((c) => c.nombre === 'Ana')!,
    luis: body.counters.find((c) => c.nombre === 'Luis')!,
    idarticulos,
    suyosAna: idarticulos.slice(0, half),
    suyosLuis: idarticulos.slice(half),
  };
}

interface Spec {
  kind: CountEvent['kind'];
  idarticulo?: number | null;
  qty?: number;
  finalSeq?: number;
  headHash?: string;
}

let eventCounter = 0;
const eventId = () => `e${String(++eventCounter).padStart(7, '0')}-0000-4000-8000-000000000000`;

function chainFor(
  sessionId: string,
  counterId: string,
  specs: readonly Spec[],
  options: { startSeq?: number; head?: string; zona?: string } = {},
): ChainedEvent[] {
  let prev = options.head ?? genesisHash(sessionId, counterId);
  let seq = options.startSeq ?? 1;
  const links: ChainedEvent[] = [];
  for (const spec of specs) {
    const event = {
      id: eventId(),
      sessionId,
      counterId,
      usuario: 'quien sea',
      zona: options.zona ?? 'ALMACEN',
      at: new Date(EPOCH + seq * 1000).toISOString(),
      deviceId: 'tablet-a',
      seq,
      kind: spec.kind,
      idarticulo: spec.idarticulo ?? null,
      ...(spec.qty === undefined ? {} : { qty: spec.qty }),
      ...(spec.finalSeq === undefined ? {} : { finalSeq: spec.finalSeq }),
      ...(spec.headHash === undefined ? {} : { headHash: spec.headHash }),
    } as CountEvent;
    const hash = chainHash(prev, event);
    links.push({ event, prevHash: prev, hash });
    prev = hash;
    seq++;
  }
  return links;
}

function finishAfter(sessionId: string, counterId: string, links: readonly ChainedEvent[]) {
  const head = links.length === 0 ? genesisHash(sessionId, counterId) : links[links.length - 1].hash;
  const finalSeq = links.length === 0 ? 0 : links[links.length - 1].event.seq;
  return chainFor(
    sessionId,
    counterId,
    [{ kind: 'finish', idarticulo: null, finalSeq, headHash: head }],
    { startSeq: finalSeq + 1, head },
  );
}

/**
 * Both counters count a little and both finish, so `sessionReadyToSeal` is
 * empty. Ana counts three articles including one explicit zero; Luis counts one.
 */
async function counted(fixture: Fixture): Promise<void> {
  const anaLinks = chainFor(fixture.sessionId, fixture.ana.id, [
    { kind: 'add', idarticulo: fixture.suyosAna[0], qty: 7 },
    // An explicit zero on a row the ERP believes holds something. It is a stock
    // deletion under ZEUS_FORMAT.md §7.4, and the reason G2 is re-run here.
    { kind: 'add', idarticulo: fixture.suyosAna[1], qty: 0 },
  ]);
  const anaAll = [...anaLinks, ...finishAfter(fixture.sessionId, fixture.ana.id, anaLinks)];
  expect((await pushEvents(db, fixture.ana.token, { events: anaAll })).status).toBe(200);

  const luisLinks = chainFor(
    fixture.sessionId,
    fixture.luis.id,
    [{ kind: 'add', idarticulo: fixture.suyosLuis[0], qty: 3 }],
    { zona: 'BAR' },
  );
  const luisAll = [...luisLinks, ...finishAfter(fixture.sessionId, fixture.luis.id, luisLinks)];
  expect((await pushEvents(db, fixture.luis.token, { events: luisAll })).status).toBe(200);
}

async function ready(): Promise<Fixture> {
  const fixture = await dispatched();
  await counted(fixture);
  return fixture;
}

const seal = (sessionId: string, body: unknown = {}) =>
  sealSession(db, sessionId, body, { now: () => NOW, newId: ids('b') });

const estadoOf = async (sessionId: string) =>
  (
    await db.query<{ estado: string }>('select estado from sessions where id = $1', [sessionId])
  )[0].estado;

const detail = (result: { body: unknown }) =>
  (result.body as { detalle?: { code?: string; blockers?: SealBlocker[] } }).detalle;

suite('POST /api/sessions/:id/sellar', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'f');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    eventCounter = 0;
  });

  describe('the gate', () => {
    it('refuses while somebody has not finished', async () => {
      const fixture = await dispatched();
      const result = await seal(fixture.sessionId);
      expect(result.status).toBe(409);
      expect(detail(result)!.code).toBe('NOT_READY');
      // Both counters, each with their own reason, and never only the first:
      // an admin chasing tablets at five o'clock needs the list.
      expect(detail(result)!.blockers!.length).toBeGreaterThanOrEqual(2);
      expect(await estadoOf(fixture.sessionId)).toBe('abierto');
    });

    it('refuses on a fork, which retirement does not waive', async () => {
      const fixture = await ready();
      await db.query('update counters set forked = true where id = $1', [fixture.ana.id]);
      const result = await seal(fixture.sessionId);
      expect(result.status).toBe(409);
      expect(detail(result)!.blockers!.map((b) => b.kind)).toContain('contador-bifurcado');
    });

    it('refuses on a tablet that never downloaded its assignment', async () => {
      const fixture = await ready();
      await db.query('update counters set fetched_at = null where id = $1', [fixture.luis.id]);
      const result = await seal(fixture.sessionId);
      expect(detail(result)!.blockers!.map((b) => b.kind)).toContain('contador-sin-descargar');
    });

    it('refuses on a retired counter whose chain has a hole', async () => {
      const fixture = await ready();
      // Luis leaves, and one of his events never arrives. The hole is what the
      // gate sees; `retirado` alone would not block.
      await db.query('delete from assignments where counter_id = $1', [fixture.luis.id]);
      await db.query(`update counters set estado = 'retirado' where id = $1`, [fixture.luis.id]);
      await db.query('delete from events where counter_id = $1 and seq = 1', [fixture.luis.id]);

      const result = await seal(fixture.sessionId);
      expect(result.status).toBe(409);
      expect(detail(result)!.blockers!.map((b) => b.kind)).toContain(
        'contador-retirado-incompleto',
      );
      expect(await estadoOf(fixture.sessionId)).toBe('abierto');
    });

    it('has no force flag: the only way past is a signature on the chain', async () => {
      const fixture = await ready();
      await db.query('delete from assignments where counter_id = $1', [fixture.luis.id]);
      await db.query(`update counters set estado = 'retirado' where id = $1`, [fixture.luis.id]);
      await db.query('delete from events where counter_id = $1 and seq = 1', [fixture.luis.id]);

      // Nothing in the body forces it. `force`, `skip`, an override without a
      // reason: all of them are just a seal that is still refused.
      expect((await seal(fixture.sessionId, { force: true })).status).toBe(409);
      expect(
        (await seal(fixture.sessionId, { sinRegistros: { counterId: fixture.luis.id, usuario: '', motivo: 'x' } }))
          .status,
      ).toBe(400);

      const signed = await seal(fixture.sessionId, {
        sinRegistros: {
          counterId: fixture.luis.id,
          usuario: 'Marta',
          motivo: 'la tableta se quedó en el bus',
        },
      });
      expect(signed.status).toBe(200);
      expect(await estadoOf(fixture.sessionId)).toBe('sellado');

      // §1a: recorded **and** sealed in one transaction, the action first, so
      // the record of whose work was skipped is inside the chain the hash covers.
      const actions = await db.query<{ kind: string; payload: { faltan: string } }>(
        'select kind, payload from session_actions where session_id = $1 order by seq',
        [fixture.sessionId],
      );
      expect(actions.map((a) => a.kind)).toEqual(['sellar_sin_registros']);
      expect(actions[0].payload.faltan).toBe('1');
    });
  });

  describe('the seal itself', () => {
    it('records a hash that covers both chains and the catalogue', async () => {
      const fixture = await ready();
      await postAction(
        db,
        fixture.sessionId,
        { kind: 'waiver', usuario: 'Marta', motivo: 'no alcanzó el turno', idarticulo: [fixture.suyosAna[5]] },
        { now: () => NOW, newId: ids('c') },
      );
      expect((await seal(fixture.sessionId)).status).toBe(200);

      const row = (
        await db.query<{ session_hash: string; source_hash: string; sealed_at: string }>(
          'select session_hash, source_hash, sealed_at from sessions where id = $1',
          [fixture.sessionId],
        )
      )[0];

      const counters = await db.query<{ id: string; head_hash: string; max: number }>(
        `select c.id, c.head_hash,
                coalesce((select max(seq) from events e where e.counter_id = c.id), 0) as max
         from counters c where c.session_id = $1`,
        [fixture.sessionId],
      );
      const actions = await db.query<{ seq: number; hash: string }>(
        'select seq, hash from session_actions where session_id = $1 order by seq',
        [fixture.sessionId],
      );
      const last = actions[actions.length - 1];

      // Recomputed from what is stored, with the same module the handler used
      // — there is exactly one implementation of this hash, and this is the
      // assertion that it was fed the right things.
      expect(row.session_hash).toBe(
        sessionHash({
          sessionId: fixture.sessionId,
          sourceHash: row.source_hash,
          counters: counters.map((c) => ({
            counterId: c.id,
            maxSeq: Number(c.max),
            headHash: c.head_hash ?? genesisHash(fixture.sessionId, c.id),
          })),
          actionHead: last ? last.hash : actionGenesisHash(fixture.sessionId),
          actionMaxSeq: last ? last.seq : 0,
        }),
      );
      expect(row.sealed_at).toBeTruthy();
    });

    it('refuses a second seal', async () => {
      const fixture = await ready();
      expect((await seal(fixture.sessionId)).status).toBe(200);
      const again = await seal(fixture.sessionId);
      expect(again.status).toBe(409);
      expect(detail(again)!.code).toBe('NOT_SEALABLE');
    });
  });

  describe('sellado freezes both chains', () => {
    it('refuses every admin action kind, not only reassignment', async () => {
      const fixture = await ready();
      expect((await seal(fixture.sessionId)).status).toBe(200);

      const kinds: unknown[] = [
        { kind: 'reasignar', usuario: 'Marta', motivo: 'x', version: 0, moves: [] },
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'x', counterId: fixture.luis.id },
        { kind: 'sellar_sin_registros', usuario: 'Marta', motivo: 'x', counterId: fixture.luis.id },
        { kind: 'waiver', usuario: 'Marta', motivo: 'x', idarticulo: [fixture.suyosAna[9]] },
        { kind: 'anular_waiver', usuario: 'Marta', motivo: 'x', waiverId: fixture.sessionId },
      ];
      for (const body of kinds) {
        const result = await postAction(db, fixture.sessionId, body, {
          now: () => NOW,
          newId: ids('d'),
        });
        // A waiver after the seal would change what the file should say about a
        // row the hash already covers. It is refused for the same reason a
        // reassignment is, and by the same predicate.
        expect(result.status).toBe(409);
        expect((result.body as { detalle: { code: string } }).detalle.code).toBe(
          'SESSION_NOT_OPEN',
        );
      }
      const actions = await db.query('select id from session_actions where session_id = $1', [
        fixture.sessionId,
      ]);
      expect(actions).toEqual([]);
    });

    it('refuses a counter push, and the guard is in the insert as well as the handler', async () => {
      const fixture = await ready();
      const more = chainFor(
        fixture.sessionId,
        fixture.ana.id,
        [{ kind: 'add', idarticulo: fixture.suyosAna[3], qty: 2 }],
        { startSeq: 4, head: (await headOf(fixture.ana.id))! },
      );
      expect((await seal(fixture.sessionId)).status).toBe(200);

      const pushed = await pushEvents(db, fixture.ana.token, { events: more });
      expect(pushed.status).toBe(409);
      expect((pushed.body as { detalle: { code: string } }).detalle.code).toBe('SESSION_SEALED');
      // And nothing landed. The predicate on the insert is what makes this true
      // under a race the handler's own read cannot see.
      const rows = await db.query('select id from events where counter_id = $1 and seq = 4', [
        fixture.ana.id,
      ]);
      expect(rows).toEqual([]);
    });

    it('nothing was appended between the seal and the export', async () => {
      const fixture = await ready();
      expect((await seal(fixture.sessionId)).status).toBe(200);

      // Assert by attempting, not by asserting a state variable: every writer
      // in the system is invited to write, and every one of them refuses.
      const before = await counts(fixture.sessionId);
      await pushEvents(db, fixture.ana.token, {
        events: chainFor(
          fixture.sessionId,
          fixture.ana.id,
          [{ kind: 'add', idarticulo: fixture.suyosAna[3], qty: 2 }],
          { startSeq: 4, head: (await headOf(fixture.ana.id))! },
        ),
      });
      await postAction(
        db,
        fixture.sessionId,
        { kind: 'waiver', usuario: 'Marta', motivo: 'x', idarticulo: [fixture.suyosAna[9]] },
        { now: () => NOW, newId: ids('d') },
      );
      expect(await counts(fixture.sessionId)).toEqual(before);

      const exported = await exportSession(db, fixture.sessionId);
      expect(exported.status).toBe(200);
      expect(await counts(fixture.sessionId)).toEqual(before);
    });
  });
});

suite('POST /api/sessions/:id/exportar', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'f');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    eventCounter = 0;
  });

  it('refuses from an open session and from a closed one', async () => {
    const fixture = await ready();
    const early = await exportSession(db, fixture.sessionId);
    expect(early.status).toBe(409);
    expect(detail(early)!.code).toBe('NOT_SEALED');

    expect((await seal(fixture.sessionId)).status).toBe(200);
    expect((await exportSession(db, fixture.sessionId)).status).toBe(200);

    const again = await exportSession(db, fixture.sessionId);
    expect(again.status).toBe(409);
    expect(detail(again)!.code).toBe('NOT_SEALED');
    // Generation happens once. A second run would be a second `file_hash` for a
    // session whose acta names the first, and the honest name for that is two
    // files.
    expect(await estadoOf(fixture.sessionId)).toBe('cerrado');
  });

  it('stores the bytes it hashed, and a re-download is byte-identical', async () => {
    const fixture = await ready();
    await seal(fixture.sessionId);
    const result = await exportSession(db, fixture.sessionId);
    const body = result.body as { fileHash: string; filename: string; filas: number };

    const stored = (await loadExportBytes(db, fixture.sessionId))!;
    expect(sha256Hex(stored)).toBe(body.fileHash);
    // The hash prefix is what makes «which one did I upload» answerable for
    // somebody with four .txt files in a Downloads folder.
    expect(body.filename).toBe(
      `AJUSTE_${await label(fixture.sessionId)}_${body.fileHash.slice(0, 8)}.txt`,
    );

    const first = await downloadExport(db, fixture.sessionId);
    const second = await downloadExport(db, fixture.sessionId);
    expect((first.body as { base64: string }).base64).toBe(
      (second.body as { base64: string }).base64,
    );
    expect([...fromBase64((first.body as { base64: string }).base64)]).toEqual([...stored]);
  });

  it('writes `existencia` into `toma` for every row nobody reached — G2', async () => {
    const fixture = await ready();
    await seal(fixture.sessionId);
    await exportSession(db, fixture.sessionId);

    const file = parseTxt((await loadExportBytes(db, fixture.sessionId))!);
    const source = parseTxt(TXT);
    expect(file.items.length).toBe(source.items.length);

    // Counted: Ana's 7, Ana's explicit 0, Luis's 3. Everything else carries the
    // book figure, which is the branch ZEUS_FORMAT.md §7 records as inferred
    // rather than observed — the whole subject of this task's G2.
    const counted = new Map([
      [fixture.suyosAna[0], 7],
      [fixture.suyosAna[1], 0],
      [fixture.suyosLuis[0], 3],
    ]);
    for (const [index, item] of file.items.entries()) {
      const expected = counted.has(item.idarticulo)
        ? counted.get(item.idarticulo)!
        : source.items[index].existencia;
      expect({ id: item.idarticulo, toma: item.toma }).toEqual({
        id: source.items[index].idarticulo,
        toma: expected,
      });
    }
  });

  it('emits a zero only where a count was zero or the balance already was — G2', async () => {
    // P2.0's property, re-run over a whole session rather than a fixture: a
    // zero in the count column is a stock deletion (§7.4), so every one of them
    // must trace to an explicit `add(0)` or to `existencia` already being zero.
    const fixture = await ready();
    await seal(fixture.sessionId);
    await exportSession(db, fixture.sessionId);

    const file = parseTxt((await loadExportBytes(db, fixture.sessionId))!);
    const source = parseTxt(TXT);
    const emptyBalance = new Set(
      source.items.filter((item) => item.existencia === 0).map((item) => item.idarticulo),
    );
    const zeroed = file.items.filter((item) => item.toma === 0).map((item) => item.idarticulo);
    const explicit = zeroed.filter((id) => !emptyBalance.has(id));

    // Set equality, not a subset: one extra id here is a row whose stock this
    // file deletes and nobody asked it to.
    expect(explicit).toEqual([fixture.suyosAna[1]]);
    expect(new Set([...zeroed, ...emptyBalance])).toEqual(
      new Set([...emptyBalance, fixture.suyosAna[1]]),
    );
  });

  it('makes a waived row indistinguishable from an untouched one in the file', async () => {
    const fixture = await ready();
    const waived = fixture.suyosAna[20];
    const untouched = fixture.suyosAna[21];
    await postAction(
      db,
      fixture.sessionId,
      { kind: 'waiver', usuario: 'Marta', motivo: 'no alcanzó el turno', idarticulo: [waived] },
      { now: () => NOW, newId: ids('c') },
    );
    await seal(fixture.sessionId);
    await exportSession(db, fixture.sessionId);

    const file = parseTxt((await loadExportBytes(db, fixture.sessionId))!);
    const row = (id: number) => file.items.find((item) => item.idarticulo === id)!;
    const source = parseTxt(TXT);
    const book = (id: number) => source.items.find((item) => item.idarticulo === id)!.existencia;

    // Both carry the book figure and a zero variance. **The file cannot tell
    // them apart**, and that is not a defect of this code: the format has no way
    // to say «we did not look» (ZEUS_FORMAT.md §9).
    expect(row(waived).toma).toBe(book(waived));
    expect(row(untouched).toma).toBe(book(untouched));
    expect(row(waived).diferencia).toBe(0);
    expect(row(untouched).diferencia).toBe(0);

    // The bundle does tell them apart, which is the compensating control and the
    // reason the acta exists: one row carries a signature with a name and a
    // reason on it, the other carries nothing at all.
    const bundle = JSON.parse(
      ((await sessionBundle(db, fixture.sessionId)).body as { canonical: string }).canonical,
    ) as SessionBundle;
    const waiver = bundle.acciones.find((action) => action.kind === 'waiver')!;
    expect((waiver.payload as { idarticulo: number[] }).idarticulo).toEqual([waived]);
    expect(waiver.usuario).toBe('Marta');
    expect(
      bundle.acciones.some((action) =>
        JSON.stringify(action.payload).includes(String(untouched)),
      ),
    ).toBe(false);
  });

  it('aborts and leaves the session sealed when the writer refuses', async () => {
    // Forced through `uncountedPolicy: 'reject'` — a session created on
    // parameters §7.1 never verified, which dispatch refuses but which older
    // rows can carry. What is being asserted is the shape of the abort, not the
    // policy: the pipeline throws, and **nothing is written**.
    const fixture = await ready();
    await seal(fixture.sessionId);
    await db.query(`update sessions set uncounted_policy = 'reject' where id = $1`, [
      fixture.sessionId,
    ]);

    await expect(exportSession(db, fixture.sessionId)).rejects.toThrow();
    expect(await estadoOf(fixture.sessionId)).toBe('sellado');
    expect(await loadExportBytes(db, fixture.sessionId)).toBeNull();

    // And the session is still exportable once the reason is gone: the failure
    // cost a button press and nothing else.
    await db.query(`update sessions set uncounted_policy = 'existencia' where id = $1`, [
      fixture.sessionId,
    ]);
    expect((await exportSession(db, fixture.sessionId)).status).toBe(200);
  });
});

suite('GET /api/sessions/:id/bundle', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'f');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    eventCounter = 0;
  });

  it('refuses before the seal, because there is nothing to verify yet', async () => {
    const fixture = await ready();
    const result = await sessionBundle(db, fixture.sessionId);
    expect(result.status).toBe(409);
    expect(detail(result)!.code).toBe('NOT_SEALED');
  });

  it('carries every chain link, the catalogue with rawRow, and no token', async () => {
    const fixture = await ready();
    await postAction(
      db,
      fixture.sessionId,
      { kind: 'waiver', usuario: 'Marta', motivo: 'no alcanzó', idarticulo: [fixture.suyosAna[7]] },
      { now: () => NOW, newId: ids('c') },
    );
    await seal(fixture.sessionId);
    await exportSession(db, fixture.sessionId);

    const result = await sessionBundle(db, fixture.sessionId);
    expect(result.status).toBe(200);
    const canonical = (result.body as { canonical: string }).canonical;
    const bundle = JSON.parse(canonical) as SessionBundle;

    expect(bundle.formato).toBe('conteo-zeus/bundle/v1');
    expect(bundle.catalogo.length).toBe(298);
    expect(bundle.catalogo[0].rawRow.length).toBe(24);
    // Quantities are strings all the way through: a JSON number would put each
    // of them through a double before a verifier ever saw it.
    expect(typeof bundle.catalogo[0].existencia).toBe('string');
    expect(bundle.eventos.every((event) => event.prevHash !== '' && event.hash !== '')).toBe(true);
    expect(bundle.acciones.map((action) => action.kind)).toEqual(['waiver']);
    expect(bundle.sellos.fileHash).toBeTruthy();

    // A counter link is a bearer credential. The acta names people; the chain
    // identifies them by id; neither needs the string that would let somebody
    // push events as them.
    const tokens = await db.query<{ token: string }>(
      'select token from counters where session_id = $1',
      [fixture.sessionId],
    );
    for (const { token } of tokens) expect(canonical).not.toContain(token);

    // Canonical means byte-stable: two reads of one sealed session are the same
    // file, which is a property somebody comparing two downloads will want.
    const again = await sessionBundle(db, fixture.sessionId);
    expect((again.body as { canonical: string }).canonical).toBe(canonical);
  });

  it('reports the seal on /sync, with an empty late-arrival list', async () => {
    const fixture = await ready();
    await seal(fixture.sessionId);
    const sync = await sessionSync(db, fixture.sessionId);
    const sello = (sync.body as { sello: { tardios: unknown[]; sessionHash: string } }).sello;
    expect(sello.sessionHash).toBeTruthy();
    // Always empty, and read anyway: an event in `events` that `session_hash`
    // does not cover is the one inconsistency this screen must be able to show
    // rather than argue is impossible.
    expect(sello.tardios).toEqual([]);
  });
});

/** The chain head the server holds for one counter. */
async function headOf(counterId: string): Promise<string | null> {
  const rows = await db.query<{ head_hash: string | null }>(
    'select head_hash from counters where id = $1',
    [counterId],
  );
  return rows[0]?.head_hash ?? null;
}

/** How many rows each append-only table holds for this session. */
async function counts(sessionId: string): Promise<{ eventos: number; acciones: number }> {
  const [events, actions] = await Promise.all([
    db.query<{ n: string }>('select count(*) as n from events where session_id = $1', [sessionId]),
    db.query<{ n: string }>('select count(*) as n from session_actions where session_id = $1', [
      sessionId,
    ]),
  ]);
  return { eventos: Number(events[0].n), acciones: Number(actions[0].n) };
}

/** `<bodega>_<fechaCorte with dashes>`, as the filename renders it. */
async function label(sessionId: string): Promise<string> {
  const row = (
    await db.query<{ bodega: string; fecha_corte: string }>(
      'select bodega, fecha_corte from sessions where id = $1',
      [sessionId],
    )
  )[0];
  return `${row.bodega}_${row.fecha_corte.replaceAll('/', '-')}`;
}
