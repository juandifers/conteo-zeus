/**
 * The outbox, run against both implementations of `CounterChainRepository`.
 *
 * The property that matters most here is not any single method: it is that
 * **the outbox is a query, not a second store.** There is one table, the flag
 * lives on the event row, and "what is unsynced" is `sync === 'pendiente'` — so
 * there is no state in which a queue holds an event the log does not have, or a
 * log holds an event the queue forgot. That is asserted by the Dexie side
 * surviving a close and reopen, which is the whole of "survives app restart,
 * tab close and tablet reboot".
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryChain,
  chainEvents,
  genesisHash,
  type ChainedEvent,
  type CounterChainRepository,
} from '../../src/domain';
import { ConteoDb, DexieCounterChain } from '../../src/store';
import { addCount, resetFactory } from '../domain/factory';

const SESSION = 'session-1';
const COUNTER = 'counter-ana';

/** `n` chained events, `seq` from 1, hashed by the module the server re-runs. */
function chain(n: number, from = 1, head = genesisHash(SESSION, COUNTER)): ChainedEvent[] {
  resetFactory();
  const events = Array.from({ length: n }, (_, i) =>
    addCount(1181, i + 1, {
      id: `e${from + i}`,
      sessionId: SESSION,
      counterId: COUNTER,
      seq: from + i,
    }),
  );
  return chainEvents(head, events);
}

function contract(name: string, open: () => Promise<CounterChainRepository>) {
  describe(name, () => {
    let chainRepo: CounterChainRepository;
    beforeEach(async () => {
      chainRepo = await open();
    });

    it('an appended event is in the outbox, and its chain came with it', async () => {
      const [link] = chain(1);
      await chainRepo.appendChained(link);
      const pending = await chainRepo.unsynced(SESSION, COUNTER, 10);
      expect(pending).toEqual([link]);
    });

    it('reports where the chain stands locally', async () => {
      const links = chain(3);
      for (const link of links) await chainRepo.appendChained(link);
      expect(await chainRepo.localChain(SESSION, COUNTER)).toEqual({
        maxSeq: 3,
        head: links[2].hash,
      });
    });

    it('answers null for a counter this device holds nothing of', async () => {
      // Not "the counter has nothing" — a replacement tablet looks like this,
      // and it has to ask the server rather than start over at seq 1.
      expect(await chainRepo.localChain(SESSION, 'counter-luis')).toBeNull();
    });

    it('drains in batches, ascending and contiguous', async () => {
      for (const link of chain(500)) await chainRepo.appendChained(link);
      const first = await chainRepo.unsynced(SESSION, COUNTER, 200);
      expect(first.map((l) => l.event.seq)).toEqual(
        Array.from({ length: 200 }, (_, i) => i + 1),
      );
      await chainRepo.markSynced(SESSION, COUNTER, 200);
      const second = await chainRepo.unsynced(SESSION, COUNTER, 200);
      expect(second[0].event.seq).toBe(201);
      await chainRepo.markSynced(SESSION, COUNTER, 400);
      const third = await chainRepo.unsynced(SESSION, COUNTER, 200);
      expect(third).toHaveLength(100);
      await chainRepo.markSynced(SESSION, COUNTER, 500);
      expect(await chainRepo.unsynced(SESSION, COUNTER, 200)).toEqual([]);
    });

    it('leaves everything above the ack in the outbox', async () => {
      for (const link of chain(5)) await chainRepo.appendChained(link);
      await chainRepo.markSynced(SESSION, COUNTER, 3);
      const rest = await chainRepo.unsynced(SESSION, COUNTER, 10);
      expect(rest.map((l) => l.event.seq)).toEqual([4, 5]);
    });

    it('puts everything back when the server says it is behind', async () => {
      // The answer to `SEQUENCE_GAP`. The server is the record; this device
      // resends. Over-delivery is a no-op, and the alternative is a hole nobody
      // fills.
      for (const link of chain(5)) await chainRepo.appendChained(link);
      await chainRepo.markSynced(SESSION, COUNTER, 5);
      expect(await chainRepo.unsynced(SESSION, COUNTER, 10)).toEqual([]);
      await chainRepo.resetFrom(SESSION, COUNTER, 3);
      expect((await chainRepo.unsynced(SESSION, COUNTER, 10)).map((l) => l.event.seq)).toEqual([3, 4, 5]);
    });

    it('is idempotent by id, so a retried write is not a conflict', async () => {
      const [link] = chain(1);
      await chainRepo.appendChained(link);
      await chainRepo.appendChained(link);
      expect(await chainRepo.unsynced(SESSION, COUNTER, 10)).toHaveLength(1);
    });

    it('refuses a second event at one sequence number', async () => {
      const [link] = chain(1);
      await chainRepo.appendChained(link);
      const twin = { ...link, event: { ...link.event, id: 'twin' } };
      await expect(chainRepo.appendChained(twin)).rejects.toThrow();
    });

    it('refuses an event with no counterId: a P1 event has no chain', async () => {
      const [link] = chain(1);
      const legacy = { ...link, event: { ...link.event } };
      delete (legacy.event as { counterId?: string }).counterId;
      await expect(chainRepo.appendChained(legacy)).rejects.toThrow();
    });

    it('keeps what a sealed session refused, and keeps it out of the outbox', async () => {
      for (const link of chain(3)) await chainRepo.appendChained(link);
      await chainRepo.markRejected(SESSION, COUNTER);
      expect(await chainRepo.unsynced(SESSION, COUNTER, 10)).toEqual([]);
      const kept = await chainRepo.rejected(SESSION, COUNTER);
      expect(kept.map((l) => l.event.seq)).toEqual([1, 2, 3]);
    });
  });
}

contract('MemoryChain', async () => new MemoryChain());

let db: ConteoDb;
contract('DexieCounterChain', async () => {
  db = new ConteoDb(`chain-${Math.random().toString(36).slice(2)}`);
  return new DexieCounterChain(db);
});
afterEach(async () => {
  await db?.delete();
});

describe('the outbox survives a restart, because it is not in memory', () => {
  it('reopens with everything still pending', async () => {
    const name = `restart-${Math.random().toString(36).slice(2)}`;
    const first = new ConteoDb(name);
    const links = chain(7);
    for (const link of links) await new DexieCounterChain(first).appendChained(link);
    await new DexieCounterChain(first).markSynced(SESSION, COUNTER, 4);
    first.close();

    // A tablet reboot: a new connection to the same database, nothing in memory.
    const second = new ConteoDb(name);
    const chainRepo = new DexieCounterChain(second);
    expect((await chainRepo.unsynced(SESSION, COUNTER, 200)).map((l) => l.event.seq)).toEqual([5, 6, 7]);
    expect(await chainRepo.localChain(SESSION, COUNTER)).toEqual({ maxSeq: 7, head: links[6].hash });
    await second.delete();
  });

  it('shares one table with the log, so the two cannot disagree', async () => {
    const name = `shared-${Math.random().toString(36).slice(2)}`;
    const conteo = new ConteoDb(name);
    for (const link of chain(3)) await new DexieCounterChain(conteo).appendChained(link);
    const rows = await conteo.countEvents.toArray();
    expect(rows).toHaveLength(3);
    // The flag is on the event. There is no second store to fall out of step.
    expect(rows.every((row) => row.sync === 'pendiente')).toBe(true);
    expect(rows.every((row) => typeof row.hash === 'string')).toBe(true);
    await conteo.delete();
  });
});
