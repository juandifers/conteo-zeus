// @vitest-environment jsdom
/**
 * Preparing a tablet, and then losing the network.
 *
 * The acceptance criterion is one sentence — *a prepared tablet loads its full
 * assignment offline after one fetch* — and it is the criterion the whole of
 * P2.1 exists to make true. There is no signal in the bodega and no second
 * chance at it, so this is asserted against the real IndexedDB adapter with the
 * network genuinely failing rather than against a store that pretends.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { Prepare } from '../../src/ui/counter/Prepare';
import { ApiError, type Api } from '../../src/ui/api';
import { DexieAssignmentStore } from '../../src/store/assignments';
import { ConteoDb } from '../../src/store/db';
import { counterPayload, type CounterPayload } from '../../src/domain';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import { readSample, SAMPLE_XLS } from '../helpers';

afterEach(cleanup);

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));

const PAYLOAD: CounterPayload = counterPayload({
  session: {
    id: 'sesion-1',
    bodega: '01',
    fechaCorte: '2025/04/30',
    nombre: 'Corte de abril',
    mostrarMarcaRegistrado: true,
  },
  counter: { id: 'c1', nombre: 'Ana', token: 'A'.repeat(22), estado: 'asignado', fetchedAt: null },
  sections: [
    { id: 's1', nombre: 'ALMACEN', counterId: 'c1' },
    { id: 's2', nombre: 'NEVERA', counterId: 'c1' },
  ],
  assignments: catalogue
    .slice(0, 60)
    .map((item, index) => ({
      idarticulo: item.idarticulo,
      counterId: 'c1',
      sectionId: index < 40 ? 's1' : 's2',
    })),
  items: catalogue,
});

let db: ConteoDb;
let store: DexieAssignmentStore;

function apiThat(get: Api['get']): Api {
  return { get, post: vi.fn(), patch: vi.fn() } as unknown as Api;
}

beforeEach(async () => {
  db = new ConteoDb(`prepare-${Math.random()}`);
  await db.open();
  store = new DexieAssignmentStore(db);
});

describe('preparing a tablet', () => {
  it('downloads the assignment once and says it is ready', async () => {
    const get = vi.fn(async () => PAYLOAD as never);
    render(
      <Prepare
        token={'A'.repeat(22)}
        api={apiThat(get)}
        store={store}
        now={() => '2026-08-31T14:00:00.000Z'}
      />,
    );

    await screen.findByText(/Listo para contar sin señal/);
    expect(screen.getByText(/60 artículos en 2 secciones/)).toBeTruthy();
    expect(screen.getByText('ALMACEN')).toBeTruthy();
    expect(get).toHaveBeenCalledWith(`/api/c/${'A'.repeat(22)}`);
  });

  it('stores exactly what the server sent, and nothing reshaped', async () => {
    // The device holds the allowlisted payload verbatim. Unpacking it into the
    // P1 tables would give `existencia` and `costo` somewhere to live on a
    // counting device, which is the thing §2.1 forbids.
    render(
      <Prepare
        token={'A'.repeat(22)}
        api={apiThat(vi.fn(async () => PAYLOAD as never))}
        store={store}
        now={() => '2026-08-31T14:00:00.000Z'}
      />,
    );
    await screen.findByText(/Listo para contar sin señal/);

    const row = await store.load('A'.repeat(22));
    expect(row).not.toBeNull();
    expect(row!.payload).toEqual(PAYLOAD);
    expect(row!.fetchedAt).toBe('2026-08-31T14:00:00.000Z');
    expect(JSON.stringify(row!.payload)).not.toMatch(/existencia|costo|rawRow/);
  });

  it('opens with the whole assignment after the network is gone — the point of all of this', async () => {
    // One fetch on office wifi.
    const { unmount } = render(
      <Prepare
        token={'A'.repeat(22)}
        api={apiThat(vi.fn(async () => PAYLOAD as never))}
        store={store}
        now={() => '2026-08-31T14:00:00.000Z'}
      />,
    );
    await screen.findByText(/Listo para contar sin señal/);
    unmount();
    cleanup();

    // And now a storeroom.
    const offline = vi.fn(async () => {
      throw new ApiError(0, 'No hay conexión con el servidor (Failed to fetch).', null);
    });
    render(<Prepare token={'A'.repeat(22)} api={apiThat(offline)} store={store} />);

    await screen.findByText(/Listo para contar sin señal/);
    expect(screen.getByText(/60 artículos en 2 secciones/)).toBeTruthy();
    expect(screen.getByText('NEVERA')).toBeTruthy();
    // The failure is reported, and reported as a remark rather than a fault.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Lo que ya está descargado sirve igual/),
    );
  });

  it('says the tablet is not ready when it has never fetched and cannot', async () => {
    const offline = vi.fn(async () => {
      throw new ApiError(0, 'No hay conexión con el servidor (Failed to fetch).', null);
    });
    render(<Prepare token={'B'.repeat(22)} api={apiThat(offline)} store={store} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/todavía no está lista/i);
    expect(alert.textContent).toMatch(/wifi de la oficina/);
    expect(alert.textContent).toMatch(/adentro|no tiene señal/);
  });

  it('replaces what it holds when it fetches again, rather than keeping two', async () => {
    render(
      <Prepare
        token={'A'.repeat(22)}
        api={apiThat(vi.fn(async () => PAYLOAD as never))}
        store={store}
        now={() => '2026-08-31T14:00:00.000Z'}
      />,
    );
    await screen.findByText(/Listo para contar sin señal/);
    cleanup();

    const smaller: CounterPayload = {
      ...PAYLOAD,
      secciones: [{ ...PAYLOAD.secciones[0], items: PAYLOAD.secciones[0].items.slice(0, 5) }],
    };
    render(
      <Prepare
        token={'A'.repeat(22)}
        api={apiThat(vi.fn(async () => smaller as never))}
        store={store}
        now={() => '2026-08-31T15:00:00.000Z'}
      />,
    );
    await screen.findByText(/5 artículos en 1 sección/);
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses nothing on its own — a rejected token is the server’s answer', async () => {
    const notFound = vi.fn(async () => {
      throw new ApiError(404, 'ese enlace no existe', null);
    });
    render(<Prepare token={'C'.repeat(22)} api={apiThat(notFound)} store={store} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/ese enlace no existe/);
  });
});
