/**
 * The drain — `src/ui/counter/sync.ts`.
 *
 * One rule runs through every test here: **nothing leaves the outbox on an
 * ambiguous outcome.** A timeout, a 5xx, a request that was cut off — all of it
 * stays, and the next attempt sends it again. Events are immutable and keyed by
 * a device-generated uuid, so over-delivery is a no-op on both sides; under-
 * delivery is a lost morning of counting.
 */
import { describe, expect, it } from 'vitest';

import {
  MemoryChain,
  chainEvents,
  genesisHash,
  type ChainedEvent,
} from '../../src/domain';
import { ApiError, type Api } from '../../src/ui/api';
import { CounterSync } from '../../src/ui/counter/sync';
import { addCount, resetFactory } from '../domain/factory';

const SESSION = 'session-1';
const COUNTER = 'counter-ana';
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa';

function chain(n: number): ChainedEvent[] {
  resetFactory();
  return chainEvents(
    genesisHash(SESSION, COUNTER),
    Array.from({ length: n }, (_, i) =>
      addCount(1181, i + 1, { id: `e${i + 1}`, sessionId: SESSION, counterId: COUNTER, seq: i + 1 }),
    ),
  );
}

/** Every batch the drain sent, and whatever the script says to answer with. */
function scriptedApi(reply: (batch: ChainedEvent[], call: number) => unknown) {
  const sent: ChainedEvent[][] = [];
  const api: Api = {
    get: async () => {
      throw new Error('the drain never GETs');
    },
    patch: async () => {
      throw new Error('the drain never PATCHes');
    },
    post: async (_path: string, body?: unknown) => {
      const batch = (body as { events: ChainedEvent[] }).events;
      sent.push(batch);
      const answer = reply(batch, sent.length);
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
  };
  return { api, sent };
}

/** An ack for whatever arrived. */
const ackFor = (batch: ChainedEvent[], estado = 'contando') => ({
  acceptedThrough: batch[batch.length - 1].event.seq,
  headHash: batch[batch.length - 1].hash,
  counterEstado: estado,
  serverAt: '2026-08-31T14:00:00.000Z',
});

/** Timers that fire when a test says so, so nothing waits in real time. */
function fakeTimers() {
  const queued: { fn: () => void; handle: number; ms: number }[] = [];
  let next = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      const handle = next++;
      queued.push({ fn, handle, ms });
      return handle;
    },
    cancel: (handle: unknown) => {
      const at = queued.findIndex((entry) => entry.handle === handle);
      if (at >= 0) queued.splice(at, 1);
    },
    /** Fire everything queued, once. */
    async run(): Promise<void> {
      const due = queued.splice(0, queued.length);
      for (const entry of due) entry.fn();
      await Promise.resolve();
    },
    get pending() {
      return queued.length;
    },
    get delays() {
      return queued.map((entry) => entry.ms);
    },
  };
}

async function seeded(n: number): Promise<MemoryChain> {
  const store = new MemoryChain();
  for (const link of chain(n)) await store.appendChained(link);
  return store;
}

function open(api: Api, store: MemoryChain, timers = fakeTimers()) {
  return new CounterSync(api, store, {
    sessionId: SESSION,
    counterId: COUNTER,
    token: TOKEN,
    schedule: timers.schedule,
    cancel: timers.cancel,
    random: () => 0.5,
    clock: () => '2026-08-31T14:00:00.000Z',
  });
}

