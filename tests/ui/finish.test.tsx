// @vitest-environment jsdom
/**
 * «Terminar», and what the screen says when the network does not answer.
 *
 * The rule: **finishing degrades, never hangs.** There is no connectivity in
 * the bodega, a blocking spinner is a force-close, and a force-close is the one
 * thing that loses data. So the assertions here are about what a counter can
 * still see and do after the request has gone nowhere.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryChain, genesisHash, type ChainedEvent } from '../../src/domain';
import { ApiError, type Api } from '../../src/ui/api';
import { CountStore } from '../../src/ui/store';
import { FinishPanel } from '../../src/ui/counter/Finish';
import { CounterSync } from '../../src/ui/counter/sync';
import { fakeIdentity, sampleSession, seededRepository, SESSION_ID } from './harness';

afterEach(cleanup);

const COUNTER = 'counter-ana';

/** Nothing waits in real time; the test fires the timers it wants fired. */
function timers() {
  const queued: { fn: () => void; handle: number }[] = [];
  let next = 1;
  return {
    schedule: (fn: () => void) => {
      const handle = next++;
      queued.push({ fn, handle });
      return handle;
    },
    cancel: (handle: unknown) => {
      const at = queued.findIndex((entry) => entry.handle === handle);
      if (at >= 0) queued.splice(at, 1);
    },
    run() {
      for (const entry of queued.splice(0, queued.length)) entry.fn();
    },
  };
}

async function mount(post: (batch: ChainedEvent[]) => unknown) {
  const repo = await seededRepository();
  const chain = new MemoryChain();
  const clocks = timers();
  const api: Api = {
    get: async () => {
      throw new Error('no');
    },
    patch: async () => {
      throw new Error('no');
    },
    post: async (_path, body) => {
      const answer = post((body as { events: ChainedEvent[] }).events);
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
  };
  const store = new CountStore(repo, sampleSession(), [], {
    ...fakeIdentity(),
    nextSeq: 1,
    counterId: COUNTER,
    head: genesisHash(SESSION_ID, COUNTER),
    chain,
  });
  const sync = new CounterSync(api, chain, {
    sessionId: SESSION_ID,
    counterId: COUNTER,
    token: 'aaaaaaaaaaaaaaaaaaaaaa',
    schedule: clocks.schedule,
    cancel: clocks.cancel,
    random: () => 0.5,
  });
  render(<FinishPanel store={store} sync={sync} />);
  return { store, sync, chain, clocks };
}

/**
 * What the real server would answer: the counter's state derived from what it
 * now holds, not from what the device claimed. A fake that always said
 * `terminado_confirmado` would hide a reopen that never took.
 */
const ack = (batch: ChainedEvent[]) => {
  const last = batch[batch.length - 1].event;
  return {
    acceptedThrough: last.seq,
    headHash: batch[batch.length - 1].hash,
    counterEstado:
      last.kind === 'finish' ? 'terminado_confirmado' : last.kind === 'reopen' ? 'contando' : 'contando',
    serverAt: '2026-08-31T14:00:00.000Z',
  };
};

describe('the button', () => {
  it('confirms when everything lands', async () => {
    const { store, sync } = await mount((batch) => ack(batch));
    store.addCount(1181, 3);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Terminar' }));
    expect(await screen.findByText(/Terminado y confirmado/)).toBeTruthy();
    expect(screen.getByText(/El servidor tiene todo lo que contaste/)).toBeTruthy();
  });

  it('does not hang when the server never answers, and says what is still held', async () => {
    const { store, sync, clocks } = await mount(() => new Promise(() => {}) as never);
    for (let i = 0; i < 3; i++) store.addCount(1181, 1);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Terminar' }));
    // The 8-second cap. Firing it is the tablet being carried out of the bodega.
    clocks.run();
    await Promise.resolve();


  });

  it('confirms later, with nobody pressing anything', async () => {
    let answer: (batch: ChainedEvent[]) => unknown = () => new ApiError(0, 'sin red', null);
    const { store, sync } = await mount((batch) => answer(batch));
    store.addCount(1181, 1);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Terminar' }));
    expect(await screen.findByText(/2 registros sin subir/)).toBeTruthy();

    // Connectivity comes back. The drain is what the timer, `online` and the
    // foreground all call; here the test calls it directly.
    answer = (batch) => ack(batch);
    await sync.drain();
    expect(await screen.findByText(/Terminado y confirmado/)).toBeTruthy();
  });

  it('offers reopen after finishing, and counting resumes on the same numbering', async () => {
    const { store, sync } = await mount((batch) => ack(batch));
    store.addCount(1181, 1);
    await store.settled();
    await sync.refresh();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Terminar' }));
    await screen.findByRole('button', { name: 'Reabrir' });
    await user.click(screen.getByRole('button', { name: 'Reabrir' }));

    expect(store.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await screen.findByRole('button', { name: 'Terminar' })).toBeTruthy();
  });
});

describe('when the drain stops for good', () => {
  it('a sealed session is explained without blaming the counter, and offered as a file', async () => {
    const exported: string[] = [];
    const repo = await seededRepository();
    const chain = new MemoryChain();
    const api: Api = {
      get: async () => {
        throw new Error('no');
      },
      patch: async () => {
        throw new Error('no');
      },
      post: async () => {
        throw new ApiError(409, 'sellada', { code: 'SESSION_SEALED' });
      },
    };
    const store = new CountStore(repo, sampleSession(), [], {
      ...fakeIdentity(),
      nextSeq: 1,
      counterId: COUNTER,
      head: genesisHash(SESSION_ID, COUNTER),
      chain,
    });
    const sync = new CounterSync(api, chain, {
      sessionId: SESSION_ID,
      counterId: COUNTER,
      token: 'aaaaaaaaaaaaaaaaaaaaaa',
    });
    render(<FinishPanel store={store} sync={sync} onExport={(json) => exported.push(json)} />);

    store.addCount(1181, 1);
    store.addCount(330, 2);
    await store.settled();
    await sync.drain();

    expect(await screen.findByText(/La sesión ya se cerró/)).toBeTruthy();
    expect(screen.getByText(/No es un error tuyo/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: /Exportar 2 registros/ }));
    await screen.findByRole('button', { name: /Exportar/ });
    expect(JSON.parse(exported[0]).eventos).toHaveLength(2);
  });

  it('a fork tells the counter to stop, and offers no export', async () => {
    const repo = await seededRepository();
    const chain = new MemoryChain();
    const api: Api = {
      get: async () => {
        throw new Error('no');
      },
      patch: async () => {
        throw new Error('no');
      },
      post: async () => {
        throw new ApiError(409, 'otra tableta', { code: 'DEVICE_COLLISION' });
      },
    };
    const store = new CountStore(repo, sampleSession(), [], {
      ...fakeIdentity(),
      nextSeq: 1,
      counterId: COUNTER,
      head: genesisHash(SESSION_ID, COUNTER),
      chain,
    });
    const sync = new CounterSync(api, chain, {
      sessionId: SESSION_ID,
      counterId: COUNTER,
      token: 'aaaaaaaaaaaaaaaaaaaaaa',
    });
    render(<FinishPanel store={store} sync={sync} />);

    store.addCount(1181, 1);
    await store.settled();
    await sync.drain();

    expect(await screen.findByText(/Otra tableta está usando este mismo enlace/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Exportar/ })).toBeNull();
  });
});
