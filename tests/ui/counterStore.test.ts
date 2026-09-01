/**
 * The counting store in **P2 mode** — one counter's device.
 *
 * What changes when a `counterId` is present: every event carries it, every
 * event is chained, the durable write goes through the outbox, undo is scoped
 * to this counter, the whole-item discard does not exist, and `finish` /
 * `reopen` / `note` become writable.
 *
 * The property worth stating once: **the device and the server build the same
 * chain.** Both import `src/domain/chain.ts` and there is no second
 * implementation, so the assertion below — chain the store's events
 * independently and compare heads — is what would catch the day somebody adds
 * one.
 */
import { describe, expect, it } from 'vitest';

import {
  MemoryChain,
  chainEvents,
  genesisHash,
  verifyChain,
  type CountEvent,
} from '../../src/domain';
import { CountStore } from '../../src/ui/store';
import { fakeIdentity, sampleSession, seededRepository, SESSION_ID } from './harness';

const COUNTER = 'counter-ana';

async function open(options: { head?: string; nextSeq?: number; highWater?: string } = {}) {
  const repo = await seededRepository();
  const chain = new MemoryChain();
  const session = sampleSession();
  const store = new CountStore(repo, session, [], {
    ...fakeIdentity(),
    nextSeq: options.nextSeq ?? 1,
    counterId: COUNTER,
    head: options.head ?? genesisHash(SESSION_ID, COUNTER),
    chain,
    ...(options.highWater === undefined ? {} : { highWater: options.highWater }),
  });
  return { store, chain };
}

describe('what a P2 store stamps', () => {
  it('puts the counter on every event, and numbers from 1', async () => {
    const { store } = await open();
    const first = store.setCount(1181, 5);
    const second = store.addCount(1181, 2);
    expect(first).toMatchObject({ counterId: COUNTER, seq: 1 });
    expect(second).toMatchObject({ counterId: COUNTER, seq: 2 });
  });

  it('refuses to open without a chain to append to', async () => {
    const repo = await seededRepository();
    expect(
      () =>
        new CountStore(repo, sampleSession(), [], {
          ...fakeIdentity(),
          counterId: COUNTER,
        }),
    ).toThrow(/bandeja de salida/);
  });

  it('writes each event into the outbox with its chain, in one act', async () => {
    const { store, chain } = await open();
    store.setCount(1181, 5);
    store.addCount(1181, 2.5);
    await store.settled();

    const pending = await chain.unsynced(SESSION_ID, COUNTER, 10);
    expect(pending.map((l) => l.event.seq)).toEqual([1, 2]);
    expect(pending[0].prevHash).toBe(genesisHash(SESSION_ID, COUNTER));
    expect(pending[1].prevHash).toBe(pending[0].hash);
  });

  it('builds the chain the server would build from the same events', async () => {
    const { store, chain } = await open();
    store.setCount(1181, 5);
    store.addCount(1181, 2);
    store.markUnchanged(330);
    store.note('caja abierta', 1181);
    await store.settled();

    const held = await chain.unsynced(SESSION_ID, COUNTER, 100);
    const independently = chainEvents(
      genesisHash(SESSION_ID, COUNTER),
      held.map((l) => l.event),
    );
    expect(held.map((l) => l.hash)).toEqual(independently.map((l) => l.hash));
    expect(store.chainHead()).toBe(held[held.length - 1].hash);

    // And it is a chain the server would accept: contiguous from 1, no gap.
    expect(
      verifyChain(SESSION_ID, COUNTER, held.map((l) => l.event)),
    ).toMatchObject({ ok: true, finalSeq: 4 });
  });

  it('continues from a head this device did not build, for a replacement tablet', async () => {
    // Resumed at seq 41 with the server's head. Nothing local, and no fork.
    const head = 'f'.repeat(64);
    const { store, chain } = await open({ head, nextSeq: 41 });
    store.addCount(1181, 1);
    await store.settled();
    const [link] = await chain.unsynced(SESSION_ID, COUNTER, 10);
    expect(link.event.seq).toBe(41);
    expect(link.prevHash).toBe(head);
  });

  it('never stamps earlier than the tablet it replaced', async () => {
    // The fold orders by `at` before `deviceId` and `seq`, so a spare with a
    // slow clock would stamp events that sort *before* the ones they continue.
    const later = '2099-01-01T00:00:00.000Z';
    const { store } = await open({ highWater: later });
    expect(store.addCount(1181, 1).at).toBe(later);
  });
});

