/**
 * The counter state machine and the sealing gate — `src/domain/sync.ts`.
 *
 * The property under test throughout is that the server believes **only what it
 * holds**. A `finish` is a claim; a chain the server can walk from seq 1 with no
 * hole, ending on the hash the claim named, is a proof. Every test below is one
 * way the two come apart.
 */
import { describe, expect, it } from 'vitest';

import {
  chainEvents,
  checkFinishManifest,
  deriveCounterEstado,
  genesisHash,
  postFinishSeqs,
  sessionReadyToSeal,
  type CounterSyncState,
  type StoredCounterEvent,
} from '../../src/domain';
import { finish, reopen, resetFactory, setCount } from './factory';

const SESSION = 'session-1';
const COUNTER = 'counter-ana';

/**
 * A counter's chain as the *server* holds it: `seq` from 1, each link's hash
 * computed by the same module the device would have used.
 */
function chainRows(count: number, options: { finishAfter?: boolean; reopenAt?: number } = {}): StoredCounterEvent[] {
  resetFactory();
  const events = [];
  for (let i = 1; i <= count; i++) {
    events.push(
      setCount(1181, i, { id: `e${i}`, sessionId: SESSION, counterId: COUNTER, seq: i }),
    );
  }
  if (options.finishAfter) {
    // The manifest has to be computed against the chain that precedes it, which
    // is exactly what the device does: `finalSeq` is the last content event and
    // `headHash` is the head at it.
    const links = chainEvents(genesisHash(SESSION, COUNTER), events);
    const head = links.length === 0 ? genesisHash(SESSION, COUNTER) : links[links.length - 1].hash;
    events.push(
      finish(count, head, { id: `f${count}`, sessionId: SESSION, counterId: COUNTER, seq: count + 1 }),
    );
  }
  return chainEvents(genesisHash(SESSION, COUNTER), events).map((link) => ({
    seq: link.event.seq,
    kind: link.event.kind,
    hash: link.hash,
    prevHash: link.prevHash,
    finalSeq: link.event.kind === 'finish' ? link.event.finalSeq : null,
    headHash: link.event.kind === 'finish' ? link.event.headHash : null,
  }));
}

