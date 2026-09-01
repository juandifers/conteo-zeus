/**
 * Counter changes after dispatch, against a real Postgres — P2.3.5 §9.
 *
 * Skipped unless `DATABASE_URL` is set, like the suites beside it. What needs a
 * database rather than a stub is the whole point of this path: the guards are
 * SQL predicates, `unique (session_id, seq)` is what stops two admins writing
 * action 7, and the failure being defended against — **an unmatched `update`
 * raises nothing in a non-interactive transaction** — is invisible to anything
 * that mocks the driver.
 *
 * The load-bearing claim of the whole task is asserted here rather than argued:
 * a reassignment writes rows in `assignments`, `sections`, `counters` and
 * `session_actions`, and **not one row in `events`**. Attribution is by event,
 * for ever, whoever holds the assignment afterwards.
 */
// Must precede any import that reaches Dexie: Dexie binds the global
// `indexedDB` at module load, so a shim installed afterwards is too late.
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSession } from '../../api/sessions/index';
import { dispatchSession } from '../../api/sessions/[id]/dispatch';
import { listActions, postAction } from '../../api/sessions/[id]/acciones';
import { sessionSync } from '../../api/sessions/[id]/sync';
import { counterFetch } from '../../api/c/[token]';
import { pushEvents } from '../../api/c/[token]/_events';
import { counterResume } from '../../api/c/[token]/_resume';
import { loadItemEvents, reassignStatements, toBase64 } from '../../api/_store';
import {
  actaLines,
  chainHash,
  genesisHash,
  resolveAll,
  reviewSession,
  standingWaivers,
  verifyActionChain,
  waiversToEvents,
  type ChainedEvent,
  type CountEvent,
  type CounterPayload,
  type SealBlocker,
  type SessionActionRecord,
  type StoredAction,
} from '../../src/domain';
import { ingestZeusBytes, toWire } from '../../src/app';
import { parseXls, reencode } from '../../src/zeus';
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

const EPOCH = Date.UTC(2026, 7, 31, 14, 0, 0);
const NOW = new Date(EPOCH).toISOString();

interface Dispatched {
  sessionId: string;
  ana: { id: string; token: string };
  luis: { id: string; token: string };
  idarticulos: number[];
  /** Luis's articles, which are the ones that change hands in most of these. */
  suyos: number[];
}

/**
 * Two counters, two sections, the real 298-row catalogue.
 *
 * Luis holds one whole section, which is the swap; Ana holds the other. That is
 * the smallest fixture in which repointing and splitting are different
 * operations.
 */
async function dispatched(): Promise<Dispatched> {
  const parsed = ingestZeusBytes(TXT);
  const created = await createSession(
    db,
    {
      sourceBytesBase64: toBase64(TXT),
      sourceName: 'COMESTIBLES ALMACEN.txt',
      rows: parsed.rows.map(toWire),
    },
    { newId: ids('b') },
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
    { newId: ids('d') },
  );
  expect(result.status).toBe(200);
  const body = result.body as { counters: { id: string; nombre: string; token: string }[] };
  return {
    sessionId,
    ana: body.counters.find((c) => c.nombre === 'Ana')!,
    luis: body.counters.find((c) => c.nombre === 'Luis')!,
    idarticulos,
    suyos: idarticulos.slice(half),
  };
}

/** Chain a run of counts for one counter, the way a device would. */
function counts(
  sessionId: string,
  counterId: string,
  specs: readonly { idarticulo: number; qty: number }[],
  options: { startSeq?: number; head?: string; zona?: string } = {},
): ChainedEvent[] {
  let prev = options.head ?? genesisHash(sessionId, counterId);
  let seq = options.startSeq ?? 1;
  const links: ChainedEvent[] = [];
  for (const [i, spec] of specs.entries()) {
    const event = {
      id: `e${String(seq * 100 + i).padStart(7, '0')}-0000-4000-8000-000000000000`,
      sessionId,
      counterId,
      usuario: 'quien sea',
      zona: options.zona ?? 'BAR',
      at: new Date(EPOCH + seq * 1000).toISOString(),
      deviceId: 'tablet-a',
      seq,
      kind: 'add',
      idarticulo: spec.idarticulo,
      qty: spec.qty,
    } as CountEvent;
    const hash = chainHash(prev, event);
    links.push({ event, prevHash: prev, hash });
    prev = hash;
    seq++;
  }
  return links;
}

