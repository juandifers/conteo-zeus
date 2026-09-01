/**
 * The push protocol, against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set. What needs a database here is not
 * incidental: `unique (counter_id, seq)` is what makes a replay idempotent and
 * a fork detectable, the guard predicate is what makes two devices pushing at
 * once safe, and `server_seq` is a real `bigserial` whose cursor behaviour is
 * the point of the read endpoint. A mocked database would prove the handler
 * calls a function.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSession } from '../../api/sessions/index';
import { dispatchSession } from '../../api/sessions/[id]/dispatch';
import { counterFetch } from '../../api/c/[token]';
import { pushEvents } from '../../api/c/[token]/_events';
import { counterResume } from '../../api/c/[token]/_resume';
import { sessionSync } from '../../api/sessions/[id]/sync';
import { sessionEvents } from '../../api/sessions/[id]/events';
import { toBase64 } from '../../api/_store';
import {
  chainHash,
  genesisHash,
  type ChainedEvent,
  type CountEvent,
  type CounterPayload,
} from '../../src/domain';
import { ingestZeusBytes, toWire } from '../../src/app';
import { parseXls, reencode } from '../../src/zeus';
import { readSample, SAMPLE_XLS } from '../helpers';
import { openTestDb, type TestDb } from './pgDb';

const URL = process.env.DATABASE_URL;
const suite = URL ? describe : describe.skip;

let db: TestDb;
const TXT = reencode(parseXls(readSample(SAMPLE_XLS)));

function ids(prefix: string) {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`;
}

/** Event ids are `uuid` in the schema, so the fixtures mint real ones. */
function eventId(n: number): string {
  return `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
}

const EPOCH = Date.UTC(2026, 7, 31, 14, 0, 0);

/** A session dispatched to two counters, and the tokens they were handed. */
async function dispatched(): Promise<{
  sessionId: string;
  ana: { id: string; token: string };
  luis: { id: string; token: string };
  idarticulos: number[];
}> {
  const parsed = ingestZeusBytes(TXT);
  const created = await createSession(
    db,
    {
      sourceBytesBase64: toBase64(TXT),
      sourceName: 'COMESTIBLES ALMACEN.txt',
      rows: parsed.rows.map(toWire),
    },
    { newId: ids('c') },
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
  };
}

interface Spec {
  kind: CountEvent['kind'];
  idarticulo?: number | null;
  qty?: number;
  retractsEventId?: string;
  texto?: string;
  finalSeq?: number;
  headHash?: string;
}

/**
 * Chain a run of events the way a device would: `seq` from `startSeq`, each hash
 * computed by `src/domain/chain.ts` — the same module the server re-runs.
 */
function chainFor(
  sessionId: string,
  counterId: string,
  specs: readonly Spec[],
  options: { startSeq?: number; head?: string; deviceId?: string; at?: (i: number) => string } = {},
): ChainedEvent[] {
  let prev = options.head ?? genesisHash(sessionId, counterId);
  let seq = options.startSeq ?? 1;
  const deviceId = options.deviceId ?? 'tablet-a';
  const links: ChainedEvent[] = [];
  for (const [i, spec] of specs.entries()) {
    const base = {
      id: eventId(seq * 100 + i),
      sessionId,
      counterId,
      usuario: 'Ana',
      zona: 'ALMACEN',
      at: options.at ? options.at(i) : new Date(EPOCH + seq * 1000).toISOString(),
      deviceId,
      seq,
    };
    const event = {
      ...base,
      kind: spec.kind,
      idarticulo: spec.idarticulo ?? null,
      ...(spec.qty === undefined ? {} : { qty: spec.qty }),
      ...(spec.retractsEventId === undefined ? {} : { retractsEventId: spec.retractsEventId }),
      ...(spec.texto === undefined ? {} : { texto: spec.texto }),
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

/** `n` ordinary counts, chained from the genesis. */
function counts(sessionId: string, counterId: string, n: number, idarticulo: number, options = {}) {
  return chainFor(
    sessionId,
    counterId,
    Array.from({ length: n }, (_, i) => ({ kind: 'add' as const, idarticulo, qty: i + 1 })),
    options,
  );
}

/** The finish that closes a chain: `seq = finalSeq + 1`, `prevHash = headHash`. */
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

const detail = (result: { body: unknown }) => (result.body as { detalle?: { code?: string; expectedFrom?: number } }).detalle;
const stored = async (counterId: string) =>
  Number(
    (await db.query<{ n: string }>('select count(*) as n from events where counter_id = $1', [counterId]))[0].n,
  );

suite('POST /api/c/:token/events', () => {
  beforeAll(async () => {
    db = await openTestDb(URL!, 'c');
  });
  afterAll(async () => {
    await db.reset();
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });

  it('accepts a chained batch and moves the counter to contando', async () => {
    const { sessionId, ana } = await dispatched();
    const batch = counts(sessionId, ana.id, 5, 1181);

    const result = await pushEvents(db, ana.token, { events: batch });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      acceptedThrough: 5,
      headHash: batch[4].hash,
      counterEstado: 'contando',
    });
    expect(await stored(ana.id)).toBe(5);
  });

  it('refuses a token nobody holds with the same body a malformed one gets', async () => {
    const { sessionId, ana } = await dispatched();
    const batch = counts(sessionId, ana.id, 1, 1181);
    const unknown = await pushEvents(db, 'a'.repeat(22), { events: batch });
    const malformed = await pushEvents(db, 'no', { events: batch });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
  });

  // --- the three failure modes ----------------------------------------------

  it('replays an accepted batch silently, and stores nothing twice', async () => {
    const { sessionId, ana } = await dispatched();
    const batch = counts(sessionId, ana.id, 4, 1181);

    const first = await pushEvents(db, ana.token, { events: batch });
    const again = await pushEvents(db, ana.token, { events: batch });

    expect(again.status).toBe(200);
    expect((again.body as { acceptedThrough: number }).acceptedThrough).toBe(4);
    expect((again.body as { headHash: string }).headHash).toBe(
      (first.body as { headHash: string }).headHash,
    );
    expect(await stored(ana.id)).toBe(4);
  });

  it('converges when duplicate batches interleave with new ones', async () => {
    const { sessionId, ana } = await dispatched();
    const all = counts(sessionId, ana.id, 9, 1181);

    await pushEvents(db, ana.token, { events: all.slice(0, 3) });
    await pushEvents(db, ana.token, { events: all.slice(0, 3) });
    await pushEvents(db, ana.token, { events: all.slice(3, 6) });
    // A batch that straddles: three the server has and three it does not.
    const straddle = await pushEvents(db, ana.token, { events: all.slice(3, 9) });

    expect(straddle.status).toBe(200);
    expect((straddle.body as { acceptedThrough: number }).acceptedThrough).toBe(9);
    expect(await stored(ana.id)).toBe(9);
    const seqs = await db.query<{ seq: number }>(
      'select seq from events where counter_id = $1 order by seq',
      [ana.id],
    );
    expect(seqs.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('answers a gap with expectedFrom, and converges once the device resumes there', async () => {
    // Not an error state. A tablet force-closed mid-drain lands here routinely.
    const { sessionId, ana } = await dispatched();
    const all = counts(sessionId, ana.id, 8, 1181);

    await pushEvents(db, ana.token, { events: all.slice(0, 3) });
    const gap = await pushEvents(db, ana.token, { events: all.slice(5) });
    expect(gap.status).toBe(409);
    expect(detail(gap)).toMatchObject({ code: 'SEQUENCE_GAP', expectedFrom: 4 });
    expect(await stored(ana.id)).toBe(3);

    const resumed = await pushEvents(db, ana.token, { events: all.slice(3) });
    expect(resumed.status).toBe(200);
    expect(await stored(ana.id)).toBe(8);
  });

  it('answers a fork loudly, stores nothing, and latches the flag', async () => {
    const { sessionId, ana } = await dispatched();
    await pushEvents(db, ana.token, { events: counts(sessionId, ana.id, 3, 1181) });

    // A second chain over the same session and counter, with different content
    // at the same sequence numbers. A restored backup looks exactly like this.
    const other = chainFor(sessionId, ana.id, [
      { kind: 'add', idarticulo: 1181, qty: 99 },
      { kind: 'add', idarticulo: 1181, qty: 98 },
    ]);
    const fork = await pushEvents(db, ana.token, { events: other });

    expect(fork.status).toBe(409);
    expect(detail(fork)).toMatchObject({ code: 'CHAIN_FORK', atSeq: 1 });
    expect(await stored(ana.id)).toBe(3);
    const row = await db.query<{ forked: boolean }>('select forked from counters where id = $1', [ana.id]);
    expect(row[0].forked).toBe(true);
  });

  it('names a two-tablet collision as itself, not as bad wifi', async () => {
    // `unique (counter_id, seq)` makes two live devices fail in a way a counter
    // reads as a network problem. The discriminator is that the counter is
    // already bound to a *different* device.
    const { sessionId, ana } = await dispatched();
    await pushEvents(db, ana.token, {
      events: counts(sessionId, ana.id, 2, 1181, { deviceId: 'tablet-a' }),
    });
    const second = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'add', idarticulo: 1181, qty: 7 }],
      { deviceId: 'tablet-b' },
    );
    const collision = await pushEvents(db, ana.token, { events: second });

    expect(detail(collision)).toMatchObject({
      code: 'DEVICE_COLLISION',
      boundDeviceId: 'tablet-a',
      pushingDeviceId: 'tablet-b',
    });
    expect((collision.body as { error: string }).error).toMatch(/Otra tableta/);
  });

  it('rejects a batch that does not hash to what it claims', async () => {
    const { sessionId, ana } = await dispatched();
    const batch = counts(sessionId, ana.id, 2, 1181);
    const tampered = [batch[0], { ...batch[1], event: { ...batch[1].event, qty: 999 } }];
    const result = await pushEvents(db, ana.token, { events: tampered as ChainedEvent[] });
    expect(detail(result)).toMatchObject({ code: 'CHAIN_INVALID', atSeq: 2 });
    expect(await stored(ana.id)).toBe(0);
  });

  it('caps a batch at 200', async () => {
    const { sessionId, ana } = await dispatched();
    const result = await pushEvents(db, ana.token, {
      events: counts(sessionId, ana.id, 201, 1181),
    });
    expect(result.status).toBe(400);
    expect(detail(result)).toMatchObject({ code: 'BATCH_INVALID', max: 200 });
  });

  it('re-pushes a batch whose response was lost, with no duplication', async () => {
    // The commonest failure in the field: the server committed and the tablet
    // never saw the ack. `unique (counter_id, seq)` and the hash comparison make
    // it a replay, which is why over-delivery is the safe direction.
    const { sessionId, ana } = await dispatched();
    const batch = counts(sessionId, ana.id, 6, 1181);
    await pushEvents(db, ana.token, { events: batch });
    await pushEvents(db, ana.token, { events: batch });
    await pushEvents(db, ana.token, { events: batch });
    expect(await stored(ana.id)).toBe(6);
  });

  // --- sealed ---------------------------------------------------------------

  it('refuses a push into a sealed session and stores nothing', async () => {
    const { sessionId, ana } = await dispatched();
    await pushEvents(db, ana.token, { events: counts(sessionId, ana.id, 2, 1181) });
    await db.query(`update sessions set estado = 'sellado' where id = $1`, [sessionId]);

    const later = counts(sessionId, ana.id, 5, 1181);
    const result = await pushEvents(db, ana.token, { events: later.slice(2) });

    expect(result.status).toBe(409);
    expect(detail(result)).toMatchObject({ code: 'SESSION_SEALED' });
    // The message does not blame the counter.
    expect((result.body as { error: string }).error).toMatch(/No es un error tuyo|no alcanzó|no entra/);
    expect(await stored(ana.id)).toBe(2);
  });

  // --- the gate -------------------------------------------------------------

  it('refuses an unscoped retraction, whatever the client believes', async () => {
    const { sessionId, ana } = await dispatched();
    const batch = chainFor(sessionId, ana.id, [
      { kind: 'add', idarticulo: 4471, qty: 5 },
      { kind: 'retract', idarticulo: 4471 },
    ]);
    const result = await pushEvents(db, ana.token, { events: batch });
    expect(result.status).toBe(422);
    expect(detail(result)).toMatchObject({ code: 'RETRACT_SIN_SCOPE' });
    expect(await stored(ana.id)).toBe(0);
  });

  it('accepts a scoped one', async () => {
    const { sessionId, ana } = await dispatched();
    const first = chainFor(sessionId, ana.id, [{ kind: 'add', idarticulo: 4471, qty: 5 }]);
    const second = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'retract', idarticulo: 4471, retractsEventId: first[0].event.id }],
      { startSeq: 2, head: first[0].hash },
    );
    const result = await pushEvents(db, ana.token, { events: [...first, ...second] });
    expect(result.status).toBe(200);
    expect(await stored(ana.id)).toBe(2);
  });

  it('refuses an event belonging to another counter', async () => {
    const { sessionId, ana, luis } = await dispatched();
    const batch = counts(sessionId, luis.id, 1, 1181);
    const result = await pushEvents(db, ana.token, { events: batch });
    expect(result.status).toBe(400);
  });

  // --- finish ---------------------------------------------------------------

  it('confirms a finish whose manifest verifies', async () => {
    const { sessionId, ana } = await dispatched();
    const content = counts(sessionId, ana.id, 4, 1181);
    const fin = finishAfter(sessionId, ana.id, content);
    const result = await pushEvents(db, ana.token, { events: [...content, ...fin] });
    expect(result.body).toMatchObject({ counterEstado: 'terminado_confirmado', acceptedThrough: 5 });

    const row = await db.query<{ estado: string; final_seq: number; finish_reason: string | null }>(
      'select estado, final_seq, finish_reason from counters where id = $1',
      [ana.id],
    );
    expect(row[0]).toMatchObject({ estado: 'terminado_confirmado', final_seq: 4, finish_reason: null });
  });

  it('confirms a counter who recorded nothing at all', async () => {
    // Assigned a section, walked over, found it already counted by receiving.
    // `finalSeq = 0`, `headHash = genesis`, `finish.seq = 1`.
    const { sessionId, ana } = await dispatched();
    const fin = finishAfter(sessionId, ana.id, []);
    expect(fin[0].event.seq).toBe(1);
    expect((fin[0].event as { finalSeq: number }).finalSeq).toBe(0);

    const result = await pushEvents(db, ana.token, { events: fin });
    expect(result.body).toMatchObject({ counterEstado: 'terminado_confirmado' });
  });

  it('records terminado_incompleto, with the reason, when the manifest overstates', async () => {
    // Note what cannot happen: under the contiguity rule a `finish` cannot
    // arrive on the wire ahead of its own content, because the batch must start
    // at `storedMaxSeq + 1`. The state is reached by a manifest that claims more
    // than the chain holds — which is exactly the shape a replacement tablet
    // with a stale resume point produces, and precisely what rules 3 and 4 exist
    // to catch.
    const { sessionId, ana } = await dispatched();
    const content = counts(sessionId, ana.id, 3, 1181);
    const head = content[2].hash;
    const lying = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'finish', idarticulo: null, finalSeq: 9, headHash: head }],
      { startSeq: 4, head },
    );
    const result = await pushEvents(db, ana.token, { events: [...content, ...lying] });
    expect(result.body).toMatchObject({ counterEstado: 'terminado_incompleto' });
    const row = await db.query<{ finish_reason: string }>(
      'select finish_reason from counters where id = $1',
      [ana.id],
    );
    expect(row[0].finish_reason).toMatch(/seq 4/);
  });

  it('recovers from terminado_incompleto to confirmado without anybody intervening', async () => {
    // The transition the admin actually sees. `estado` and `finish_reason` are
    // stored on the counter and recomputed from the **whole** chain on every
    // push — never from the batch alone — so the next thing this counter does
    // re-decides it. `/sync` reads the stored value rather than deriving it,
    // which is what keeps a polled endpoint cheap; that is safe precisely
    // because the only thing that can change a counter's chain is a push by
    // that counter.
    const { sessionId, ana } = await dispatched();
    const content = counts(sessionId, ana.id, 3, 1181);
    const head = content[2].hash;
    const lying = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'finish', idarticulo: null, finalSeq: 9, headHash: head }],
      { startSeq: 4, head },
    );
    await pushEvents(db, ana.token, { events: [...content, ...lying] });

    const before = await sessionSync(db, sessionId);
    const anaBefore = (before.body as {
      session: { readyToSeal: { kind: string }[] };
      counters: { id: string; estado: string; finishReason: string | null }[];
    });
    expect(anaBefore.counters.find((c) => c.id === ana.id)!.estado).toBe('terminado_incompleto');
    expect(anaBefore.counters.find((c) => c.id === ana.id)!.finishReason).toBeTruthy();
    expect(anaBefore.session.readyToSeal.some((b) => b.kind === 'contador-sin-terminar')).toBe(true);

    // The counter reopens and finishes properly. `seq` carries on unbroken.
    const fixed = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'reopen', idarticulo: null }],
      { startSeq: 5, head: lying[0].hash },
    );
    const proper = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'finish', idarticulo: null, finalSeq: 5, headHash: fixed[0].hash }],
      { startSeq: 6, head: fixed[0].hash },
    );
    await pushEvents(db, ana.token, { events: [...fixed, ...proper] });

    const after = await sessionSync(db, sessionId);
    const anaAfter = (after.body as { counters: { id: string; estado: string; finishReason: string | null }[] })
      .counters.find((c) => c.id === ana.id)!;
    expect(anaAfter).toMatchObject({ estado: 'terminado_confirmado', finishReason: null });
  });

  it('reopen continues the numbering, flags the amendment, and a second finish confirms', async () => {
    const { sessionId, ana } = await dispatched();
    const content = counts(sessionId, ana.id, 2, 1181);
    const fin = finishAfter(sessionId, ana.id, content);
    await pushEvents(db, ana.token, { events: [...content, ...fin] });

    // A stray box. `seq` carries on unbroken — a new chain would defeat the
    // manifest.
    const head = fin[0].hash;
    const second = chainFor(
      sessionId,
      ana.id,
      [
        { kind: 'reopen', idarticulo: null },
        { kind: 'add', idarticulo: 1181, qty: 4 },
      ],
      { startSeq: 4, head },
    );
    const reopened = await pushEvents(db, ana.token, { events: second });
    expect(reopened.body).toMatchObject({ counterEstado: 'contando' });

    const fin2 = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'finish', idarticulo: null, finalSeq: 5, headHash: second[1].hash }],
      { startSeq: 6, head: second[1].hash },
    );
    const done = await pushEvents(db, ana.token, { events: fin2 });
    expect(done.body).toMatchObject({ counterEstado: 'terminado_confirmado' });

    // The amendment log: everything after the *first* finish, derived from the
    // log rather than stored as a flag that could drift.
    const page = await sessionEvents(db, sessionId, {});
    const mine = (page.body as { events: { counterId: string; seq: number; kind: string }[] }).events.filter(
      (e) => e.counterId === ana.id,
    );
    const firstFinish = mine.find((e) => e.kind === 'finish')!.seq;
    expect(mine.filter((e) => e.seq > firstFinish).map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  // --- device binding and skew ---------------------------------------------

  it('binds the first device, accepts the second, and keeps both visible', async () => {
    const { sessionId, ana } = await dispatched();
    const first = counts(sessionId, ana.id, 2, 1181, { deviceId: 'tablet-a' });
    await pushEvents(db, ana.token, { events: first });
    // The same chain, continued from the spare. Not a fork: the tablet resumed
    // from the server, which is what `/resume` is for.
    const second = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'add', idarticulo: 1181, qty: 3 }],
      { startSeq: 3, head: first[1].hash, deviceId: 'tablet-b' },
    );
    const result = await pushEvents(db, ana.token, { events: second });

    expect(result.status).toBe(200);
    const row = await db.query<{ device_id: string; device_ids_seen: string[] }>(
      'select device_id, device_ids_seen from counters where id = $1',
      [ana.id],
    );
    expect(row[0].device_id).toBe('tablet-b');
    expect(row[0].device_ids_seen).toEqual(['tablet-a', 'tablet-b']);
  });

  it('records the largest skew ever seen, and never corrects a timestamp', async () => {
    const { sessionId, ana } = await dispatched();
    const serverAt = '2026-08-31T14:00:00.000Z';
    // Nine minutes fast.
    const fast = counts(sessionId, ana.id, 1, 1181, {
      at: () => '2026-08-31T14:09:00.000Z',
    });
    await pushEvents(db, ana.token, { events: fast }, { now: () => serverAt });
    // Then correct.
    const ok = chainFor(
      sessionId,
      ana.id,
      [{ kind: 'add', idarticulo: 1181, qty: 2 }],
      { startSeq: 2, head: fast[0].hash, at: () => serverAt },
    );
    await pushEvents(db, ana.token, { events: ok }, { now: () => serverAt });

    const row = await db.query<{ clock_skew_ms: number }>(
      'select clock_skew_ms from counters where id = $1',
      [ana.id],
    );
    expect(row[0].clock_skew_ms).toBe(9 * 60 * 1000);

    // The stamps themselves are untouched: rewriting them would change the
    // hashes and break the chain to fix a cosmetic problem.
    const stamps = await db.query<{ client_at: string }>(
      'select client_at from events where counter_id = $1 order by seq',
      [ana.id],
    );
    expect(stamps[0].client_at).toBe('2026-08-31T14:09:00.000Z');
  });

  // --- the read endpoints ---------------------------------------------------

  it('/sync reports each counter and why the session cannot be sealed', async () => {
    const { sessionId, ana, luis } = await dispatched();
    await counterFetch(db, ana.token);
    const content = counts(sessionId, ana.id, 2, 1181);
    await pushEvents(db, ana.token, { events: [...content, ...finishAfter(sessionId, ana.id, content)] });

    const result = await sessionSync(db, sessionId);
    const body = result.body as {
      session: { readyToSeal: { kind: string; counterId?: string }[] };
      counters: { id: string; estado: string; storedMaxSeq: number; pendingFetch: boolean; deviceIds: string[] }[];
    };
    const anaRow = body.counters.find((c) => c.id === ana.id)!;
    expect(anaRow).toMatchObject({ estado: 'terminado_confirmado', storedMaxSeq: 3, pendingFetch: false });
    expect(anaRow.deviceIds).toEqual(['tablet-a']);

    // Luis never downloaded and never finished: two independent reasons.
    expect(body.session.readyToSeal.map((b) => b.kind).sort()).toEqual([
      'contador-sin-descargar',
      'contador-sin-terminar',
    ]);
    expect(body.session.readyToSeal.every((b) => b.counterId === luis.id)).toBe(true);
  });

  it('/events pages in arrival order and overlaps its own cursor', async () => {
    const { sessionId, ana } = await dispatched();
    await pushEvents(db, ana.token, { events: counts(sessionId, ana.id, 5, 1181) });

    const page = await sessionEvents(db, sessionId, { limit: '3' });
    const body = page.body as { events: { seq: number; serverSeq: string }[]; nextCursor: string };
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(BigInt(body.nextCursor)).toBeGreaterThan(0n);

    // The overlap is applied inside the endpoint, so a caller cannot forget it:
    // asking from the cursor returns the page again rather than skipping it.
    const next = await sessionEvents(db, sessionId, { since: body.nextCursor });
    const seqs = (next.body as { events: { seq: number }[] }).events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('/events carries the quantity as the string that was hashed', async () => {
    const { sessionId, ana } = await dispatched();
    // `21 - 20.8` in IEEE754. The canonical decimal string is what the chain was
    // built over, so it is what has to come back.
    const awkward = chainFor(sessionId, ana.id, [
      { kind: 'add', idarticulo: 1181, qty: 21 - 20.8 },
    ]);
    await pushEvents(db, ana.token, { events: awkward });
    const page = await sessionEvents(db, sessionId, {});
    expect((page.body as { events: { cantidad: string }[] }).events[0].cantidad).toBe(
      String(21 - 20.8),
    );
  });

  // --- resume ---------------------------------------------------------------

  it('/resume tells a replacement tablet where the chain stands', async () => {
    const { sessionId, ana } = await dispatched();
    const empty = await counterResume(db, ana.token);
    expect(empty.body).toMatchObject({
      storedMaxSeq: 0,
      headHash: genesisHash(sessionId, ana.id),
      counterEstado: 'asignado',
    });

    const batch = counts(sessionId, ana.id, 3, 1181);
    await pushEvents(db, ana.token, { events: batch });
    const after = await counterResume(db, ana.token);
    expect(after.body).toMatchObject({ storedMaxSeq: 3, headHash: batch[2].hash, counterEstado: 'contando' });
    // The clock watermark a spare tablet seeds itself from, so it cannot stamp
    // events that sort before the ones they continue.
    expect((after.body as { lastClientAt: string }).lastClientAt).toBe(batch[2].event.at);
  });

  it('/resume sends no catalogue and no quantity — the allowlist is next door', async () => {
    const { ana } = await dispatched();
    const result = await counterResume(db, ana.token);
    const keys = Object.keys(result.body as object).sort();
    expect(keys).toEqual([
      'counterEstado',
      'counterId',
      'headHash',
      'lastClientAt',
      'serverAt',
      'sessionEstado',
      'sessionId',
      'storedMaxSeq',
    ]);
  });

  it('the counter’s catalogue is byte-identical to what P2.1 shipped', async () => {
    // The acceptance item this task must not break. Nothing has widened the
    // allowlist; the leak test in tests/domain/counterView.test.ts still holds
    // over the same object, and this asserts the endpoint still builds it.
    //
    // **`yaRegistrados` is the one part that moves, and it is supposed to**
    // (P2.3.5 §6b): it is a set of `idarticulo`s carrying presence and never
    // magnitude, the same information the neutral checkmark already conveys.
    // So the catalogue is compared byte for byte and that field is compared for
    // what it is allowed to contain.
    const { sessionId, ana } = await dispatched();
    const before = (await counterFetch(db, ana.token, { record: false }))
      .body as CounterPayload;
    await pushEvents(db, ana.token, { events: counts(sessionId, ana.id, 3, 1181) });
    const after = (await counterFetch(db, ana.token, { record: false })).body as CounterPayload;

    const catalogue = (payload: CounterPayload) =>
      JSON.stringify({ ...payload, yaRegistrados: undefined });
    expect(catalogue(after)).toBe(catalogue(before));
    expect(before.yaRegistrados).toEqual([]);
    expect(after.yaRegistrados).toEqual([1181]);
    expect(JSON.stringify(after)).not.toMatch(/existencia|costo|"hash"|prevHash/);
    // Ids and nothing else — no quantity rode along with the one that moved.
    expect(after.yaRegistrados.every((id) => Number.isInteger(id))).toBe(true);
  });
});
