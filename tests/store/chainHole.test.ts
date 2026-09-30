/**
 * A counter's chain on the device can never have a hole in it.
 *
 * Every event is chained onto the one before, so the order of `seq` on disk is
 * the order the server will accept and nothing else. Two ways used to break
 * that, both found in the pre-pilot failure-mode pass:
 *
 *   - **A write that failed once.** In P2 mode the store kept accepting taps
 *     after one failed IndexedDB write, chaining them onto the event that never
 *     landed. Disk held `seq` 1, 3, 4…, the server refused everything from 2 on
 *     with SEQUENCE_GAP, for good, and after a reload the failed event — held
 *     only in memory — was gone.
 *   - **A throw while building.** `seq` was consumed before the event was
 *     validated, so a note with a pasted tab (refused by the chain's own check)
 *     left a number nobody wrote.
 */
import { describe, expect, it } from 'vitest';

import type { ChainedEvent } from '../../src/domain';
import { COUNTER, counterStore } from '../ui/counterHarness';
import { ID, SESSION_ID } from '../ui/harness';

async function onDisk(chain: { unsynced: (s: string, c: string, n: number) => Promise<ChainedEvent[]> }) {
  return (await chain.unsynced(SESSION_ID, COUNTER, 100)).map((link) => link.event.seq);
}

describe('one failed write', () => {
  it('stops new entries at once, and the retry lands the missing one in order', async () => {
    const { store, chain } = await counterStore();
    const append = chain.appendChainedBatch.bind(chain);
    let failNext = false;
    chain.appendChainedBatch = async (links) => {
      if (failNext) {
        failNext = false;
        throw new Error('UnknownError: IndexedDB transaction aborted');
      }
      return append(links);
    };

    store.addCount(ID.panTajado, 1);
    await store.settled();
    failNext = true;
    store.addCount(ID.panTajado, 2);
    await store.settled();

    // Halted after the first failure, not the third: the next tap would build
    // on an event that is not on disk.
    expect(store.getSnapshot().halted).not.toBeNull();
    expect(() => store.addCount(ID.panTajado, 3)).toThrow(/detenido/);
    expect(await onDisk(chain)).toEqual([1]);

    store.retryFailures();
    await store.settled();
    expect(store.getSnapshot().halted).toBeNull();
    store.addCount(ID.panTajado, 3);
    await store.settled();

    // Contiguous, and in the order the taps happened.
    expect(await onDisk(chain)).toEqual([1, 2, 3]);
    const links = await chain.unsynced(SESSION_ID, COUNTER, 100);
    for (let i = 1; i < links.length; i++) expect(links[i].prevHash).toBe(links[i - 1].hash);
  });
});

describe('a refused event', () => {
  it('costs no sequence number and leaves the chain where it was', async () => {
    const { store, chain } = await counterStore();
    store.addCount(ID.panTajado, 1);
    await store.settled();

    // Pasted from another app. The chain's own rule refuses it — now
    // synchronously, where the Notas screen can show it.
    expect(() => store.note('3 cajas\tsin código')).toThrow(/control character/);

    store.addCount(ID.panTajado, 2);
    await store.settled();
    expect(await onDisk(chain)).toEqual([1, 2]);
    expect(store.getSnapshot().halted).toBeNull();
  });
});
