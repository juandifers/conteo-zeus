/**
 * Two counters' work on one tablet — P2.3.5 §6a.
 *
 * Pedro takes over Luis's physical tablet. Luis's Dexie rows are still on it,
 * some of them unsynced, and the failure this file exists to rule out is the
 * quiet one: Pedro's arrival stranding Luis's morning, or — worse — Pedro's
 * session re-attributing it.
 *
 * The store has been keyed by `(sessionId, counterId)` since P2.2, so the
 * separation was already there. What was missing is that **nothing looked at a
 * queue whose owner was not in the foreground**, and a queue nothing looks at
 * never drains. Everything below is about that: both queues visible, both
 * drainable, neither re-attributed, and no way for the device to decide on its
 * own that somebody else's counts can go.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryChain,
  chainEvents,
  genesisHash,
  type ChainedEvent,
  type CounterChainRepository,
  type CounterPayload,
} from '../../src/domain';
import { ConteoDb, DexieAssignmentStore, DexieCounterChain } from '../../src/store';
import { clearStaleAssignments, drainOthers, otherOutboxes } from '../../src/ui/counter/handover';
import type { Api } from '../../src/ui/api';
import { addCount, resetFactory } from '../domain/factory';

const SESSION = 'session-1';
const LUIS = 'counter-luis';
const PEDRO = 'counter-pedro';
const LUIS_TOKEN = 'L'.repeat(22);
const PEDRO_TOKEN = 'P'.repeat(22);

let n = 0;

/** `count` chained events for one counter, starting at seq 1. */
function chainFor(counterId: string, count: number): ChainedEvent[] {
  resetFactory();
  const events = Array.from({ length: count }, (_, i) =>
    addCount(1181, i + 1, {
      id: `${counterId}-${++n}`,
      sessionId: SESSION,
      counterId,
      seq: i + 1,
    }),
  );
  return chainEvents(genesisHash(SESSION, counterId), events);
}

function payloadFor(counterId: string, nombre: string): CounterPayload {
  return {
    session: {
      id: SESSION,
      bodega: '01',
      fechaCorte: '2026/08/25',
      nombre: null,
      mostrarMarcaRegistrado: true,
    },
    counter: { id: counterId, nombre },
    secciones: [],
    yaRegistrados: [],
  };
}

