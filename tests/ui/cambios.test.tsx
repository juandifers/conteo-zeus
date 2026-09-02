// @vitest-environment jsdom
/**
 * The reassignment screen — P2.3.5 §4b, §5.
 *
 * The thing worth a rendering test here is not the form. It is the **warning**,
 * because that warning is the whole answer to a problem the software cannot
 * solve: Luis is in a cold room with no signal, his articles are being handed to
 * Pedro, and his tablet does not know and cannot know. If he keeps counting, the
 * fold sums both.
 *
 * So the screen's job is to put the risk in front of the person at the moment of
 * the decision, with a name and a time on it. A screen that moved the shelves
 * silently would be a screen that produced a double count nobody could explain
 * three days later.
 *
 * The other two behaviours asserted here are refusals the admin has to be able
 * to read: retirement is not a way to abandon coverage, and `sellar_sin_registros`
 * is not an ordinary button.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cambios } from '../../src/ui/admin/Cambios';
import type { SessionDetail, SyncSnapshot } from '../../src/ui/admin/types';
import type { Api } from '../../src/ui/api';
import { ApiError } from '../../src/ui/api';

afterEach(cleanup);

const ANA = 'counter-ana';
const LUIS = 'counter-luis';

/** Two counters, one section each, three articles apiece. */
function detail(over: Partial<SessionDetail['session']> = {}): SessionDetail {
  return {
    session: {
      id: 'sesion-1',
      bodega: '01',
      fechaCorte: '2026/08/25',
      nombre: null,
      estado: 'abierto',
      sourceName: null,
      sourceHash: 'a'.repeat(64),
      createdAt: '2026-08-31T08:00:00.000Z',
      dispatchedAt: '2026-08-31T08:30:00.000Z',
      itemCount: 6,
      mostrarMarcaRegistrado: true,
      assignmentsVersion: 3,
      parameters: {
        countTargetColumn: 'toma',
        uncountedPolicy: 'existencia',
        differenceColumn: 'computed',
      },
      parametrosVerificados: true,
      parametrosSinVerificar: [],
      ...over,
    },
    items: [],
    familias: null,
    counters: [
      {
        id: ANA,
        nombre: 'Ana',
        token: 'A'.repeat(22),
        estado: 'contando',
        fetchedAt: '2026-08-31T08:40:00.000Z',
        fetchCount: 1,
        lastServerAt: '2026-08-31T10:58:00.000Z',
      },
      {
        id: LUIS,
        nombre: 'Luis',
        token: 'L'.repeat(22),
        estado: 'contando',
        fetchedAt: '2026-08-31T08:41:00.000Z',
        fetchCount: 1,
        lastServerAt: '2026-08-31T10:14:00.000Z',
      },
    ],
    sections: [
      { id: 'sec-almacen', nombre: 'ALMACEN', counterId: ANA },
      { id: 'sec-bar', nombre: 'BAR', counterId: LUIS },
    ],
    assignments: [
      { idarticulo: 1, counterId: ANA, sectionId: 'sec-almacen' },
      { idarticulo: 2, counterId: ANA, sectionId: 'sec-almacen' },
      { idarticulo: 3, counterId: ANA, sectionId: 'sec-almacen' },
      { idarticulo: 4, counterId: LUIS, sectionId: 'sec-bar' },
      { idarticulo: 5, counterId: LUIS, sectionId: 'sec-bar' },
      { idarticulo: 6, counterId: LUIS, sectionId: 'sec-bar' },
    ],
    coverage: { assigned: 6, unassigned: [], duplicated: [], foreign: [], complete: true },
    huecos: [],
    blockers: [],
  } as unknown as SessionDetail;
}

function snapshot(over: Partial<SyncSnapshot['counters'][number]> = {}): SyncSnapshot {
  const row = (id: string, nombre: string, lastServerAt: string | null) => ({
    id,
    nombre,
    estado: 'contando',
    storedMaxSeq: 12,
    lastServerAt,
    forked: false,
    finishReason: null,
    pendingFetch: false,
    chainComplete: true,
  });
  return {
    session: { id: 'sesion-1', estado: 'abierto', assignmentsVersion: 3, readyToSeal: [] },
    counters: [
      row(ANA, 'Ana', '2026-08-31T10:58:00.000Z'),
      { ...row(LUIS, 'Luis', '2026-08-31T10:14:00.000Z'), ...over },
    ],
    acciones: [],
  };
}

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    get: vi.fn(async () => snapshot() as never),
    post: vi.fn(async () => ({ assignmentsVersion: 4, movidos: 3, seccionesCreadas: [], seccionesReapuntadas: [], sinSincronizar: [], nuevos: [] }) as never),
    patch: vi.fn(async () => ({}) as never),
    ...over,
  };
}

