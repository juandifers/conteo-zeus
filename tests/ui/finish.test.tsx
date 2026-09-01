// @vitest-environment jsdom
/**
 * «Terminar»: the gap review, and what the screen says when the network does
 * not answer.
 *
 * Two rules, and every test here is about one of them.
 *
 * **Finishing degrades, never hangs.** There is no connectivity in the bodega,
 * a blocking spinner is a force-close, and a force-close is the one thing that
 * loses data. So the assertions are about what a counter can still see and do
 * after the request has gone nowhere.
 *
 * **The gap list is their own sections and nothing else** (P2.3 §5a). Not the
 * catalogue, not another counter's shelves — which is what P2.1's scoped
 * assignment bought, and the only reason the list is actionable.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { type ChainedEvent } from '../../src/domain';
import { ApiError, type Api } from '../../src/ui/api';
import { FinishPanel } from '../../src/ui/counter/Finish';
import { SyncBar } from '../../src/ui/counter/SyncBar';
import { CounterSync } from '../../src/ui/counter/sync';
import { COUNTER, PANADERIA, PROTEINAS, counterStore, sampleCatalogue } from './counterHarness';
import { SESSION_ID, ID } from './harness';

afterEach(cleanup);

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

function fakeApi(post: (batch: ChainedEvent[]) => unknown): Api {
  return {
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
}

async function mount(post: (batch: ChainedEvent[]) => unknown) {
  const catalogue = sampleCatalogue();
  const { store, chain } = await counterStore(catalogue);
  const clocks = timers();
  const sync = new CounterSync(fakeApi(post), chain, {
    sessionId: SESSION_ID,
    counterId: COUNTER,
    token: 'aaaaaaaaaaaaaaaaaaaaaa',
    schedule: clocks.schedule,
    cancel: clocks.cancel,
    random: () => 0.5,
  });

  /** Both halves of the counting screen's bottom: the status, then the panel. */
  function Screen() {
    const events = store.getSnapshot().events;
    return (
      <>
        <SyncBar sync={sync} />
        <FinishPanel
          store={store}
          sync={sync}
          catalogue={catalogue}
          events={events}
          onCount={() => {}}
        />
      </>
    );
  }

  const view = render(<Screen />);
  const redraw = () => view.rerender(<Screen />);
  store.subscribe(redraw);
  return { store, sync, chain, clocks, catalogue, redraw };
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
    counterEstado: last.kind === 'finish' ? 'terminado_confirmado' : 'contando',
    serverAt: '2026-08-31T14:00:00.000Z',
  };
};

describe('the gap review', () => {
  it('lists this counter’s own sections, and only articles with nothing standing', async () => {
    const { store, redraw } = await mount((batch) => ack(batch));
    store.addCount(ID.pancetaKilo, 4);
    await store.settled();
    redraw();

    expect(screen.getByText(/Cuarto frío proteínas · 3 artículos/)).toBeTruthy();
    expect(screen.getByText(/Panadería · 2 artículos/)).toBeTruthy();

    // The counted one is gone from the gap rows; the other four are there.
    const gaps = screen.getAllByRole('button', { name: /^contar / });
    expect(gaps).toHaveLength(PROTEINAS.length + PANADERIA.length - 1);

    // And nothing outside the assignment: the bodega has 298 rows.
    expect(screen.queryByText(/CREMA DE LECHE/)).toBeNull();
  });

  it('a withdrawn entry puts the article back in the gap list', async () => {
    const { store, redraw } = await mount((batch) => ack(batch));
    const entry = store.addCount(ID.panTajado, 6);
    await store.settled();
    redraw();
    expect(screen.getAllByRole('button', { name: /^contar / })).toHaveLength(4);

    store.withdraw(ID.panTajado, entry.id);
    await store.settled();
    redraw();
    expect(screen.getAllByRole('button', { name: /^contar / })).toHaveLength(5);
  });

  it('«Está vacío» costs a second, deliberate tap and records a zero', async () => {
    const { store, redraw } = await mount((batch) => ack(batch));
    const user = userEvent.setup();

    await user.click(screen.getAllByRole('button', { name: /^marcar .* como vacío$/ })[0]);
    expect(screen.getByText(/¿Confirmas que este lugar está vacío\?/)).toBeTruthy();
    // Nothing is written until the second tap.
    expect(store.getSnapshot().events).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    await store.settled();
    redraw();
    expect(store.getSnapshot().events).toMatchObject([{ kind: 'add', qty: 0 }]);
  });

  it('offers counting or empty, and never a waiver', async () => {
    // There is no «sin novedad» here and there must not be: waiving an
    // uncounted row means vouching for a book figure, and the book figure is
    // not on this device. That decision is the admin's, at review (P2.4).
    await mount((batch) => ack(batch));
    expect(screen.queryByText(/sin novedad/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sin verificar/i })).toBeNull();
  });

  it('lets somebody finish with gaps, and says so on the button', async () => {
    const { store } = await mount((batch) => ack(batch));
    const button = screen.getByRole('button', { name: 'Terminar de todas formas' });
    await userEvent.setup().click(button);
    await store.settled();
    expect(store.getSnapshot().events.map((event) => event.kind)).toEqual(['finish']);
  });
});