describe('one tablet, two counters', () => {
  let db: ConteoDb;
  let chain: CounterChainRepository;
  let assignments: DexieAssignmentStore;

  beforeEach(async () => {
    db = new ConteoDb(`handover-${Date.now()}-${Math.random()}`);
    chain = new DexieCounterChain(db);
    assignments = new DexieAssignmentStore(db);
    await assignments.save(LUIS_TOKEN, payloadFor(LUIS, 'Luis'), '2026-08-31T08:00:00.000Z');
    await assignments.save(PEDRO_TOKEN, payloadFor(PEDRO, 'Pedro'), '2026-08-31T11:00:00.000Z');
    for (const link of chainFor(LUIS, 23)) await chain.appendChained(link);
    for (const link of chainFor(PEDRO, 4)) await chain.appendChained(link);
  });

  afterEach(() => db.close());

  it('sees both queues, keyed by counter and not by device', async () => {
    const pending = await chain.pendingOutboxes();
    expect(pending).toEqual([
      { sessionId: SESSION, counterId: LUIS, pendientes: 23 },
      { sessionId: SESSION, counterId: PEDRO, pendientes: 4 },
    ]);
  });

  it('names the queue whose owner went home, while Pedro is counting', async () => {
    // «23 registros sin subir» attached to nobody is a number the person
    // holding the tablet cannot act on. The action is specific: find Luis, or
    // tell the administrator whose tablet this is.
    const others = await otherOutboxes(chain, assignments, PEDRO);
    expect(others).toEqual([
      { sessionId: SESSION, counterId: LUIS, nombre: 'Luis', token: LUIS_TOKEN, pendientes: 23 },
    ]);
  });

  it('does not report the counter in the foreground back to themselves', async () => {
    const others = await otherOutboxes(chain, assignments, LUIS);
    expect(others.map((other) => other.counterId)).toEqual([PEDRO]);
  });

  it('drains the background queue, and attributes every event to its own counter', async () => {
    const pushed: { token: string; counterIds: string[]; seqs: number[] }[] = [];
    const api: Api = {
      get: async () => ({}) as never,
      patch: async () => ({}) as never,
      post: async (path: string, body?: unknown) => {
        const links = (body as { events: ChainedEvent[] }).events;
        pushed.push({
          token: /\/api\/c\/(\w+)\//.exec(path)![1],
          counterIds: [...new Set(links.map((link) => link.event.counterId!))],
          seqs: links.map((link) => link.event.seq),
        });
        return {
          acceptedThrough: links[links.length - 1].event.seq,
          headHash: 'whatever',
          counterEstado: 'contando',
          serverAt: '2026-08-31T17:40:00.000Z',
        } as never;
      },
    };

    const others = await otherOutboxes(chain, assignments, PEDRO);
    await drainOthers(api, chain, others);

    // One push, on **Luis's** link, carrying only Luis's events.
    expect(pushed).toHaveLength(1);
    expect(pushed[0].token).toBe(LUIS_TOKEN);
    expect(pushed[0].counterIds).toEqual([LUIS]);
    expect(pushed[0].seqs).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));

    // Luis's queue is empty; Pedro's is untouched, because it is not this
    // drain's business and he is still counting.
    expect(await chain.pendingOutboxes()).toEqual([
      { sessionId: SESSION, counterId: PEDRO, pendientes: 4 },
    ]);
  });

  it('keeps the events when the push fails, and reports the queue again', async () => {
    const api: Api = {
      get: async () => ({}) as never,
      patch: async () => ({}) as never,
      post: async () => {
        throw new Error('no hay señal');
      },
    };
    await drainOthers(api, chain, await otherOutboxes(chain, assignments, PEDRO));
    const still = await otherOutboxes(chain, assignments, PEDRO);
    expect(still[0].pendientes).toBe(23);
  });

  it('survives the tablet being switched off between shifts', async () => {
    // The whole reason the outbox is a flag on a row rather than something in a
    // closure: a new page is a new JavaScript world, and Luis's morning has to
    // be there when Pedro opens the tablet after lunch.
    const name = db.name;
    db.close();
    const reopened = new ConteoDb(name);
    const after = new DexieCounterChain(reopened);
    expect(await after.pendingOutboxes()).toEqual([
      { sessionId: SESSION, counterId: LUIS, pendientes: 23 },
      { sessionId: SESSION, counterId: PEDRO, pendientes: 4 },
    ]);
    reopened.close();
    db = new ConteoDb(name);
  });

  it('offers no way to discard another person’s counts', async () => {
    // Stated as a test because it is a decision, not an omission. There is no
    // state in which a tablet should decide on its own that somebody else's
    // unsynced counts can go, so the port has no method that would let it.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(chain));
    expect(methods.filter((name) => /clear|delete|drop|purge|wipe/i.test(name))).toEqual([]);
  });

  it('forgets another session’s link only once nothing on it is owed', async () => {
    // Entering a new count clears the previous ones (the reported bug was old
    // sessions mixing into the current link), but «no limpiar tableta» still
    // holds: a link whose counter has unsynced rows stays until they land.
    const OLD_SESSION = 'session-0';
    const OLD_TOKEN = 'O'.repeat(22);
    const OLD_COUNTER = 'counter-old';
    const oldPayload = payloadFor(OLD_COUNTER, 'Marta');
    oldPayload.session = { ...oldPayload.session, id: OLD_SESSION };
    await assignments.save(OLD_TOKEN, oldPayload, '2026-07-01T08:00:00.000Z');

    // Nothing pending under the old session: the link is pure catalogue and a
    // sweep from today's session removes it. Today's links stay.
    await clearStaleAssignments(chain, assignments, SESSION);
    expect((await assignments.list()).map((link) => link.token).sort()).toEqual(
      [LUIS_TOKEN, PEDRO_TOKEN].sort(),
    );

    // With a queue still owed under the old session, the link survives the
    // sweep — it is what the background drain needs to find a token.
    await assignments.save(OLD_TOKEN, oldPayload, '2026-07-01T08:00:00.000Z');
    resetFactory();
    const owed = chainEvents(
      genesisHash(OLD_SESSION, OLD_COUNTER),
      [addCount(1181, 2, { id: 'old-1', sessionId: OLD_SESSION, counterId: OLD_COUNTER, seq: 1 })],
    );
    for (const link of owed) await chain.appendChained(link);
    await clearStaleAssignments(chain, assignments, SESSION);
    expect((await assignments.list()).map((link) => link.token)).toContain(OLD_TOKEN);
  });

  it('is the same behaviour in memory, which is what keeps the port honest', async () => {
    const memory = new MemoryChain();
    for (const link of chainFor(LUIS, 3)) await memory.appendChained(link);
    for (const link of chainFor(PEDRO, 1)) await memory.appendChained(link);
    expect(await memory.pendingOutboxes()).toEqual([
      { sessionId: SESSION, counterId: LUIS, pendientes: 3 },
      { sessionId: SESSION, counterId: PEDRO, pendientes: 1 },
    ]);
    await memory.markSynced(SESSION, LUIS, 3);
    expect(await memory.pendingOutboxes()).toEqual([
      { sessionId: SESSION, counterId: PEDRO, pendientes: 1 },
    ]);
  });
});