/** Move every article Luis holds to a target, as the screen would build it. */
async function moveAll(
  d: Dispatched,
  to: string | { nuevo: string },
  over: Record<string, unknown> = {},
) {
  const version = await currentVersion(d.sessionId);
  return postAction(
    db,
    d.sessionId,
    {
      kind: 'reasignar',
      usuario: 'Marta',
      motivo: 'Luis se fue enfermo',
      version,
      moves: d.suyos.map((idarticulo) => ({
        idarticulo,
        from: d.luis.id,
        to: typeof to === 'string' ? to : 'nuevo',
      })),
      ...(typeof to === 'string' ? {} : { nuevos: [{ ref: 'nuevo', nombre: to.nuevo }] }),
      ...over,
    },
    { now: () => NOW, newId: ids('f'), mintToken: () => 'N'.repeat(22) },
  );
}

async function currentVersion(sessionId: string): Promise<number> {
  const rows = await db.query<{ v: number }>(
    'select assignments_version as v from sessions where id = $1',
    [sessionId],
  );
  return rows[0].v;
}

const holdings = async (counterId: string) =>
  Number(
    (
      await db.query<{ n: string }>('select count(*) as n from assignments where counter_id = $1', [
        counterId,
      ])
    )[0].n,
  );

const eventCount = async (sessionId: string) =>
  Number(
    (
      await db.query<{ n: string }>('select count(*) as n from events where session_id = $1', [
        sessionId,
      ])
    )[0].n,
  );

const actions = async (sessionId: string): Promise<SessionActionRecord[]> =>
  ((await listActions(db, sessionId)).body as { acciones: SessionActionRecord[] }).acciones;

const sealBlockers = async (sessionId: string): Promise<SealBlocker[]> =>
  ((await sessionSync(db, sessionId)).body as { session: { readyToSeal: SealBlocker[] } }).session
    .readyToSeal;

