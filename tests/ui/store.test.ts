/**
 * The counting store.
 *
 * Everything the screen does to the log goes through here, so this is where
 * the count / waiver distinction, the tally, and the shape of an undo are
 * pinned — the components on top only decide where the buttons sit.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryRepository,
  itemVariance,
  type CountEvent,
  type CountRepository,
} from '../../src/domain';
import { CountStore } from '../../src/ui/store';
import { ID, SESSION_ID, fakeIdentity, sampleSession, seededRepository } from './harness';

async function open(repo?: CountRepository): Promise<CountStore> {
  const backing = repo ?? (await seededRepository());
  return CountStore.open(backing, SESSION_ID, fakeIdentity());
}

const kinds = (events: readonly CountEvent[], idarticulo: number) =>
  events.filter((event) => event.idarticulo === idarticulo).map((event) => event.kind);

describe('the three actions', () => {
  it('a count that matches is counted, not "unchanged"', async () => {
    const store = await open();
    const item = sampleSession().items.find((row) => row.idarticulo === ID.pancetaKilo)!;

    store.setCount(item.idarticulo, item.existencia);

    const resolution = store.resolutionFor(item.idarticulo);
    expect(resolution.state).toBe('counted');
    expect(resolution.qty).toBe(item.existencia);
    expect(itemVariance(item, resolution)?.varianceClass).toBe('none');
  });

  it('a waiver is unchanged, and has no variance at all', async () => {
    const store = await open();
    const item = sampleSession().items.find((row) => row.idarticulo === ID.pancetaKilo)!;

    store.markUnchanged(item.idarticulo);

    const resolution = store.resolutionFor(item.idarticulo);
    expect(resolution.state).toBe('unchanged');
    expect(resolution.qty).toBeUndefined();
    // Not a zero variance — DOMAIN.md §2. The two are the same bytes on export
    // and completely different facts here.
    expect(itemVariance(item, resolution)).toBeNull();
  });

  it('stamps every event with who, where and when', async () => {
    const store = await open();
    store.setUsuario('beto');
    const event = store.setCount(ID.melon, 12);

    expect(event.usuario).toBe('beto');
    // `zona` is whatever the store was opened with and nothing a screen can
    // set: the `ZONAS` picker is gone (P2.3 G2), because a zone somebody picks
    // off a list is a claim and the only zone this app recognises now is the
    // section the admin assigned. A P1 session has no partition, so `''`.
    expect(event.zona).toBe('ALMACEN');
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('tally mode', () => {
  it('ten taps are ten add events and a resolution of 10', async () => {
    const store = await open();
    for (let tap = 0; tap < 10; tap++) store.addCount(ID.melon, 1);

    expect(kinds(store.getSnapshot().events, ID.melon)).toEqual(Array(10).fill('add'));
    expect(store.resolutionFor(ID.melon).qty).toBe(10);
  });

  it('a negative add walks a mis-tap back without deleting it', async () => {
    const store = await open();
    store.addCount(ID.melon, 1);
    store.addCount(ID.melon, 1);
    store.addCount(ID.melon, -1);

    expect(store.getSnapshot().events).toHaveLength(3);
    expect(store.resolutionFor(ID.melon).qty).toBe(1);
  });

  it('accumulates decimals without drifting into the ERP', async () => {
    const store = await open();
    store.addCount(ID.melon, 0.1);
    store.addCount(ID.melon, 0.2);
    expect(store.resolutionFor(ID.melon).qty).toBe(0.3);
  });

  it('resumes from zero after a waiver, not from the withdrawn total', async () => {
    const store = await open();
    store.setCount(ID.melon, 40);
    store.markUnchanged(ID.melon);
    store.addCount(ID.melon, 1);
    expect(store.resolutionFor(ID.melon).qty).toBe(1);
  });
});

describe('undo appends', () => {
  it('grows the log rather than shrinking it', async () => {
    const store = await open();
    store.setCount(ID.melon, 5);
    store.setCount(ID.melon, 50);
    const before = store.getSnapshot().events.length;

    store.undo(ID.melon);

    expect(store.getSnapshot().events.length).toBe(before + 1);
    expect(store.resolutionFor(ID.melon).qty).toBe(5);
  });

  it('walks a tally back one tap at a time, as a targeted withdrawal', async () => {
    // Was `['add', 'add', 'add']`: undo used to append `add(-q)`. That restored
    // the prior *value* and not the prior *state*, so undoing a first tap
    // landed on `counted 0` — a write-off of the whole book figure. Now that a
    // withdrawal can name its target it is strictly better, and the running
    // value comes out the same (DOMAIN.md §3).
    const store = await open();
    store.addCount(ID.melon, 1);
    const second = store.addCount(ID.melon, 1);
    store.undo(ID.melon);

    const events = store.getSnapshot().events.filter((e) => e.idarticulo === ID.melon);
    expect(kinds(events, ID.melon)).toEqual(['add', 'add', 'retract']);
    expect(events[2]).toMatchObject({ kind: 'retract', retractsEventId: second.id });
    expect(store.resolutionFor(ID.melon).qty).toBe(1);
  });

  it('undoes the first tap of a tally to untouched, not to a count of zero', () => {
    // The reason `add(-q)` is gone, stated as its own case.
    return open().then((store) => {
      store.addCount(ID.melon, 1);
      store.undo(ID.melon);
      expect(store.resolutionFor(ID.melon)).toEqual({ state: 'untouched' });
    });
  });

  it('restores a waiver that a later count replaced', async () => {
    const store = await open();
    store.markUnchanged(ID.melon);
    store.setCount(ID.melon, 3);
    store.undo(ID.melon);
    expect(store.resolutionFor(ID.melon).state).toBe('unchanged');
  });

  it('withdraws a first entry instead of leaving a write-off behind', async () => {
    // Before `retract` existed this was the one case undo could not serve: the
    // three original kinds all move an item into a state that posts, so a
    // mis-tap on the wrong row could only be *overwritten* with a number
    // nobody counted. Undo is now total (DOMAIN.md §3).
    const store = await open();
    expect(store.canUndo(ID.melon)).toBe(false);

    store.setCount(ID.melon, 5);
    expect(store.canUndo(ID.melon)).toBe(true);

    store.undo(ID.melon);
    expect(store.resolutionFor(ID.melon)).toEqual({ state: 'untouched' });
    expect(store.getSnapshot().events).toHaveLength(2);
    expect(store.getSnapshot().events[1].kind).toBe('retract');
  });

  it('walks a single tally tap back to untouched, not to zero', async () => {
    // The one place DOMAIN.md §3's table is wrong: `add(-q)` restores the prior
    // *value*, and the prior value of a first tap is nothing at all. Undoing to
    // `counted 0` would post a full write-off of the book figure.
    const store = await open();
    store.addCount(ID.panTajado, 1);
    store.undo(ID.panTajado);

    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'untouched' });
  });

  it('discards everything recorded and blocks the post again', async () => {
    const store = await open();
    store.addCount(ID.melon, 3);
    store.addCount(ID.melon, 4);
    store.retract(ID.melon);

    expect(store.resolutionFor(ID.melon)).toEqual({ state: 'untouched' });
    expect(store.getSnapshot().counts.untouched).toBe(298);
    // Nothing was deleted: the withdrawal is itself an attributable event.
    expect(store.getSnapshot().events).toHaveLength(3);
    expect(store.getSnapshot().events[2]).toMatchObject({
      kind: 'retract',
      usuario: 'ana',
      zona: 'ALMACEN',
    });
  });
});

describe('optimistic writes', () => {
  it('shows the count before the repository has taken it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backing = new MemoryRepository();
    await backing.createSession(sampleSession());
    const slow: CountRepository = {
      ...backing,
      createSession: (session) => backing.createSession(session),
      getSession: (id) => backing.getSession(id),
      listSessions: () => backing.listSessions(),
      itemsForSession: (id) => backing.itemsForSession(id),
      eventsForItem: (id, art) => backing.eventsForItem(id, art),
      eventsForSession: (id) => backing.eventsForSession(id),
      appendEvent: async (event) => {
        await gate;
        await backing.appendEvent(event);
      },
    };

    const store = await CountStore.open(slow, SESSION_ID, fakeIdentity());
    store.setCount(ID.melon, 7);

    // On screen immediately; still nowhere near the database.
    expect(store.resolutionFor(ID.melon).qty).toBe(7);
    expect(store.getSnapshot().pending).toBe(1);
    expect(await backing.eventsForSession(SESSION_ID)).toHaveLength(0);

    release();
    await store.settled();
    expect(await backing.eventsForSession(SESSION_ID)).toHaveLength(1);
  });

  it('surfaces a write that failed, and can retry it', async () => {
    const backing = new MemoryRepository();
    await backing.createSession(sampleSession());
    let fail = true;
    const flaky: CountRepository = {
      ...backing,
      createSession: (session) => backing.createSession(session),
      getSession: (id) => backing.getSession(id),
      listSessions: () => backing.listSessions(),
      itemsForSession: (id) => backing.itemsForSession(id),
      eventsForItem: (id, art) => backing.eventsForItem(id, art),
      eventsForSession: (id) => backing.eventsForSession(id),
      appendEvent: async (event) => {
        if (fail) throw new Error('QuotaExceededError');
        await backing.appendEvent(event);
      },
    };

    const store = await CountStore.open(flaky, SESSION_ID, fakeIdentity());
    store.setCount(ID.melon, 7);
    await store.settled();

    expect(store.getSnapshot().failures).toHaveLength(1);
    // The count is still on screen and still correct: the log is in memory.
    expect(store.resolutionFor(ID.melon).qty).toBe(7);

    fail = false;
    store.retryFailures();
    await store.settled();
    expect(store.getSnapshot().failures).toHaveLength(0);
    expect(await backing.eventsForSession(SESSION_ID)).toHaveLength(1);
  });
});

describe('reopening', () => {
  it('resumes seq from the store, not from the log', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(sampleSession());
    const device = await repo.identify();

    const first = await CountStore.open(repo, SESSION_ID, {
      ...fakeIdentity(),
      deviceId: device.deviceId,
      nextSeq: device.nextSeq,
    });
    first.setCount(ID.melon, 1);
    first.setCount(ID.melon, 2);
    await first.settled();

    // A reload asks the store who it is and where it got to. Note the second
    // store is handed **no events at all** — the watermark is what makes that
    // safe (DOMAIN.md §6).
    const resumed = await repo.identify();
    const second = new CountStore(repo, sampleSession(), [], {
      ...fakeIdentity(),
      deviceId: resumed.deviceId,
      nextSeq: resumed.nextSeq,
      newId: () => 'ev-later',
      clock: () => '2026-08-25T11:00:00.000Z',
    });

    expect(resumed.deviceId).toBe(device.deviceId);
    // Not 0: reusing a sequence number this device has already spent would
    // stop `(at, deviceId, seq)` being an order (DOMAIN.md §3).
    expect(second.setCount(ID.melon, 3).seq).toBe(2);
  });

  it('re-derives every state from the log, not from anything stored', async () => {
    const repo = await seededRepository();
    const first = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    first.setCount(ID.pancetaKilo, 90);
    first.markUnchanged(ID.melon);
    await first.settled();

    const second = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    expect(second.resolutionFor(ID.pancetaKilo)).toEqual({ state: 'counted', qty: 90 });
    expect(second.resolutionFor(ID.melon)).toEqual({ state: 'unchanged' });
    expect(second.getSnapshot().counts).toEqual({ counted: 1, unchanged: 1, untouched: 296 });
  });
});

describe('the clock only ever moves forward (§2)', () => {
  /** A clock that returns each of these in turn, then repeats the last. */
  function scriptedClock(stamps: readonly string[]): () => string {
    let index = 0;
    return () => stamps[Math.min(index++, stamps.length - 1)];
  }

  const AT = {
    drifted: '2026-08-25T14:05:00.000Z',
    corrected: '2026-08-25T14:00:00.000Z',
    later: '2026-08-25T14:10:00.000Z',
  };

  it('never stamps an event earlier than one it has already stamped', async () => {
    const store = await CountStore.open(await seededRepository(), SESSION_ID, {
      ...fakeIdentity(),
      clock: scriptedClock([AT.drifted, AT.corrected]),
    });

    const first = store.setCount(ID.melon, 10);
    const second = store.setCount(ID.melon, 20);

    expect(first.at).toBe(AT.drifted);
    // NTP pulled the tablet back five minutes between the two taps. The second
    // event is not stamped in the past.
    expect(second.at).toBe(AT.drifted);
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  /**
   * The failure this exists to stop, stated as the thing a person would
   * notice: somebody types 10, sees it is wrong, types 20, and the file
   * carries 10.
   */
  it('keeps a correction winning over the value it corrected', async () => {
    const store = await CountStore.open(await seededRepository(), SESSION_ID, {
      ...fakeIdentity(),
      clock: scriptedClock([AT.drifted, AT.corrected]),
    });

    store.setCount(ID.melon, 10);
    store.setCount(ID.melon, 20);

    // Asked of the fold, not of the array: `resolve` sorts by
    // (at, deviceId, seq) and array order means nothing to it.
    expect(store.resolutionFor(ID.melon)).toEqual({ state: 'counted', qty: 20 });
  });

  it('survives a reload, which is where a fresh store would forget', async () => {
    const repo = await seededRepository();
    const identity = fakeIdentity();
    const first = await CountStore.open(repo, SESSION_ID, {
      ...identity,
      clock: () => AT.drifted,
    });
    first.setCount(ID.melon, 10);
    await first.settled();

    // A reload: a new store, the same device, and a clock that has since been
    // corrected backwards. The high-water mark comes from the log.
    const second = await CountStore.open(repo, SESSION_ID, {
      ...identity,
      nextSeq: 1,
      clock: () => AT.corrected,
    });
    const corrected = second.setCount(ID.melon, 20);

    expect(corrected.at).toBe(AT.drifted);
    expect(second.resolutionFor(ID.melon)).toEqual({ state: 'counted', qty: 20 });
  });

  it('seeds the mark from this device only, not from another tablet', async () => {
    const repo = await seededRepository();
    const identity = fakeIdentity();
    const peer = await CountStore.open(repo, SESSION_ID, {
      ...identity,
      deviceId: 'tablet-2',
      clock: () => AT.later,
    });
    peer.setCount(ID.panTajado, 4);
    await peer.settled();

    // `tablet-1` opens the same session. Its own clock reads earlier than the
    // stamp `tablet-2` left, and it is not this store's job to be bound by it:
    // cross-device ordering stays wall-clock (DOMAIN.md §3).
    const mine = await CountStore.open(repo, SESSION_ID, {
      ...identity,
      clock: () => AT.corrected,
    });
    expect(mine.setCount(ID.melon, 1).at).toBe(AT.corrected);
  });

  it('gives a pinned clock the pinned value, repeatedly', async () => {
    const store = await CountStore.open(await seededRepository(), SESSION_ID, {
      ...fakeIdentity(),
      clock: () => AT.corrected,
    });

    const events = [store.setCount(ID.melon, 1), store.setCount(ID.melon, 2)];

    expect(events.map((event) => event.at)).toEqual([AT.corrected, AT.corrected]);
    // Same instant, same device — so `seq` is what orders them, which is the
    // tie-break's whole job (DOMAIN.md §3).
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
    expect(store.resolutionFor(ID.melon)).toEqual({ state: 'counted', qty: 2 });
  });

  it('refuses a clock that does not return a normalised instant', async () => {
    const store = await CountStore.open(await seededRepository(), SESSION_ID, {
      ...fakeIdentity(),
      // Local time with an offset. It is the same instant as 15:00Z and sorts
      // after it, which is precisely the silent failure DOMAIN.md §3 names —
      // and the comparison the clamp makes would be meaningless on it.
      clock: () => '2026-08-25T10:00:00.000-05:00',
    });

    expect(() => store.setCount(ID.melon, 1)).toThrowError(/normalised UTC instant/);
  });
});