describe('draining', () => {
  it('empties a 500-event outbox in three batches of at most 200', async () => {
    const store = await seeded(500);
    const { api, sent } = scriptedApi((batch) => ackFor(batch));
    const sync = open(api, store);

    await sync.drain();

    expect(sent.map((batch) => batch.length)).toEqual([200, 200, 100]);
    expect(sent[0][0].event.seq).toBe(1);
    expect(sent[2][99].event.seq).toBe(500);
    expect(sync.getSnapshot().pendientes).toBe(0);
  });

  it('sends contiguous, ascending seq — what the server will accept', async () => {
    const store = await seeded(5);
    const { api, sent } = scriptedApi((batch) => ackFor(batch));
    await open(api, store).drain();
    expect(sent[0].map((l) => l.event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does nothing when there is nothing to send', async () => {
    const { api, sent } = scriptedApi(() => ({}));
    await open(api, new MemoryChain()).drain();
    expect(sent).toEqual([]);
  });

  it('only ever runs one drain at a time', async () => {
    const store = await seeded(10);
    const { api, sent } = scriptedApi((batch) => ackFor(batch));
    const sync = open(api, store);
    await Promise.all([sync.drain(), sync.drain(), sync.drain()]);
    expect(sent).toHaveLength(1);
  });
});

describe('nothing is dropped on an ambiguous outcome', () => {
  it('keeps everything when the network is not there', async () => {
    const store = await seeded(4);
    const { api } = scriptedApi(() => new ApiError(0, 'No hay conexión con el servidor', null));
    const timers = fakeTimers();
    const sync = open(api, store, timers);

    await sync.drain();

    expect(sync.getSnapshot().pendientes).toBe(4);
    expect(sync.getSnapshot().problem).toMatch(/conexión/);
    expect(await store.unsynced(SESSION, COUNTER, 200)).toHaveLength(4);
    // And it will come back on its own.
    expect(timers.pending).toBe(1);
  });

  it('keeps everything on a 500', async () => {
    const store = await seeded(3);
    const { api } = scriptedApi(() => new ApiError(500, 'boom', null));
    const sync = open(api, store);
    await sync.drain();
    expect(sync.getSnapshot().pendientes).toBe(3);
  });

  it('backs off, doubling and capped at a minute', async () => {
    const store = await seeded(1);
    const { api } = scriptedApi(() => new ApiError(0, 'sin red', null));
    const timers = fakeTimers();
    const sync = open(api, store, timers);

    const seen: number[] = [];
    for (let i = 0; i < 14; i++) {
      await sync.drain();
      seen.push(timers.delays[0]);
      await timers.run();
    }

    // `random: () => 0.5`, so each delay is half its ceiling, floored at the
    // base: 1000, 1000, 2000, 4000 … and then flat once the ceiling is reached.
    expect(seen[0]).toBe(1000);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[6]).toBeGreaterThan(seen[2]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(60_000);
    // It plateaus rather than growing without bound: a tablet that lost signal
    // at nine must still come back within a minute of getting it at two.
    expect(seen[13]).toBe(seen[12]);
    // And nothing left the outbox while all that was happening.
    expect(await store.unsynced(SESSION, COUNTER, 200)).toHaveLength(1);
  });

  it('resets the backoff after a success', async () => {
    const store = await seeded(2);
    let fail = true;
    const { api } = scriptedApi((batch) => (fail ? new ApiError(0, 'sin red', null) : ackFor(batch)));
    const timers = fakeTimers();
    const sync = open(api, store, timers);

    await sync.drain();
    await sync.drain();
    expect(sync.getSnapshot().attempts).toBeGreaterThan(0);
    fail = false;
    await sync.retryNow();
    expect(sync.getSnapshot().attempts).toBe(0);
    expect(sync.getSnapshot().problem).toBeNull();
  });

  it('re-sends a batch whose response was lost, and converges', async () => {
    const store = await seeded(3);
    let first = true;
    const { api, sent } = scriptedApi((batch) => {
      if (first) {
        first = false;
        // The server committed; the tablet never saw the ack.
        return new ApiError(0, 'la red se cayó al responder', null);
      }
      return ackFor(batch);
    });
    const sync = open(api, store);
    await sync.drain();
    await sync.retryNow();

    expect(sent).toHaveLength(2);
    expect(sent[0].map((l) => l.event.id)).toEqual(sent[1].map((l) => l.event.id));
    expect(sync.getSnapshot().pendientes).toBe(0);
  });
});

describe('the three failure modes', () => {
  it('resumes from expectedFrom on a gap, and converges', async () => {
    const store = await seeded(6);
    await store.markSynced(SESSION, COUNTER, 4);
    const { api, sent } = scriptedApi((batch, call) => {
      if (call === 1) {
        return new ApiError(409, 'faltan eventos', { code: 'SEQUENCE_GAP', expectedFrom: 3 });
      }
      return ackFor(batch);
    });
    const sync = open(api, store);

    await sync.drain();

    expect(sent[0].map((l) => l.event.seq)).toEqual([5, 6]);
    // Resent from where the server actually is, not from where this device
    // thought it was.
    expect(sent[1].map((l) => l.event.seq)).toEqual([3, 4, 5, 6]);
    expect(sync.getSnapshot().pendientes).toBe(0);
  });

  it('stops on a fork, keeps the outbox, and says what happened', async () => {
    const store = await seeded(3);
    const { api, sent } = scriptedApi(
      () => new ApiError(409, 'se bifurcó', { code: 'CHAIN_FORK', atSeq: 2 }),
    );
    const timers = fakeTimers();
    const sync = open(api, store, timers);

    await sync.drain();

    expect(sync.getSnapshot().stopped).toMatchObject({ kind: 'fork' });
    expect(sync.getSnapshot().pendientes).toBe(3);
    expect(await store.unsynced(SESSION, COUNTER, 200)).toHaveLength(3);
    // No retry is armed: a loop hammering a fork is worse than a stop.
    expect(timers.pending).toBe(0);
    await sync.drain();
    expect(sent).toHaveLength(1);
  });

  it('names a two-tablet collision as itself', async () => {
    const store = await seeded(1);
    const { api } = scriptedApi(
      () => new ApiError(409, 'otra tableta', { code: 'DEVICE_COLLISION' }),
    );
    const sync = open(api, store);
    await sync.drain();
    expect(sync.getSnapshot().stopped?.title).toMatch(/Otra tableta/);
  });

  it('keeps everything when the session was sealed, and offers it as a file', async () => {
    const store = await seeded(4);
    const { api } = scriptedApi(
      () => new ApiError(409, 'sellada', { code: 'SESSION_SEALED', estado: 'sellado' }),
    );
    const sync = open(api, store);

    await sync.drain();

    const state = sync.getSnapshot();
    expect(state.stopped).toMatchObject({ kind: 'sealed' });
    // Not blaming the counter, and not deleting their afternoon.
    expect(state.stopped!.detail).toMatch(/No es un error tuyo/);
    expect(state.pendientes).toBe(0);
    expect(state.rechazados).toBe(4);
    expect(await store.rejected(SESSION, COUNTER)).toHaveLength(4);

    const file = JSON.parse(await sync.rejectedExport()) as { eventos: unknown[]; motivo: string };
    expect(file.motivo).toBe('rechazado_sesion_sellada');
    expect(file.eventos).toHaveLength(4);
  });
});

describe('finishing degrades, and never blocks', () => {
  it('returns when the timeout fires, with the work still held', async () => {
    const store = await seeded(147);
    // A server that never answers. `drainWithin` must still resolve.
    const { api } = scriptedApi(() => new Promise(() => {}) as never);
    const timers = fakeTimers();
    const sync = open(api, store, timers);

    const finished = sync.drainWithin(8_000);
    // The 8s cap is a scheduled callback, and firing it is what the tablet
    // being carried out of the bodega looks like.
    await timers.run();
    expect(await finished).toBe(false);

    await sync.refresh();
    expect(sync.getSnapshot().pendientes).toBe(147);
  });

  it('returns true when everything lands inside the window', async () => {
    const store = await seeded(3);
    const { api } = scriptedApi((batch) => ackFor(batch, 'terminado_confirmado'));
    const sync = open(api, store);
    expect(await sync.drainWithin(8_000)).toBe(true);
    expect(sync.getSnapshot().estado).toBe('terminado_confirmado');
  });

  it("takes the server's word for terminado_confirmado, never its own", async () => {
    const store = await seeded(2);
    const { api } = scriptedApi((batch) => ackFor(batch, 'terminado_incompleto'));
    const sync = open(api, store);
    sync.setDeviceEstado('terminado_local');
    await sync.drain();
    // The device claimed; the server did not confirm; the claim stands as a
    // claim.
    expect(sync.getSnapshot().estado).toBe('terminado_local');
    expect(sync.getSnapshot().serverEstado).toBe('terminado_incompleto');
  });
});