suite('POST /api/sessions/:id/acciones', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'b');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });

  describe('reassignment', () => {
    it('moves a whole section by repointing it — same name, same zona, new holder', async () => {
      const d = await dispatched();
      const result = await moveAll(d, d.ana.id);
      expect(result.status).toBe(200);

      expect(await holdings(d.luis.id)).toBe(0);
      expect(await holdings(d.ana.id)).toBe(d.idarticulos.length);

      // The section row itself changed hands. Pedro counting Luis's BAR is
      // standing in BAR, and a second name for one shelf would put two zones on
      // one place in the acta.
      const sections = await db.query<{ nombre: string; counter_id: string }>(
        'select nombre, counter_id from sections where session_id = $1 order by nombre',
        [d.sessionId],
      );
      expect(sections.map((row) => row.nombre)).toEqual(['ALMACEN', 'BAR']);
      expect(sections.every((row) => row.counter_id === d.ana.id)).toBe(true);
    });

    it('writes not one row in `events` — attribution never moves', async () => {
      // The claim the whole task rests on. Luis counted; those events are his
      // for ever, whoever holds the assignment afterwards.
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [
          { idarticulo: d.suyos[0], qty: 8 },
          { idarticulo: d.suyos[1], qty: 3 },
        ]),
      });
      const before = await eventCount(d.sessionId);

      await moveAll(d, d.ana.id);

      expect(await eventCount(d.sessionId)).toBe(before);
      const owners = await db.query<{ counter_id: string }>(
        'select distinct counter_id from events where session_id = $1',
        [d.sessionId],
      );
      expect(owners.map((row) => row.counter_id)).toEqual([d.luis.id]);
    });

    it('keeps the zona an event was written with, and stamps the new one after', async () => {
      // Events are immutable and the zone records **where the count happened**,
      // not where responsibility currently sits. Somebody will one day want to
      // "fix" the inconsistency; this is why they must not.
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 8 }], {
          zona: 'BAR',
        }),
      });
      await moveAll(d, d.ana.id);

      const before = await db.query<{ zona: string }>(
        'select zona from events where session_id = $1',
        [d.sessionId],
      );
      expect(before.map((row) => row.zona)).toEqual(['BAR']);

      // And the section the article now sits in is the one a new event would be
      // stamped from — the device reads `zonaFor` off exactly this payload.
      const payload = (await counterFetch(db, d.ana.token, { record: false }))
        .body as CounterPayload;
      const zona = payload.secciones.find((section) =>
        section.items.some((item) => item.idarticulo === d.suyos[0]),
      )!.nombre;
      expect(zona).toBe('BAR');
    });

    it('records the move with its reason, on a chain that verifies', async () => {
      const d = await dispatched();
      await moveAll(d, d.ana.id);

      const log = await actions(d.sessionId);
      expect(log).toHaveLength(1);
      expect(log[0].kind).toBe('reasignar');
      expect(log[0].usuario).toBe('Marta');
      expect((log[0].payload as { motivo: string }).motivo).toBe('Luis se fue enfermo');

      // Verified after a real `jsonb` round trip, which is the thing
      // `canonicalJson` exists for: `jsonb` does not preserve key order.
      const verdict = verifyActionChain(d.sessionId, log as unknown as StoredAction[]);
      expect(verdict.ok).toBe(true);
    });

    it('refuses a stale plan and writes nothing', async () => {
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      const after = await currentVersion(d.sessionId);

      // The second admin's tab still believes Luis holds his section.
      const stale = await postAction(
        db,
        d.sessionId,
        {
          kind: 'reasignar',
          usuario: 'Otro',
          motivo: 'no sabía',
          version: after - 1,
          moves: [{ idarticulo: d.suyos[0], from: d.luis.id, to: d.ana.id }],
        },
        { now: () => NOW, newId: ids('9') },
      );
      expect(stale.status).toBe(409);
      expect((stale.body as { detalle?: { code?: string } }).detalle?.code).toBe(
        'STALE_ASSIGNMENTS',
      );
      expect(await currentVersion(d.sessionId)).toBe(after);
      expect(await actions(d.sessionId)).toHaveLength(1);
    });

    it('refuses a plan whose `from` no longer holds the article', async () => {
      const d = await dispatched();
      const version = await currentVersion(d.sessionId);
      const refused = await postAction(
        db,
        d.sessionId,
        {
          kind: 'reasignar',
          usuario: 'Marta',
          motivo: 'me equivoqué de columna',
          version,
          // Ana's article, claimed to be Luis's.
          moves: [{ idarticulo: d.idarticulos[0], from: d.luis.id, to: d.ana.id }],
        },
        { now: () => NOW, newId: ids('9') },
      );
      expect(refused.status).toBe(409);
      const blockers = (refused.body as { detalle: { blockers: { kind: string }[] } }).detalle
        .blockers;
      expect(blockers.map((blocker) => blocker.kind)).toContain('origen-no-tiene');
      expect(await actions(d.sessionId)).toHaveLength(0);
    });

    it('is all or nothing under a concurrent write, proven at the SQL level', async () => {
      // Past the handler, so what is under test is the guard rather than the
      // check above it. The second transaction is built against the version the
      // first one is about to bump, which is the two-laptops case: without the
      // guard its `update` matches nothing, raises nothing, and commits a
      // partial reassignment nobody asked for.
      const d = await dispatched();
      const version = await currentVersion(d.sessionId);
      const plan = {
        actions: [
          {
            id: 'aaaaaaa1-0000-4000-8000-000000000000',
            seq: 1,
            kind: 'reasignar',
            payload: { motivo: 'segunda' },
            usuario: 'Otro',
            clientAt: NOW,
            prevHash: 'no-importa',
            hash: 'tampoco',
          },
        ],
        expectedActionSeq: 0,
        version,
        estados: ['abierto', 'revision'],
        counters: [],
        createSections: [],
        repointSections: [],
        moves: d.suyos.slice(0, 3).map((idarticulo) => ({
          idarticulo,
          from: d.luis.id,
          to: d.ana.id,
          sectionId: 'ffffffff-0000-4000-8000-000000000000',
        })),
      };

      // The winner.
      await moveAll(d, d.ana.id);
      const bumped = await currentVersion(d.sessionId);

      // The loser, replayed against the version it read.
      const results = await db.transaction(reassignStatements(d.sessionId, plan));
      expect(results[results.length - 1]).toEqual([]);
      expect(await currentVersion(d.sessionId)).toBe(bumped);
      // Nothing of the loser's landed: no action row, no assignment pointing at
      // a section id that does not exist.
      expect(await actions(d.sessionId)).toHaveLength(1);
      const orphans = await db.query<{ n: string }>(
        `select count(*) as n from assignments a
          left join sections s on s.id = a.section_id
          where a.session_id = $1 and s.id is null`,
        [d.sessionId],
      );
      expect(Number(orphans[0].n)).toBe(0);
    });

    it('leaves coverage intact when the transaction cannot complete', async () => {
      // The injected failure: a move naming a counter in another session. The
      // foreign key refuses it, the whole batch rolls back, and the partition is
      // exactly where it was.
      const d = await dispatched();
      const version = await currentVersion(d.sessionId);
      const before = await holdings(d.luis.id);

      await expect(
        db.transaction(
          reassignStatements(d.sessionId, {
            actions: [
              {
                id: 'aaaaaaa2-0000-4000-8000-000000000000',
                seq: 1,
                kind: 'reasignar',
                payload: {},
                usuario: 'Marta',
                clientAt: NOW,
                prevHash: 'x',
                hash: 'y',
              },
            ],
            expectedActionSeq: 0,
            version,
            estados: ['abierto', 'revision'],
            counters: [],
            createSections: [
              // References a counter that does not exist: `sections.counter_id`
              // refuses it and the transaction dies mid-batch.
              { id: 'cccccccc-0000-4000-8000-000000000000', nombre: 'X', counterId: '99999999-0000-4000-8000-000000000000' },
            ],
            repointSections: [],
            moves: d.suyos.map((idarticulo) => ({
              idarticulo,
              from: d.luis.id,
              to: d.ana.id,
              sectionId: 'cccccccc-0000-4000-8000-000000000000',
            })),
          }),
        ),
      ).rejects.toThrow();

      expect(await currentVersion(d.sessionId)).toBe(version);
      expect(await holdings(d.luis.id)).toBe(before);
      expect(await actions(d.sessionId)).toHaveLength(0);
    });

    it('adds a counter and their work in one act, with a printable link', async () => {
      // P2.1 leaves nothing unassigned, so a new counter cannot arrive
      // empty-handed: the link and the shelves are minted together.
      const d = await dispatched();
      const result = await moveAll(d, { nuevo: 'Carla' });
      expect(result.status).toBe(200);
      const body = result.body as { nuevos: { id: string; nombre: string; token: string }[] };
      expect(body.nuevos).toHaveLength(1);
      expect(body.nuevos[0].nombre).toBe('Carla');

      const payload = (await counterFetch(db, body.nuevos[0].token, { record: false }))
        .body as CounterPayload;
      expect(payload.counter.nombre).toBe('Carla');
      expect(payload.secciones.flatMap((section) => section.items)).toHaveLength(d.suyos.length);

      // Two rows on the chain: who was added, and what they were given.
      expect((await actions(d.sessionId)).map((action) => action.kind)).toEqual([
        'agregar_contador',
        'reasignar',
      ]);
    });

    it('records who had not synced, for the review screen to explain an overlap with', async () => {
      // §4b. Luis has pushed nothing, so the server has never heard from him;
      // moving his shelves may produce a double count and **nothing here can
      // prevent it**. What it can do is say so, and write it down.
      const d = await dispatched();
      const result = await moveAll(d, d.ana.id);
      const risks = (result.body as { sinSincronizar: { nombre: string; articulos: number }[] })
        .sinSincronizar;
      expect(risks).toEqual([
        { counterId: d.luis.id, nombre: 'Luis', lastServerAt: null, articulos: d.suyos.length },
      ]);
      expect(actaLines(await actions(d.sessionId))[0]).toContain(
        'sin sincronizar al momento del cambio: Luis',
      );
    });

    it('says nothing about a counter who pushed a moment ago', async () => {
      const d = await dispatched();
      await pushEvents(
        db,
        d.luis.token,
        { events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 1 }]) },
        { now: () => NOW },
      );
      const result = await moveAll(d, d.ana.id);
      expect((result.body as { sinSincronizar: unknown[] }).sinSincronizar).toEqual([]);
    });

    it('refuses a move with no name or no reason on it', async () => {
      const d = await dispatched();
      const version = await currentVersion(d.sessionId);
      for (const body of [
        { kind: 'reasignar', usuario: '', motivo: 'x', version, moves: [] },
        { kind: 'reasignar', usuario: 'Marta', motivo: '  ', version, moves: [] },
      ]) {
        const result = await postAction(db, d.sessionId, body, { now: () => NOW });
        expect(result.status).toBe(400);
      }
      expect(await actions(d.sessionId)).toHaveLength(0);
    });
  });

  describe('retirement', () => {
    it('is refused while the counter still holds articles, and names them', async () => {
      const d = await dispatched();
      const result = await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue enfermo', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );
      expect(result.status).toBe(409);
      expect((result.body as { detalle: { code: string } }).detalle.code).toBe('STILL_HOLDING');
      expect(await actions(d.sessionId)).toHaveLength(0);
    });

    it('succeeds once their shelves have been handed over', async () => {
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      const result = await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue enfermo', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );
      expect(result.status).toBe(200);
      const rows = await db.query<{ estado: string }>('select estado from counters where id = $1', [
        d.luis.id,
      ]);
      expect(rows[0].estado).toBe('retirado');
      expect((await actions(d.sessionId)).map((action) => action.kind)).toEqual([
        'reasignar',
        'retirar_contador',
      ]);
    });

    it('keeps accepting their pushes, and stops handing out a fresh assignment', async () => {
      // The policy call in §10, settled: revoking the token is the one action
      // guaranteed to strand whatever is still on their tablet, and that tablet
      // holds the only copy of somebody's morning.
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue enfermo', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );

      const fetched = await counterFetch(db, d.luis.token, { record: false });
      expect(fetched.status).toBe(409);
      expect((fetched.body as { detalle: { code: string } }).detalle.code).toBe('COUNTER_RETIRED');

      // Resume still answers, so a drain that has to restart can.
      expect((await counterResume(db, d.luis.token)).status).toBe(200);

      const pushed = await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 8 }]),
      });
      expect(pushed.status).toBe(200);
      expect(await eventCount(d.sessionId)).toBe(1);
    });

    it('does not let a late push put them back into the count', async () => {
      // `retirado` is the one state in that column that is not derived from the
      // chain. Luis's tablet draining at 17:40 is welcome; it is not a decision
      // about whether he is still counting.
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue enfermo', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 8 }]),
      });
      const rows = await db.query<{ estado: string }>('select estado from counters where id = $1', [
        d.luis.id,
      ]);
      expect(rows[0].estado).toBe('retirado');
    });

    it('refuses to give work to somebody who has been retired', async () => {
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );
      const version = await currentVersion(d.sessionId);
      const result = await postAction(
        db,
        d.sessionId,
        {
          kind: 'reasignar',
          usuario: 'Marta',
          motivo: 'volvió',
          version,
          moves: [{ idarticulo: d.suyos[0], from: d.ana.id, to: d.luis.id }],
        },
        { now: () => NOW, newId: ids('8') },
      );
      expect(result.status).toBe(409);
      const blockers = (result.body as { detalle: { blockers: { kind: string }[] } }).detalle
        .blockers;
      expect(blockers.map((blocker) => blocker.kind)).toContain('destino-retirado');
    });
  });

  describe('the sealing gate', () => {
    /** Retire Luis after handing his shelves to Ana. */
    async function retireLuis(d: Dispatched): Promise<void> {
      await moveAll(d, d.ana.id);
      const result = await postAction(
        db,
        d.sessionId,
        { kind: 'retirar_contador', usuario: 'Marta', motivo: 'se fue enfermo', counterId: d.luis.id },
        { now: () => NOW, newId: ids('9') },
      );
      expect(result.status).toBe(200);
    }

    it('is satisfied by a retired counter with an empty chain (§5c)', async () => {
      // «María fue asignada y nunca llegó». Her chain is empty, which is
      // complete — `finalSeq = 0` — so the gate is satisfied without a special
      // case, and without her tablet ever having downloaded anything.
      const d = await dispatched();
      await retireLuis(d);
      const blockers = await sealBlockers(d.sessionId);
      expect(blockers.filter((blocker) => 'counterId' in blocker && blocker.counterId === d.luis.id))
        .toEqual([]);
    });

    it('is satisfied by a retired counter whose chain is whole', async () => {
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [
          { idarticulo: d.suyos[0], qty: 1 },
          { idarticulo: d.suyos[1], qty: 2 },
        ]),
      });
      await retireLuis(d);
      expect(
        (await sealBlockers(d.sessionId)).some(
          (blocker) => blocker.kind === 'contador-retirado-incompleto',
        ),
      ).toBe(false);
    });

    it('is blocked by a retired counter whose chain has a hole in it', async () => {
      // §5b, as the server can actually see it: seq 1–2 arrived, then the tablet
      // went into a jacket, then 4–5 arrived over a moment of signal. Three is
      // missing and nothing but that tablet has it.
      const d = await dispatched();
      const early = counts(d.sessionId, d.luis.id, [
        { idarticulo: d.suyos[0], qty: 1 },
        { idarticulo: d.suyos[1], qty: 2 },
      ]);
      await pushEvents(db, d.luis.token, { events: early });
      // Write 4–5 directly: the push path would refuse them as a gap, which is
      // exactly right, and what is under test here is the state the row ends up
      // in when a device gets its batches out in a different order.
      await db.query(
        `insert into events (id, session_id, counter_id, seq, kind, idarticulo, cantidad,
                             usuario, zona, client_at, device_id, prev_hash, hash)
         values ('eeeeeee4-0000-4000-8000-000000000000', $1, $2, 4, 'add', $3, '1',
                 'Luis', 'BAR', $4, 'tablet-a', 'x', 'y'),
                ('eeeeeee5-0000-4000-8000-000000000000', $1, $2, 5, 'add', $3, '1',
                 'Luis', 'BAR', $4, 'tablet-a', 'y', 'z')`,
        [d.sessionId, d.luis.id, d.suyos[0], NOW],
      );

      await retireLuis(d);
      expect(await sealBlockers(d.sessionId)).toContainEqual({
        kind: 'contador-retirado-incompleto',
        counterId: d.luis.id,
        nombre: 'Luis',
      });
    });

    it('is opened by `sellar_sin_registros`, which names the range on the acta', async () => {
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 1 }]),
      });
      await db.query(
        `insert into events (id, session_id, counter_id, seq, kind, idarticulo, cantidad,
                             usuario, zona, client_at, device_id, prev_hash, hash)
         values ('eeeeeee9-0000-4000-8000-000000000000', $1, $2, 5, 'add', $3, '1',
                 'Luis', 'BAR', $4, 'tablet-a', 'x', 'y')`,
        [d.sessionId, d.luis.id, d.suyos[0], NOW],
      );
      await retireLuis(d);

      const result = await postAction(
        db,
        d.sessionId,
        {
          kind: 'sellar_sin_registros',
          usuario: 'Marta',
          motivo: 'la tableta se fue en el bolsillo y no volvió',
          counterId: d.luis.id,
        },
        { now: () => NOW, newId: ids('8') },
      );
      expect(result.status).toBe(200);
      expect((result.body as { faltan: string }).faltan).toBe('2–4');

      expect(
        (await sealBlockers(d.sessionId)).some(
          (blocker) => blocker.kind === 'contador-retirado-incompleto',
        ),
      ).toBe(false);

      // On the acta as a named line, not a footnote.
      const line = actaLines(await actions(d.sessionId)).at(-1)!;
      expect(line).toContain('ESTE CONTEO SE SELLÓ SIN LOS REGISTROS DE Luis');
      expect(line).toContain('2–4');
      expect(line).toContain('Marta');
    });

    it('refuses to sign one over a chain with no holes', async () => {
      // An override on a complete chain is a line on the acta saying a count is
      // missing work it is not missing.
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 1 }]),
      });
      await retireLuis(d);
      const result = await postAction(
        db,
        d.sessionId,
        { kind: 'sellar_sin_registros', usuario: 'Marta', motivo: 'por si acaso', counterId: d.luis.id },
        { now: () => NOW, newId: ids('8') },
      );
      expect(result.status).toBe(409);
      expect((result.body as { detalle: { code: string } }).detalle.code).toBe('NOTHING_MISSING');
    });

    it('refuses to sign one over somebody who is still in the count', async () => {
      const d = await dispatched();
      const result = await postAction(
        db,
        d.sessionId,
        { kind: 'sellar_sin_registros', usuario: 'Marta', motivo: 'se demora', counterId: d.luis.id },
        { now: () => NOW, newId: ids('8') },
      );
      expect(result.status).toBe(409);
      expect((result.body as { detalle: { code: string } }).detalle.code).toBe('NOT_RETIRED');
    });
  });

  describe('what a counter’s tablet is told (§6b)', () => {
    it('sends the ids somebody has already registered, and nothing else', async () => {
      // Against the real handler response, which is the form P2.1 §4c's leak
      // test asks for. Ids only: no quantities, no counter names, no counts.
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [
          { idarticulo: d.suyos[0], qty: 8 },
          { idarticulo: d.suyos[1], qty: 3.5 },
        ]),
      });
      await moveAll(d, d.ana.id);

      const payload = (await counterFetch(db, d.ana.token, { record: false }))
        .body as CounterPayload;
      expect(payload.yaRegistrados).toEqual([d.suyos[0], d.suyos[1]].sort((a, b) => a - b));
      // The serialised field is a flat array of integers. Nothing about "8" or
      // "3.5" can be anywhere in it.
      expect(JSON.stringify(payload.yaRegistrados)).toMatch(/^\[\d+(,\d+)*\]$/);
    });

    it('excludes an article whose only entry was withdrawn', async () => {
      // «Registered» is asked of the fold, not of the event kinds, and the fold
      // is `registeredArticles` — the same function the tablet runs. Deciding it
      // in SQL would be a second definition, and the two would disagree here.
      const d = await dispatched();
      const links = counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 8 }]);
      await pushEvents(db, d.luis.token, { events: links });
      const undo = {
        id: 'eeeeeeef-0000-4000-8000-000000000000',
        sessionId: d.sessionId,
        counterId: d.luis.id,
        usuario: 'Luis',
        zona: 'BAR',
        at: new Date(EPOCH + 5000).toISOString(),
        deviceId: 'tablet-a',
        seq: 2,
        kind: 'retract',
        idarticulo: d.suyos[0],
        retractsEventId: links[0].event.id,
      } as CountEvent;
      await pushEvents(db, d.luis.token, {
        events: [{ event: undo, prevHash: links[0].hash, hash: chainHash(links[0].hash, undo) }],
      });

      await moveAll(d, d.ana.id);
      const payload = (await counterFetch(db, d.ana.token, { record: false }))
        .body as CounterPayload;
      expect(payload.yaRegistrados).toEqual([]);
    });

    it('is empty when nobody has changed hands, which is every ordinary session', async () => {
      const d = await dispatched();
      const payload = (await counterFetch(db, d.ana.token, { record: false }))
        .body as CounterPayload;
      expect(payload.yaRegistrados).toEqual([]);
    });
  });

  /**
   * P2.4 §4 — waivers, on the same chain and against a real `jsonb` round trip.
   *
   * What needs a database here is not the projection — `tests/domain/review.ts`
   * proves that — but that a waiver **survives storage byte for byte**. The
   * payload is `jsonb`, `jsonb` does not preserve key order, and the hash is
   * taken over the value; a list of primary keys is exactly the shape that
   * would break silently if `canonicalJson` were not doing its job.
   */
  describe('waivers (P2.4 §4)', () => {
    const waive = (sessionId: string, idarticulo: number[], over: Record<string, unknown> = {}) =>
      postAction(
        db,
        sessionId,
        { kind: 'waiver', usuario: 'Marta', motivo: 'no alcanzó el turno', idarticulo, ...over },
        { now: () => NOW, newId: ids('c') },
      );

    it('goes on the chain, verifies after a real jsonb round trip, and touches nothing else', async () => {
      const d = await dispatched();
      const before = await eventCount(d.sessionId);

      const result = await waive(d.sessionId, d.suyos.slice(0, 3));
      expect(result.status).toBe(200);

      const log = await actions(d.sessionId);
      expect(log.map((action) => action.kind)).toEqual(['waiver']);
      expect(log[0].payload).toMatchObject({
        idarticulo: d.suyos.slice(0, 3),
        motivo: 'no alcanzó el turno',
      });
      // The hash was taken before the insert and re-checked against what came
      // back out: key order is not preserved by `jsonb`, and this is where that
      // would show.
      expect(verifyActionChain(d.sessionId, log as unknown as StoredAction[]).ok).toBe(true);

      // A waiver is a decision, not a count. Nothing was written to `events`,
      // no counter changed state, and no assignment moved.
      expect(await eventCount(d.sessionId)).toBe(before);
      expect(await holdings(d.luis.id)).toBe(d.suyos.length);
      expect(await currentVersion(d.sessionId)).toBe(0);
    });

    it('carries no quantity — the waived value is `existencia`, read where it lives', async () => {
      const d = await dispatched();
      await waive(d.sessionId, [d.suyos[0]]);
      const rows = await db.query<{ payload: unknown }>(
        'select payload from session_actions where session_id = $1',
        [d.sessionId],
      );
      // The rule, asserted against what is actually stored: an action payload
      // never holds a number somebody counted off a shelf. A second copy of
      // `existencia` is a figure that can disagree with the first.
      expect(JSON.stringify(rows[0].payload)).not.toMatch(/cantidad|qty|existencia|costo/);
    });

    it('refuses one that names an article this file does not have', async () => {
      const d = await dispatched();
      const result = await waive(d.sessionId, [999_999]);
      expect(result.status).toBe(409);
      expect((result.body as { detalle: { code: string } }).detalle.code).toBe('BAD_WAIVER');
      expect(await actions(d.sessionId)).toEqual([]);
    });

    it('refuses one with nobody on it, and one with no reason', async () => {
      const d = await dispatched();
      expect((await waive(d.sessionId, [d.suyos[0]], { usuario: '  ' })).status).toBe(400);
      expect((await waive(d.sessionId, [d.suyos[0]], { motivo: '' })).status).toBe(400);
      expect(await actions(d.sessionId)).toEqual([]);
    });

    it('accepts one on an article somebody already counted, and the count still wins', async () => {
      // Deliberate: the handler does not ask whether an article has been
      // counted, because a tablet syncing an hour from now would make any
      // answer it gave wrong. §4b is decided at fold time, which is what makes
      // the outcome independent of arrival order.
      const d = await dispatched();
      await pushEvents(db, d.luis.token, {
        events: counts(d.sessionId, d.luis.id, [{ idarticulo: d.suyos[0], qty: 8 }]),
      });
      const result = await waive(d.sessionId, [d.suyos[0]]);
      expect(result.status).toBe(200);

      const events = await loadItemEvents(db, d.sessionId, [d.suyos[0]]);
      const log = await actions(d.sessionId);
      const fold = resolveAll(events);
      // Nothing was projected onto it…
      expect(waiversToEvents(log, fold)).toEqual([]);
      // …and it is reported as a waiver a count overtook.
      const review = reviewSession({
        sessionId: d.sessionId,
        items: [{ idarticulo: d.suyos[0], codigo: '0000001', nombre: 'X', presentacion: 'KILO', existencia: 5, ultimoConteo: null, costo: 10 }],
        events,
        actions: log,
        counters: [{ id: d.luis.id, nombre: 'Luis', estado: 'contando' }],
      });
      expect(review.superseded).toHaveLength(1);
      expect(review.rows[0]).toMatchObject({ state: 'counted', conteo: 8 });
    });

    it('is withdrawn by `anular_waiver`, which never deletes the original', async () => {
      const d = await dispatched();
      await waive(d.sessionId, [d.suyos[0]]);
      const [waiver] = await actions(d.sessionId);

      const undone = await postAction(
        db,
        d.sessionId,
        { kind: 'anular_waiver', usuario: 'Marta', motivo: 'me equivoqué', waiverId: waiver.id },
        { now: () => NOW, newId: ids('e') },
      );
      expect(undone.status).toBe(200);

      const log = await actions(d.sessionId);
      expect(log.map((action) => action.kind)).toEqual(['waiver', 'anular_waiver']);
      // Append-only: the row is still there, unchanged, and the chain still
      // verifies over both.
      expect(log[0].id).toBe(waiver.id);
      expect(log[0].payload).toEqual(waiver.payload);
      expect(verifyActionChain(d.sessionId, log as unknown as StoredAction[]).ok).toBe(true);
      expect(standingWaivers(log)).toEqual([]);
    });

    it('refuses to annul the same waiver twice, or to annul something that is not one', async () => {
      const d = await dispatched();
      await waive(d.sessionId, [d.suyos[0]]);
      const [waiver] = await actions(d.sessionId);
      const annul = (waiverId: string) =>
        postAction(
          db,
          d.sessionId,
          { kind: 'anular_waiver', usuario: 'Marta', motivo: 'otra vez', waiverId },
          { now: () => NOW, newId: ids('e') },
        );

      expect((await annul(waiver.id)).status).toBe(200);
      const again = await annul(waiver.id);
      expect(again.status).toBe(409);
      expect((again.body as { detalle: { reason: string } }).detalle.reason).toBe('ya-anulado');

      const log = await actions(d.sessionId);
      const notAWaiver = await annul(log[1].id);
      expect((notAWaiver.body as { detalle: { reason: string } }).detalle.reason).toBe(
        'no-es-waiver',
      );
      expect((await annul(d.sessionId)).status).toBe(409);
    });

    it('reaches the acta as a sentence about what the file will claim', async () => {
      const d = await dispatched();
      await waive(d.sessionId, [d.suyos[0], d.suyos[1]]);
      const lines = actaLines(await actions(d.sessionId));
      expect(lines[0]).toMatch(/^Se exoneraron 2 artículos sin contar \(Marta\)/);
      // Not a footnote: the consequence in the file, on the page.
      expect(lines[0]).toMatch(/con la cantidad de Zeus, como si se hubieran contado y coincidido/);
    });
  });

  describe('the log', () => {
    it('reads back in order, verified, whatever else happened', async () => {
      const d = await dispatched();
      await moveAll(d, { nuevo: 'Carla' });
      const result = await listActions(db, d.sessionId);
      const body = result.body as {
        acciones: SessionActionRecord[];
        cadena: { ok: boolean };
        assignmentsVersion: number;
      };
      expect(body.acciones.map((action) => action.seq)).toEqual([1, 2]);
      expect(body.cadena.ok).toBe(true);
      expect(body.assignmentsVersion).toBe(1);
    });

    it('cannot have a second action 1 written into it', async () => {
      // `unique (session_id, seq)` is what stops two admins writing action 7,
      // and it is a constraint rather than a check in the handler for the same
      // reason `unique (counter_id, seq)` is.
      const d = await dispatched();
      await moveAll(d, d.ana.id);
      await expect(
        db.query(
          `insert into session_actions (id, session_id, seq, kind, payload, usuario,
                                        client_at, prev_hash, hash)
           values ('aaaaaaa9-0000-4000-8000-000000000000', $1, 1, 'reasignar', '{}', 'X',
                   $2, 'p', 'h')`,
          [d.sessionId, NOW],
        ),
      ).rejects.toThrow();
    });
  });
});
