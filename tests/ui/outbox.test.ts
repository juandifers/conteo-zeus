/**
 * The outbox — the lifeboat under an optimistic write.
 *
 * What is being tested is the window between "the counter sees it" and "the
 * database has it". Everything here is about what survives a tab closed inside
 * that window.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryRepository,
  type CountEvent,
  type CountRepository,
  type Session,
} from '../../src/domain';
import { localOutbox, replayOutbox } from '../../src/ui/outbox';
import { CountStore } from '../../src/ui/store';
import {
  ID,
  SESSION_ID,
  deadStorage,
  fakeIdentity,
  memoryStorage,
  sampleSession,
} from './harness';

/**
 * A repository whose writes can be switched off.
 *
 * `MemoryRepository` is the backing store, so a rejected write really does
 * leave nothing behind — which is the only way to test that the outbox is what
 * brings it back.
 */
function flaky(session: Session) {
  const backing = new MemoryRepository();
  const state = { rejecting: false, attempts: 0 };
  const repo: CountRepository = {
    createSession: (s) => backing.createSession(s),
    getSession: (id) => backing.getSession(id),
    listSessions: () => backing.listSessions(),
    itemsForSession: (id) => backing.itemsForSession(id),
    eventsForItem: (id, art) => backing.eventsForItem(id, art),
    eventsForSession: (id) => backing.eventsForSession(id),
    appendEvent: async (event: CountEvent) => {
      state.attempts++;
      if (state.rejecting) throw new Error('UnknownError: database is closed');
      await backing.appendEvent(event);
    },
  };
  return { repo, backing, state, ready: backing.createSession(session) };
}

describe('holding and releasing', () => {
  it('is empty once a write lands', async () => {
    const storage = memoryStorage();
    const repo = new MemoryRepository();
    await repo.createSession(sampleSession());

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    store.setCount(ID.melon, 12);
    // Held before the flush, which is the whole point of the ordering.
    expect(localOutbox(storage).pending()).toHaveLength(1);

    await store.settled();
    expect(localOutbox(storage).pending()).toHaveLength(0);
    expect(storage.length).toBe(0);
  });

  it('keys each event separately', async () => {
    // One growing array re-serialised per tap turns forty taps into quadratic
    // synchronous work, on the tap.
    const storage = memoryStorage();
    const { repo, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    store.addCount(ID.melon, 1);
    store.addCount(ID.melon, 1);
    store.addCount(ID.melon, 1);
    await store.settled();

    expect(storage.length).toBe(3);
    expect(localOutbox(storage).pending()).toHaveLength(3);
  });
});

describe('replay at boot', () => {
  it('brings back an event the database refused', async () => {
    const storage = memoryStorage();
    const { repo, backing, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    store.setCount(ID.melon, 12);
    await store.settled();

    // On screen, in the outbox, and nowhere else.
    expect(store.resolutionFor(ID.melon).qty).toBe(12);
    expect(await backing.eventsForSession(SESSION_ID)).toHaveLength(0);

    // The tab closes here. Next boot:
    state.rejecting = false;
    const outbox = localOutbox(storage);
    expect(await replayOutbox(outbox, repo)).toEqual({ replayed: 1, failed: 0 });

    const reopened = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    expect(reopened.resolutionFor(ID.melon).qty).toBe(12);
    expect(outbox.pending()).toHaveLength(0);
  });

  it('is idempotent when the same event reaches the database twice', async () => {
    const storage = memoryStorage();
    const repo = new MemoryRepository();
    await repo.createSession(sampleSession());

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    const event = store.setCount(ID.melon, 12);
    await store.settled();

    // Simulate a write that landed but whose release did not — the classic
    // way an outbox entry outlives its event.
    const outbox = localOutbox(storage);
    outbox.hold(event);
    expect(outbox.pending()).toHaveLength(1);

    expect(await replayOutbox(outbox, repo)).toEqual({ replayed: 1, failed: 0 });
    // One event, not two: `appendEvent` is idempotent by id.
    expect(await repo.eventsForSession(SESSION_ID)).toHaveLength(1);
    expect(outbox.pending()).toHaveLength(0);
  });

  it('leaves what it still cannot flush, and says how much', async () => {
    const storage = memoryStorage();
    const { repo, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    store.setCount(ID.melon, 12);
    await store.settled();

    const outbox = localOutbox(storage);
    expect(await replayOutbox(outbox, repo)).toEqual({ replayed: 0, failed: 1 });
    expect(outbox.pending()).toHaveLength(1);
  });

  it('prunes an entry it can never parse rather than reporting it forever', () => {
    const storage = memoryStorage();
    storage.setItem('conteo.outbox.broken', '{not json');
    storage.setItem('unrelated', 'left alone');

    expect(localOutbox(storage).pending()).toEqual([]);
    expect(storage.getItem('conteo.outbox.broken')).toBeNull();
    expect(storage.getItem('unrelated')).toBe('left alone');
  });
});

describe('when localStorage is not there at all', () => {
  it('reports itself unavailable rather than pretending', () => {
    const outbox = localOutbox(deadStorage());
    expect(outbox.available).toBe(false);
    expect(outbox.hold({ id: 'x' } as unknown as CountEvent)).toBe(false);
    expect(outbox.pending()).toEqual([]);
  });

  it('tells the store, which tells the screen', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(sampleSession());
    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(deadStorage()));
    expect(store.getSnapshot().protected).toBe(false);
  });

  it('stops the count on the first failure, because there is no second chance', async () => {
    // With a lifeboat, a rejected write is worth retrying. Without one, the
    // event exists in this tab and nowhere else, and continuing means building
    // a count that a closed lid deletes.
    const { repo, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(deadStorage()));
    store.setCount(ID.melon, 12);
    await store.settled();

    const { halted } = store.getSnapshot();
    expect(halted?.title).toBe('Este conteo no se guardó en ninguna parte');
    expect(halted?.detail).toContain('database is closed');
    expect(() => store.setCount(ID.panTajado, 1)).toThrow(/detenido/);
  });
});

describe('giving up', () => {
  it('keeps going while the outbox is holding, then stops after three', async () => {
    const storage = memoryStorage();
    const { repo, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    store.setCount(ID.melon, 1);
    await store.settled();
    expect(store.getSnapshot().halted).toBeNull();

    store.setCount(ID.melon, 2);
    await store.settled();
    expect(store.getSnapshot().halted).toBeNull();

    store.setCount(ID.melon, 3);
    await store.settled();
    expect(store.getSnapshot().halted?.title).toBe('No se está guardando nada');
    expect(store.getSnapshot().halted?.detail).toContain('no sigas contando');
  });

  it('resumes when a retry works, and loses nothing', async () => {
    const storage = memoryStorage();
    const { repo, backing, state, ready } = flaky(sampleSession());
    await ready;
    state.rejecting = true;

    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity(storage));
    for (const qty of [1, 2, 3]) store.setCount(ID.melon, qty);
    await store.settled();
    expect(store.getSnapshot().halted).not.toBeNull();

    state.rejecting = false;
    store.retryFailures();
    await store.settled();

    expect(store.getSnapshot().halted).toBeNull();
    expect(await backing.eventsForSession(SESSION_ID)).toHaveLength(3);
    expect(localOutbox(storage).pending()).toHaveLength(0);
    expect(() => store.setCount(ID.melon, 4)).not.toThrow();
  });
});