/** Pick Luis as the source and BAR as the section being moved. */
async function planMove(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('De'), LUIS);
  await user.click(await screen.findByRole('checkbox'));
}

describe('the mid-count reassignment warning (§4b)', () => {
  it('names the counter whose tablet has not synced, and when it last did', async () => {
    // Two facts, both of which the person pressing the button needs: whose work
    // is being moved, and how long ago their tablet last said anything.
    vi.setSystemTime(new Date('2026-08-31T11:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: () => {} });
    render(<Cambios detail={detail()} api={fakeApi()} onReload={() => {}} />);
    await planMove(user);

    const alert = await screen.findByText(/Luis no ha sincronizado desde/);
    expect(alert.textContent).toMatch(/pueden ser contados dos veces/);
    // And it does not pretend the software can stop it.
    expect(alert.textContent).toMatch(/nada en el sistema puede evitarlo/);
    vi.useRealTimers();
  });

  it('says nothing when the counter pushed a moment ago', async () => {
    vi.setSystemTime(new Date('2026-08-31T11:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: () => {} });
    const api = fakeApi({
      get: vi.fn(async () => snapshot({ lastServerAt: '2026-08-31T10:58:00.000Z' }) as never),
    });
    render(<Cambios detail={detail()} api={api} onReload={() => {}} />);
    await planMove(user);
    expect(screen.queryByText(/pueden ser contados dos veces/)).toBeNull();
    vi.useRealTimers();
  });

  it('treats a counter who has never synced the same way', async () => {
    // «Nunca» and «hace una hora» mean the same thing to the person about to
    // press the button: that tablet does not know.
    vi.setSystemTime(new Date('2026-08-31T11:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: () => {} });
    const api = fakeApi({ get: vi.fn(async () => snapshot({ lastServerAt: null }) as never) });
    render(<Cambios detail={detail()} api={api} onReload={() => {}} />);
    await planMove(user);
    expect(await screen.findByText(/Luis no ha sincronizado nada todavía/)).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('sending the move', () => {
  it('sends per-article moves, the version it planned against, and a reason', async () => {
    const post = vi.fn(async () => ({ assignmentsVersion: 4, movidos: 3, seccionesCreadas: [], seccionesReapuntadas: [], sinSincronizar: [], nuevos: [] }) as never);
    const user = userEvent.setup();
    render(<Cambios detail={detail()} api={fakeApi({ post })} onReload={() => {}} />);

    await user.type(screen.getByLabelText('Quién decide'), 'Marta');
    await user.type(screen.getByLabelText('Motivo'), 'Luis se fue enfermo');
    await planMove(user);
    await user.selectOptions(screen.getByLabelText('A'), ANA);
    await user.click(screen.getByRole('button', { name: /Mover 3 artículos/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/sessions/sesion-1/acciones');
    expect(body.kind).toBe('reasignar');
    expect(body.usuario).toBe('Marta');
    expect(body.motivo).toBe('Luis se fue enfermo');
    // §7: the version the plan was built against, so a concurrent change is a
    // 409 rather than a silent reversal.
    expect(body.version).toBe(3);
    expect(body.moves).toEqual([
      { idarticulo: 4, from: LUIS, to: ANA },
      { idarticulo: 5, from: LUIS, to: ANA },
      { idarticulo: 6, from: LUIS, to: ANA },
    ]);
  });

  it('will not send without a name and a reason on it', async () => {
    const user = userEvent.setup();
    render(<Cambios detail={detail()} api={fakeApi()} onReload={() => {}} />);
    await planMove(user);
    await user.selectOptions(screen.getByLabelText('A'), ANA);
    expect(
      (screen.getByRole('button', { name: /Mover 3 artículos/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('turns a refusal back into the sentences it came from', async () => {
    const post = vi.fn(async () => {
      throw new ApiError(409, 'ese movimiento no se puede hacer', {
        blockers: [{ kind: 'origen-no-tiene', movimientos: [{ idarticulo: 4, from: LUIS }] }],
      });
    });
    const user = userEvent.setup();
    render(<Cambios detail={detail()} api={fakeApi({ post })} onReload={() => {}} />);
    await user.type(screen.getByLabelText('Quién decide'), 'Marta');
    await user.type(screen.getByLabelText('Motivo'), 'x');
    await planMove(user);
    await user.selectOptions(screen.getByLabelText('A'), ANA);
    await user.click(screen.getByRole('button', { name: /Mover 3 artículos/ }));

    expect(await screen.findByText(/Vuelve a cargar y arma el movimiento otra vez/)).toBeTruthy();
  });

  it('shows the link and the name of a counter added mid-count', async () => {
    // P2.1 leaves nothing unassigned, so somebody added at eleven is minted
    // together with the shelves they are being given — and needs the same 22
    // characters on paper as everybody dispatched at eight.
    const post = vi.fn(async () => ({
      assignmentsVersion: 4,
      movidos: 3,
      seccionesCreadas: [],
      seccionesReapuntadas: [],
      sinSincronizar: [],
      nuevos: [{ id: 'nuevo', nombre: 'Carla', token: 'C'.repeat(22) }],
    }) as never);
    const user = userEvent.setup();
    render(<Cambios detail={detail()} api={fakeApi({ post })} onReload={() => {}} />);
    await user.type(screen.getByLabelText('Quién decide'), 'Marta');
    await user.type(screen.getByLabelText('Motivo'), 'vamos lentos');
    await planMove(user);
    await user.selectOptions(screen.getByLabelText('A'), '__nuevo__');
    await user.type(screen.getByLabelText('Nombre del contador nuevo'), 'Carla');
    await user.click(screen.getByRole('button', { name: /Mover 3 artículos/ }));

    expect(await screen.findByText(/#\/c\/C{22}/)).toBeTruthy();
    const [, body] = post.mock.calls[0] as [string, { nuevos: { nombre: string }[] }];
    expect(body.nuevos).toEqual([{ ref: 'nuevo', nombre: 'Carla' }]);
  });
});

describe('retirement and the seal', () => {
  it('will not retire somebody who still holds shelves, and says why', async () => {
    // Retirement is not a way to abandon coverage. The move comes first, which
    // keeps the coverage gate one rule rather than one with an exception.
    const user = userEvent.setup();
    render(<Cambios detail={detail()} api={fakeApi()} onReload={() => {}} />);
    await user.type(screen.getByLabelText('Quién decide'), 'Marta');
    await user.type(screen.getByLabelText('Motivo'), 'se fue enfermo');
    expect((screen.getByLabelText('retirar a Luis') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Reasígnalos antes de retirarlo/).length).toBeGreaterThan(0);
  });

  it('offers «sellar sin sus registros» only for a retired counter with a hole', async () => {
    // Not an ordinary button. It is an admin signing a line that will be printed
    // on the acta saying the count is missing a named person's work, and the
    // right answer is almost always to wait for the tablet.
    const withRetired = detail();
    withRetired.counters[1].estado = 'retirado';
    withRetired.assignments = withRetired.assignments.filter(
      (assignment) => assignment.counterId !== LUIS,
    );
    const api = fakeApi({
      get: vi.fn(async () => {
        const snap = snapshot({ estado: 'retirado', chainComplete: false });
        snap.session.readyToSeal = [
          { kind: 'contador-retirado-incompleto', counterId: LUIS, nombre: 'Luis' },
        ];
        return snap as never;
      }),
    });
    const user = userEvent.setup();
    render(<Cambios detail={withRetired} api={api} onReload={() => {}} />);
    await user.type(screen.getByLabelText('Quién decide'), 'Marta');
    await user.type(screen.getByLabelText('Motivo'), 'la tableta no volvió');

    const button = await screen.findByLabelText('sellar sin los registros de Luis');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // Said twice on purpose, in two voices: beside the button, and in the
    // sealing gate's own list of what is standing in the way.
    expect(screen.getByText(/«sellar sin sus registros» deja escrito en el acta/)).toBeTruthy();
    expect(screen.getByText(/Espera su tableta, o firma «sellar sin sus registros»/)).toBeTruthy();
  });

  it('does not offer it when the retired counter’s chain is whole', async () => {
    const withRetired = detail();
    withRetired.counters[1].estado = 'retirado';
    withRetired.assignments = withRetired.assignments.filter(
      (assignment) => assignment.counterId !== LUIS,
    );
    const api = fakeApi({
      get: vi.fn(async () => snapshot({ estado: 'retirado', chainComplete: true }) as never),
    });
    render(<Cambios detail={withRetired} api={api} onReload={() => {}} />);
    await waitFor(() =>
      expect(screen.queryByLabelText('sellar sin los registros de Luis')).toBeNull(),
    );
  });
});