describe('checkFinishManifest — the four rules, one at a time', () => {
  const stored = chainRows(4);
  const head = stored[stored.length - 1].hash;
  const good = {
    sessionId: SESSION,
    counterId: COUNTER,
    manifest: { finalSeq: 4, headHash: head },
    finishSeq: 5,
    finishPrevHash: head,
    stored,
  };

  it('accepts a manifest that agrees with the chain', () => {
    expect(checkFinishManifest(good)).toEqual({ ok: true });
  });

  it('1. refuses a finish whose seq is not finalSeq + 1', () => {
    // The manifest is about the events *before* the finish. A finish that
    // numbers itself anywhere else is describing a chain other than its own.
    const verdict = checkFinishManifest({ ...good, finishSeq: 7 });
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok === false && verdict.reason).toMatch(/seq 7.*finalSeq 4.*seq 5/);
  });

  it('2. refuses a finish whose prevHash is not the head it claims', () => {
    const verdict = checkFinishManifest({ ...good, finishPrevHash: 'a'.repeat(64) });
    expect(verdict.ok === false && verdict.reason).toMatch(/prevHash ≠ headHash/);
  });

  it('3. refuses a chain with a hole, and names the hole', () => {
    // The rule that catches the real case: the finish reached the server over
    // the office wifi and some of the content events did not.
    const holed = stored.filter((row) => row.seq !== 2 && row.seq !== 3);
    const verdict = checkFinishManifest({ ...good, stored: holed });
    expect(verdict.ok === false && verdict.reason).toBe('faltan seq 2–3');
  });

  it('3. compacts non-adjacent holes into a list somebody can act on', () => {
    const wide = chainRows(9);
    const verdict = checkFinishManifest({
      sessionId: SESSION,
      counterId: COUNTER,
      manifest: { finalSeq: 9, headHash: wide[8].hash },
      finishSeq: 10,
      finishPrevHash: wide[8].hash,
      stored: wide.filter((row) => ![3, 4, 7].includes(row.seq)),
    });
    expect(verdict.ok === false && verdict.reason).toBe('faltan seq 3–4, 7');
  });

  it('4. refuses a chain of the right length that ends somewhere else', () => {
    // Rule 3 alone would pass a chain of the right shape holding somebody
    // else's events. Both rules, always.
    const swapped = stored.map((row) =>
      row.seq === 4 ? { ...row, hash: 'b'.repeat(64) } : row,
    );
    const verdict = checkFinishManifest({ ...good, stored: swapped });
    expect(verdict.ok === false && verdict.reason).toMatch(/la cadena guardada termina en/);
  });

  it('confirms a counter who recorded nothing at all', () => {
    // Assigned a section, walked over, found it already counted by receiving.
    // `finalSeq = 0`, `headHash = genesis`, `finish.seq = 1`. Entirely ordinary,
    // and an off-by-one here fails on the least suspicious person's tablet.
    const genesis = genesisHash(SESSION, COUNTER);
    expect(
      checkFinishManifest({
        sessionId: SESSION,
        counterId: COUNTER,
        manifest: { finalSeq: 0, headHash: genesis },
        finishSeq: 1,
        finishPrevHash: genesis,
        stored: [],
      }),
    ).toEqual({ ok: true });
  });

  it('refuses an empty manifest that names a head other than the genesis', () => {
    expect(
      checkFinishManifest({
        sessionId: SESSION,
        counterId: COUNTER,
        manifest: { finalSeq: 0, headHash: 'c'.repeat(64) },
        finishSeq: 1,
        finishPrevHash: 'c'.repeat(64),
        stored: [],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('deriveCounterEstado — what the server may say', () => {
  it('asignado when nothing has arrived', () => {
    expect(deriveCounterEstado(SESSION, COUNTER, [])).toMatchObject({ estado: 'asignado' });
  });

  it('contando when events have arrived and no finish has', () => {
    expect(deriveCounterEstado(SESSION, COUNTER, chainRows(3))).toMatchObject({
      estado: 'contando',
    });
  });

  it('terminado_confirmado when the manifest verifies', () => {
    expect(deriveCounterEstado(SESSION, COUNTER, chainRows(3, { finishAfter: true }))).toMatchObject({
      estado: 'terminado_confirmado',
      reason: null,
      finalSeq: 3,
    });
  });

  it('terminado_incompleto, with the reason, when the finish outran its content', () => {
    // The realistic order of arrival: the tablet drained the finish over the
    // office wifi and the content events are still in a cold room.
    const rows = chainRows(4, { finishAfter: true });
    const early = rows.filter((row) => row.kind === 'finish' || row.seq === 1);
    const verdict = deriveCounterEstado(SESSION, COUNTER, early);
    expect(verdict.estado).toBe('terminado_incompleto');
    expect(verdict.reason).toBe('faltan seq 2–4');
  });

  it('flips to terminado_confirmado once the hole fills, with nobody doing anything', () => {
    const rows = chainRows(4, { finishAfter: true });
    const early = rows.filter((row) => row.kind === 'finish' || row.seq === 1);
    expect(deriveCounterEstado(SESSION, COUNTER, early).estado).toBe('terminado_incompleto');
    expect(deriveCounterEstado(SESSION, COUNTER, rows).estado).toBe('terminado_confirmado');
  });

  it('never stores terminado_local: it is not a state the server can reach', () => {
    // The device's claim about itself is not a fact the server can assert. Every
    // path through this function has to land on one of the four server states.
    const reachable = new Set(
      [[], chainRows(2), chainRows(2, { finishAfter: true })].map(
        (rows) => deriveCounterEstado(SESSION, COUNTER, rows).estado,
      ),
    );
    expect([...reachable].every((estado) => estado !== ('terminado_local' as string))).toBe(true);
  });

  it('returns to contando after a reopen', () => {
    resetFactory();
    const events = [
      setCount(1181, 1, { id: 'e1', sessionId: SESSION, counterId: COUNTER, seq: 1 }),
    ];
    const links = chainEvents(genesisHash(SESSION, COUNTER), events);
    events.push(
      finish(1, links[0].hash, { id: 'f', sessionId: SESSION, counterId: COUNTER, seq: 2 }) as never,
    );
    events.push(reopen({ id: 'r', sessionId: SESSION, counterId: COUNTER, seq: 3 }) as never);
    const rows = chainEvents(genesisHash(SESSION, COUNTER), events).map((link) => ({
      seq: link.event.seq,
      kind: link.event.kind,
      hash: link.hash,
      prevHash: link.prevHash,
      finalSeq: link.event.kind === 'finish' ? link.event.finalSeq : null,
      headHash: link.event.kind === 'finish' ? link.event.headHash : null,
    }));
    expect(deriveCounterEstado(SESSION, COUNTER, rows)).toMatchObject({ estado: 'contando' });
  });
});

describe('postFinishSeqs — the amendment log', () => {
  it('is empty before anybody finishes', () => {
    expect(postFinishSeqs(chainRows(3))).toEqual([]);
  });

  it('flags everything after the first finish, the reopen included', () => {
    const rows = chainRows(2, { finishAfter: true });
    const extended: StoredCounterEvent[] = [
      ...rows,
      { seq: 4, kind: 'reopen', hash: 'x', prevHash: 'y', finalSeq: null, headHash: null },
      { seq: 5, kind: 'add', hash: 'x', prevHash: 'y', finalSeq: null, headHash: null },
    ];
    expect(postFinishSeqs(extended)).toEqual([4, 5]);
  });

  it('is derived from position, so a late arrival is not stamped by when it arrived', () => {
    // The reason this is not a stored boolean. An event written before the
    // finish and pushed after it would otherwise be an amendment for ever.
    const rows = chainRows(3, { finishAfter: true });
    const shuffled = [rows[3], rows[0], rows[2], rows[1]];
    expect(postFinishSeqs(shuffled)).toEqual([]);
  });
});

describe('sessionReadyToSeal — gates on the proof, never on the claim', () => {
  const ready: CounterSyncState = {
    id: 'ana',
    nombre: 'Ana',
    estado: 'terminado_confirmado',
    forked: false,
    fetchedAt: '2026-08-31T12:00:00.000Z',
    finishReason: null,
    chainComplete: true,
  };

  it('is empty when every counter is confirmed', () => {
    expect(sessionReadyToSeal({ counters: [ready, { ...ready, id: 'luis', nombre: 'Luis' }] })).toEqual([]);
  });

  it('refuses a session with no counters rather than reading as ready', () => {
    expect(sessionReadyToSeal({ counters: [] })).toEqual([{ kind: 'sin-contadores' }]);
  });

  it('refuses on an unfinished counter, naming which', () => {
    expect(
      sessionReadyToSeal({ counters: [ready, { ...ready, id: 'luis', nombre: 'Luis', estado: 'contando' }] }),
    ).toEqual([
      { kind: 'contador-sin-terminar', counterId: 'luis', nombre: 'Luis', estado: 'contando', detalle: null },
    ]);
  });

  it('refuses on terminado_incompleto, and carries the why', () => {
    const blockers = sessionReadyToSeal({
      counters: [{ ...ready, estado: 'terminado_incompleto', finishReason: 'faltan seq 88–91' }],
    });
    expect(blockers).toEqual([
      {
        kind: 'contador-sin-terminar',
        counterId: 'ana',
        nombre: 'Ana',
        estado: 'terminado_incompleto',
        detalle: 'faltan seq 88–91',
      },
    ]);
  });

  it('refuses on a fork, independently of everything else', () => {
    expect(sessionReadyToSeal({ counters: [{ ...ready, forked: true }] })).toEqual([
      { kind: 'contador-bifurcado', counterId: 'ana', nombre: 'Ana' },
    ]);
  });

  it("refuses on a counter whose device never downloaded (P2.1's pendiente)", () => {
    expect(sessionReadyToSeal({ counters: [{ ...ready, fetchedAt: null }] })).toEqual([
      { kind: 'contador-sin-descargar', counterId: 'ana', nombre: 'Ana' },
    ]);
  });

  it('refuses a counter who clicked done but whose proof never arrived', () => {
    // `terminado_local` is a claim. The gate is `terminado_confirmado`, which is
    // a complete, gap-free, hash-consistent chain — and the server, which has
    // no `terminado_local` to store, sees such a counter as `contando`.
    expect(sessionReadyToSeal({ counters: [{ ...ready, estado: 'contando' }] })).toHaveLength(1);
  });

  it('returns every reason, never the first', () => {
    // An admin chasing tablets at five o'clock needs the list, not its head.
    const blockers = sessionReadyToSeal({
      counters: [
        { ...ready, estado: 'contando', forked: true, fetchedAt: null },
        { ...ready, id: 'luis', nombre: 'Luis', estado: 'terminado_incompleto' },
      ],
    });
    expect(blockers.map((b) => b.kind)).toEqual([
      'contador-sin-descargar',
      'contador-bifurcado',
      'contador-sin-terminar',
      'contador-sin-terminar',
    ]);
  });
});

/**
 * A counter who was taken out of the count, and the one way a session with
 * somebody missing from it can still be sealed — P2.3.5 §5.
 *
 * `retirado` is the only state in `CounterEstado` that is not derived from the
 * chain: it is an admin decision, recorded in `session_actions` with a reason.
 * Without it Luis going home at eleven would mean this session could never be
 * sealed, and «never» is not a state an inventory can be left in.
 */
describe('sessionReadyToSeal — a retired counter (P2.3.5 §5)', () => {
  const retired: CounterSyncState = {
    id: 'luis',
    nombre: 'Luis',
    estado: 'retirado',
    forked: false,
    fetchedAt: '2026-08-31T08:00:00.000Z',
    finishReason: null,
    chainComplete: true,
  };

  it('accepts a retired counter whose chain is whole — their counts are real data', () => {
    // Luis did not finish; that is what retirement records. His sixty counts
    // still happened and they belong in the file, so the gate is on the chain
    // being complete rather than on a `finish` that was never written.
    expect(sessionReadyToSeal({ counters: [retired] })).toEqual([]);
  });

  it('blocks on a retired counter whose chain has a hole in it', () => {
    // §5b: the tablet went home in a jacket with seq 61–83 on it, and 84–90
    // arrived over a moment of signal. What the server can see is the hole.
    expect(sessionReadyToSeal({ counters: [{ ...retired, chainComplete: false }] })).toEqual([
      { kind: 'contador-retirado-incompleto', counterId: 'luis', nombre: 'Luis' },
    ]);
  });

  it('is satisfied by an explicit `sellar_sin_registros`, and by nothing weaker', () => {
    // The gate cannot be satisfied by assertion — that is its whole value — so
    // the only way past it is an action on the chain naming the counter and the
    // range, which is then printed on the acta.
    const counters = [{ ...retired, chainComplete: false }];
    expect(sessionReadyToSeal({ counters })).toHaveLength(1);
    expect(
      sessionReadyToSeal({ counters, overrides: [{ counterId: 'luis', faltan: '61–83' }] }),
    ).toEqual([]);
    // Signed for somebody else, it does nothing here.
    expect(
      sessionReadyToSeal({ counters, overrides: [{ counterId: 'ana', faltan: '4' }] }),
    ).toHaveLength(1);
  });

  it('lets a counter who never arrived be resolved by retiring them (§5c)', () => {
    // «María fue asignada y nunca llegó»: `asignado`, no events, no fetch. Her
    // articles are reassigned and she is retired, and that *is* the resolution
    // — blocking on the tablet she never opened would leave the session
    // unsealable for ever. Her chain is empty, which is complete.
    expect(
      sessionReadyToSeal({ counters: [{ ...retired, id: 'maria', nombre: 'María', fetchedAt: null }] }),
    ).toEqual([]);
  });

  it('never waives a fork, whatever an admin decided about who is still counting', () => {
    // Two chains claiming one `seq` means the server holds events it cannot
    // order. No decision about staffing changes that.
    expect(sessionReadyToSeal({ counters: [{ ...retired, forked: true }] })).toEqual([
      { kind: 'contador-bifurcado', counterId: 'luis', nombre: 'Luis' },
    ]);
  });

  it('does not ask a retired counter to have finished', () => {
    // The `contador-sin-terminar` blocker must not also fire: it would be
    // unanswerable, because the person it names has gone home.
    const blockers = sessionReadyToSeal({ counters: [{ ...retired, chainComplete: false }] });
    expect(blockers.map((blocker) => blocker.kind)).toEqual(['contador-retirado-incompleto']);
  });
});