describe('finish is a manifest, not a marker', () => {
  it('names the last content event and the head at it', async () => {
    const { store, chain } = await open();
    store.setCount(1181, 5);
    store.addCount(1181, 2);
    const head = store.chainHead();

    const finish = store.finish() as CountEvent & { finalSeq: number; headHash: string };
    await store.settled();

    expect(finish.kind).toBe('finish');
    expect(finish.finalSeq).toBe(2);
    expect(finish.headHash).toBe(head);
    // The rule the server checks first.
    expect(finish.seq).toBe(finish.finalSeq + 1);
    const held = await chain.unsynced(SESSION_ID, COUNTER, 10);
    expect(held[held.length - 1].prevHash).toBe(finish.headHash);
  });

  it('finishes a counter who recorded nothing, with finalSeq 0 and seq 1', async () => {
    // Assigned a section, walked over, found it already counted by receiving.
    const { store } = await open();
    const finish = store.finish() as CountEvent & { finalSeq: number; headHash: string };
    expect(finish.finalSeq).toBe(0);
    expect(finish.seq).toBe(1);
    expect(finish.headHash).toBe(genesisHash(SESSION_ID, COUNTER));
  });

  it('reopens on the same numbering, and the second manifest covers everything', async () => {
    const { store } = await open();
    store.addCount(1181, 1);
    const first = store.finish() as CountEvent & { finalSeq: number };
    store.reopen();
    store.addCount(330, 4);
    const second = store.finish() as CountEvent & { finalSeq: number };
    await store.settled();

    expect(first.seq).toBe(2);
    expect(second.seq).toBe(5);
    expect(second.finalSeq).toBe(4);
    // A new chain would defeat the manifest: the server walks one numbering
    // from 1 and a second chain starting over is exactly the hole it looks for.
    expect(store.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('appends the finish before anything is uploaded', async () => {
    // Finishing is something the counter did; whether the network cooperated is
    // a separate fact. The event is in the outbox the moment the button is
    // pressed.
    const { store, chain } = await open();
    store.finish();
    await store.settled();
    expect((await chain.unsynced(SESSION_ID, COUNTER, 10)).map((l) => l.event.kind)).toEqual([
      'finish',
    ]);
  });

  it('refuses a session-scoped event on a P1 store', async () => {
    const repo = await seededRepository();
    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    expect(() => store.finish()).toThrow(/counterId/);
  });
});

describe('a write that fails is retried as the same chained row', () => {
  it('does not degrade into an unhashed append', async () => {
    // The failure mode this guards: a retry that went through
    // `repo.appendEvent` instead would write the event with no chain metadata
    // and no flag — a row nothing can ever push.
    const repo = await seededRepository();
    const chain = new MemoryChain();
    let fail = true;
    const flaky = {
      ...chain,
      appendChained: async (link: Parameters<MemoryChain['appendChained']>[0]) => {
        if (fail) {
          fail = false;
          throw new Error('IndexedDB dijo que no');
        }
        return chain.appendChained(link);
      },
      unsynced: chain.unsynced.bind(chain),
      localChain: chain.localChain.bind(chain),
      markSynced: chain.markSynced.bind(chain),
      resetFrom: chain.resetFrom.bind(chain),
      markRejected: chain.markRejected.bind(chain),
      rejected: chain.rejected.bind(chain),
    };
    const store = new CountStore(repo, sampleSession(), [], {
      ...fakeIdentity(),
      nextSeq: 1,
      counterId: COUNTER,
      head: genesisHash(SESSION_ID, COUNTER),
      chain: flaky,
    });

    store.addCount(1181, 3);
    await store.settled();
    expect(store.getSnapshot().failures).toHaveLength(1);
    expect(store.getSnapshot().failures[0].link).not.toBeNull();

    store.retryFailures();
    await store.settled();
    const held = await chain.unsynced(SESSION_ID, COUNTER, 10);
    expect(held).toHaveLength(1);
    expect(held[0].hash).toBeTruthy();
    expect(held[0].prevHash).toBe(genesisHash(SESSION_ID, COUNTER));
  });
});