describe('the button', () => {
  it('confirms when everything lands', async () => {
    const { store, sync } = await mount((batch) => ack(batch));
    store.addCount(ID.pancetaKilo, 3);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: /^Terminar/ }));
    // Both the status line and the panel title say it, which is deliberate:
    // the status is persistent and the panel is where the counter is looking.
    expect(await screen.findAllByText(/Terminado y confirmado/)).not.toHaveLength(0);
    expect(screen.getByText(/El servidor tiene todo lo que contaste/)).toBeTruthy();
  });

  it('does not hang when the server never answers, and says what is still held', async () => {
    const { store, sync, clocks } = await mount(() => new Promise(() => {}) as never);
    for (let i = 0; i < 3; i++) store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: /^Terminar/ }));
    // The 8-second cap. Firing it is the tablet being carried out of the bodega.
    clocks.run();
    await Promise.resolve();

    // Four: the three counts and the `finish` itself.
    expect(await screen.findByText(/4 registros sin subir/)).toBeTruthy();
    expect(screen.getByText(/Acércate a la zona con señal antes de irte/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reabrir' })).toBeTruthy();
  });

  it('confirms later, with nobody pressing anything', async () => {
    let answer: (batch: ChainedEvent[]) => unknown = () => new ApiError(0, 'sin red', null);
    const { store, sync } = await mount((batch) => answer(batch));
    store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: /^Terminar/ }));
    expect(await screen.findByText(/2 registros sin subir/)).toBeTruthy();

    // Connectivity comes back. The drain is what the timer, `online` and the
    // foreground all call; here the test calls it directly.
    answer = (batch) => ack(batch);
    await sync.drain();
    expect(await screen.findAllByText(/Terminado y confirmado/)).not.toHaveLength(0);
  });

  it('offers reopen after finishing, and counting resumes on the same numbering', async () => {
    const { store, sync } = await mount((batch) => ack(batch));
    store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.refresh();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Terminar/ }));
    await screen.findByRole('button', { name: 'Reabrir' });
    await user.click(screen.getByRole('button', { name: 'Reabrir' }));

    expect(store.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await screen.findByRole('button', { name: /^Terminar/ })).toBeTruthy();
  });

  it('says what the counter did before it asks them to commit to it', async () => {
    const { store, redraw } = await mount((batch) => ack(batch));
    store.addCount(ID.pancetaKilo, 4);
    store.addCount(ID.panTajado, 0);
    store.note('3 cajas sin código arriba', null);
    await store.settled();
    redraw();

    const summary = screen.getByText('Tu trabajo').closest('.panel')!;
    const line = (label: string) =>
      within(summary).getByText(label).parentElement!.textContent;
    expect(line('artículos registrados')).toContain('2');
    expect(line('sin registrar')).toContain('3');
    expect(line('lugares vacíos (cero)')).toContain('1');
    expect(line('notas')).toContain('1');
  });
});

describe('when the drain stops for good', () => {
  async function stopped(code: string, message: string) {
    const catalogue = sampleCatalogue();
    const { store, chain } = await counterStore(catalogue);
    const exported: string[] = [];
    const api: Api = {
      get: async () => {
        throw new Error('no');
      },
      patch: async () => {
        throw new Error('no');
      },
      post: async () => {
        throw new ApiError(409, message, { code });
      },
    };
    const sync = new CounterSync(api, chain, {
      sessionId: SESSION_ID,
      counterId: COUNTER,
      token: 'aaaaaaaaaaaaaaaaaaaaaa',
    });
    render(<SyncBar sync={sync} onExport={(json) => exported.push(json)} />);
    return { store, sync, exported };
  }

  it('a sealed session is explained without blaming the counter, and offered as a file', async () => {
    const { store, sync, exported } = await stopped('SESSION_SEALED', 'sellada');
    store.addCount(ID.pancetaKilo, 1);
    store.addCount(ID.panTajado, 2);
    await store.settled();
    await sync.drain();

    expect(await screen.findByText(/La sesión ya se cerró/)).toBeTruthy();
    expect(screen.getByText(/No es un error tuyo/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: /Exportar 2 registros/ }));
    await screen.findByRole('button', { name: /Exportar/ });
    expect(JSON.parse(exported[0]).eventos).toHaveLength(2);
  });

  it('a fork tells the counter to stop, and offers no export', async () => {
    const { store, sync } = await stopped('DEVICE_COLLISION', 'otra tableta');
    store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.drain();

    expect(await screen.findByText(/Otra tableta está usando este mismo enlace/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Exportar/ })).toBeNull();
    // Not a retry button either: retrying a fork makes it worse.
    expect(screen.queryByRole('button', { name: /Reintentar/ })).toBeNull();
  });
});

describe('the sync status distinguishes normal from needs-action (§6)', () => {
  it('a queue while counting is neutral, not a warning', async () => {
    const { store, sync } = await mount(() => new Promise(() => {}) as never);
    store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.refresh();

    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/1 registro sin subir · se suben solos cuando haya señal/);
    // The alert role is reserved for the state that needs a person to act.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the same queue after «Terminar» is the state that needs action', async () => {
    const { store, sync, clocks } = await mount(() => new Promise(() => {}) as never);
    store.addCount(ID.pancetaKilo, 1);
    await store.settled();
    await sync.refresh();

    await userEvent.setup().click(screen.getByRole('button', { name: /^Terminar/ }));
    clocks.run();
    await Promise.resolve();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Acércate a la zona con señal antes de irte/);
  });
});