describe('the supervisor bulk waiver (§3, §4)', () => {
  it('appends one unchanged event per item, each carrying the motivo', async () => {
    const store = await open();
    const ids = [ID.melon, ID.panTajado, ID.name];

    const written = store.waiveMany(ids, { motivo: 'cava cerrada por mantenimiento', usuario: 'marta' });

    expect(written).toHaveLength(3);
    for (const id of ids) {
      const events = store.eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('unchanged');
      expect((events[0] as { motivo?: string }).motivo).toBe('cava cerrada por mantenimiento');
      expect(store.resolutionFor(id).state).toBe('unchanged');
    }
  });

  it('stamps the supervisor, not the counter the store was opened as', async () => {
    // The whole value of these events is whose signature they carry (§4). A
    // bulk waiver signed by whoever last held the tablet is not a waiver.
    const store = await open();
    expect(store.getSnapshot().usuario).toBe('ana');

    store.waiveMany([ID.melon], { motivo: 'no se alcanzó', usuario: 'marta' });

    expect(store.eventsFor(ID.melon)[0].usuario).toBe('marta');
    // And it does not become the store's user: the next count is still ana's.
    store.setCount(ID.panTajado, 4);
    expect(store.eventsFor(ID.panTajado)[0].usuario).toBe('ana');
  });

  it('leaves the zone empty, because nobody stood anywhere', async () => {
    const store = await open();
    store.waiveMany([ID.melon], { motivo: 'no se alcanzó', usuario: 'marta' });
    expect(store.eventsFor(ID.melon)[0].zona).toBe('');
  });

  it('refuses a waiver with no motivo, and writes nothing', async () => {
    const store = await open();
    expect(() => store.waiveMany([ID.melon], { motivo: '   ', usuario: 'marta' })).toThrow(
      /motivo/,
    );
    expect(store.eventsFor(ID.melon)).toEqual([]);
    expect(store.resolutionFor(ID.melon).state).toBe('untouched');
  });

  it('refuses a waiver nobody signed', async () => {
    const store = await open();
    expect(() => store.waiveMany([ID.melon], { motivo: 'no se alcanzó', usuario: '' })).toThrow(
      /quién autoriza/,
    );
    expect(store.eventsFor(ID.melon)).toEqual([]);
  });

  it('persists every waived row independently', async () => {
    const repo = await seededRepository();
    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    const ids = [ID.melon, ID.panTajado, ID.name, ID.ajiChipotle];

    store.waiveMany(ids, { motivo: 'cierre de mes', usuario: 'marta' });
    await store.settled();

    const stored = await repo.eventsForSession(SESSION_ID);
    expect(stored).toHaveLength(ids.length);
    expect(new Set(stored.map((event) => event.seq)).size).toBe(ids.length);
  });
});
