// @vitest-environment jsdom
/**
 * The admin path, from a file to five tablets.
 *
 * Three things are worth a rendering test here, and they are the three that
 * cannot be asserted anywhere else: that a refused file leaves nothing behind,
 * that the coverage gate is a gate rather than a warning, and that the
 * dispatch screen names the tablet nobody has loaded.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

// jsdom's `File` has no `arrayBuffer`. The upload path reads one, and reading a
// file is not the thing under test here, so the gap is filled rather than
// designed around: production code that carried a FileReader fallback for a
// test environment would be worse than this line.
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
}

import { AdminApp } from '../../src/ui/admin/AdminApp';
import { DeleteSession, Reparto } from '../../src/ui/admin/Reparto';
import { Dispatched } from '../../src/ui/admin/Dispatched';
import { savePlan } from '../../src/ui/admin/plan';
import type { Api } from '../../src/ui/api';
import { ApiError } from '../../src/ui/api';
import { deriveFamilies } from '../../src/domain';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import { readSample, SAMPLE_TXT, SAMPLE_XLS } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));

function detailFor(over: Partial<Parameters<typeof Reparto>[0]['detail']> = {}) {
  return {
    session: {
      id: 'sesion-1',
      bodega: '01',
      fechaCorte: '2025/04/30',
      nombre: null,
      estado: 'borrador',
      sourceName: 'COMESTIBLES ALMACEN.xls',
      sourceHash: 'a'.repeat(64),
      createdAt: '2026-08-31T12:00:00.000Z',
      dispatchedAt: null,
      itemCount: catalogue.length,
      mostrarMarcaRegistrado: true,
      parameters: {
        countTargetColumn: 'toma',
        uncountedPolicy: 'existencia',
        differenceColumn: 'computed',
      },
      parametrosVerificados: true,
      parametrosSinVerificar: [],
    },
    items: catalogue,
    familias: deriveFamilies(catalogue),
    counters: [],
    sections: [],
    assignments: [],
    coverage: { assigned: 0, unassigned: [], duplicated: [], foreign: [], complete: false },
    huecos: [],
    blockers: [],
    ...over,
  } as Parameters<typeof Reparto>[0]['detail'];
}

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    get: vi.fn(async () => ({}) as never),
    post: vi.fn(async () => ({}) as never),
    patch: vi.fn(async () => ({}) as never),
    del: vi.fn(async () => ({}) as never),
    ...over,
  };
}

describe('uploading a file', () => {
  it('refuses a sheared catalogue in the browser and sends nothing', async () => {
    // The sample `.txt` beside the `.xls`: same bodega, same corte, its `nombre`
    // column sorted away from its keys. §4.1 refuses rather than warns, and the
    // person holding the file is still standing in front of Zeus and can export
    // it again — which is the whole reason the check runs here first.
    const post = vi.fn();
    const api = fakeApi({ get: vi.fn(async () => ({ sessions: [] }) as never), post });
    render(<AdminApp api={api} hash="#/admin" navigate={() => {}} />);

    const file = new File([readSample(SAMPLE_TXT)], 'COMESTIBLES ALMACEN.txt');
    await userEvent.upload(
      screen.getByLabelText(/Archivo exportado de Zeus/i) as HTMLInputElement,
      file,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/columna de nombres|se contradice/i);
    expect(alert.textContent).toMatch(/No se creó ninguna sesión/);
    expect(post).not.toHaveBeenCalled();
  });

  it('sends the file and our own reading of it, so the two can be compared', async () => {
    const post = vi.fn(async () => ({ id: 'nueva' }) as never);
    const api = fakeApi({ get: vi.fn(async () => ({ sessions: [] }) as never), post });
    const navigate = vi.fn();
    render(<AdminApp api={api} hash="#/admin" navigate={navigate} />);

    await userEvent.upload(
      screen.getByLabelText(/Archivo exportado de Zeus/i) as HTMLInputElement,
      new File([readSample(SAMPLE_XLS)], 'COMESTIBLES ALMACEN.xls'),
    );

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as [string, { rows: unknown[]; sourceBytesBase64: string }];
    expect(path).toBe('/api/sessions');
    expect(body.rows).toHaveLength(298);
    expect(body.sourceBytesBase64.length).toBeGreaterThan(1000);
    expect(navigate).toHaveBeenCalledWith('#/admin/nueva');
  });

  it('shows what the server saw when the two readings disagree', async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ sessions: [] }) as never),
      post: vi.fn(async () => {
        throw new ApiError(409, 'el navegador y el servidor leyeron el archivo distinto', {
          differences: ['idarticulo 41: nombre "X" != "PECHUGA DE POLLO"'],
        });
      }),
    });
    render(<AdminApp api={api} hash="#/admin" navigate={() => {}} />);
    await userEvent.upload(
      screen.getByLabelText(/Archivo exportado de Zeus/i) as HTMLInputElement,
      new File([readSample(SAMPLE_XLS)], 'x.xls'),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/PECHUGA DE POLLO/);
  });
});

describe('the list archives finished counts (Conteos anteriores)', () => {
  function summaryFor(over: Record<string, unknown>) {
    return {
      id: 'sesion-x',
      bodega: '01',
      fechaCorte: '2025/04/30',
      nombre: null,
      estado: 'abierto',
      sourceName: 'COMESTIBLES ALMACEN.xls',
      sourceHash: 'a'.repeat(64),
      createdAt: '2026-08-31T12:00:00.000Z',
      dispatchedAt: null,
      itemCount: 100,
      mostrarMarcaRegistrado: true,
      assignmentsVersion: 1,
      ...over,
    };
  }

  const SESSIONS = [
    summaryFor({ id: 'viva', bodega: '44', fechaCorte: '2026/08/28', sourceName: 'LICORES BAR.xls' }),
    summaryFor({ id: 'vieja', estado: 'cerrado', fechaCorte: '2025/04/30' }),
    summaryFor({
      id: 'sellada',
      estado: 'sellado',
      fechaCorte: '2025/03/31',
      sourceName: 'PANADERIA MARZO.xls',
      createdAt: '2025-04-01T09:00:00.000Z',
    }),
  ];

  function listWith(sessions: unknown[]) {
    const api = fakeApi({ get: vi.fn(async () => ({ sessions }) as never) });
    render(<AdminApp api={api} hash="#/admin" navigate={() => {}} />);
  }

  it('keeps the working list to what is still moving', async () => {
    listWith(SESSIONS);
    // The open session is a plain row; the finished two live in their own
    // section below, so the page that answers «¿qué está pasando hoy?» does
    // not grow by one row per month forever.
    await screen.findByText(/Bodega 44 · corte 2026\/08\/28/);
    const archive = screen.getByRole('region', { name: 'Conteos anteriores' });
    expect(within(archive).getByText(/corte 2025\/04\/30/)).toBeTruthy();
    expect(within(archive).getByText(/corte 2025\/03\/31/)).toBeTruthy();
    expect(within(archive).getByText('2 conteos sellados')).toBeTruthy();
    // And the archived rows say what the search matches on: the file.
    expect(within(archive).getByText(/PANADERIA MARZO\.xls/)).toBeTruthy();
  });

  it('finds an old count by its file name', async () => {
    listWith(SESSIONS);
    const search = await screen.findByLabelText('Buscar conteos anteriores');
    await userEvent.type(search, 'panaderia');
    const archive = screen.getByRole('region', { name: 'Conteos anteriores' });
    expect(within(archive).getByText(/PANADERIA MARZO\.xls/)).toBeTruthy();
    expect(within(archive).queryByText(/COMESTIBLES ALMACEN\.xls/)).toBeNull();
    // The one still counting is not part of the archive and never filters.
    expect(screen.getByText(/Bodega 44 · corte 2026\/08\/28/)).toBeTruthy();
  });

  it('finds an old count by a date, and says when nothing matches', async () => {
    listWith(SESSIONS);
    const search = await screen.findByLabelText('Buscar conteos anteriores');
    await userEvent.type(search, '2025/03');
    const archive = screen.getByRole('region', { name: 'Conteos anteriores' });
    expect(within(archive).getByText(/corte 2025\/03\/31/)).toBeTruthy();
    expect(within(archive).queryByText(/corte 2025\/04\/30/)).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, 'diciembre');
    expect(
      within(archive).getByText(/Ningún conteo anterior coincide con «diciembre»/),
    ).toBeTruthy();
  });

  it('says the working list is empty without hiding the archive', async () => {
    listWith(SESSIONS.filter((session) => session.id !== 'viva'));
    await screen.findByText('No hay conteos en curso');
    expect(screen.getByRole('region', { name: 'Conteos anteriores' })).toBeTruthy();
  });

  it('offers no search over a single archived count', async () => {
    listWith([SESSIONS[0], SESSIONS[1]]);
    await screen.findByText(/corte 2025\/04\/30/);
    // One archived row is found by looking at it; a search box over it would
    // be furniture.
    expect(screen.queryByLabelText('Buscar conteos anteriores')).toBeNull();
  });
});

describe('the shared dispatch', () => {
  it('refuses to dispatch while nobody is on the roster, and says so', () => {
    localStorage.clear();
    render(
      <Reparto detail={detailFor()} api={fakeApi()} onDispatched={() => {}} onReload={() => {}} />,
    );

    const button = screen.getByRole('button', {
      name: /Despachar y generar enlaces/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/No hay contadores/)).toBeTruthy();
  });

  it('still shows the catalogue by family and exposure, as context', () => {
    localStorage.clear();
    render(
      <Reparto detail={detailFor()} api={fakeApi()} onDispatched={() => {}} onReload={() => {}} />,
    );
    // Fresh produce is 54 rows of which 31 are booked at zero. It stays
    // visible even though nothing is assigned here any more: the admin still
    // ranks what the file holds before handing it to five people.
    expect(screen.getAllByText(/PAPA CRIOLLA/).length).toBeGreaterThan(0);
    // And nothing on the screen offers to move or split anything.
    expect(screen.queryByText(/mover a…/)).toBeNull();
    expect(screen.queryByRole('button', { name: /repartir en/ })).toBeNull();
  });

  it('dispatches names and nothing else once somebody is on the roster', async () => {
    localStorage.clear();
    const post = vi.fn(async () => ({ estado: 'abierto' }) as never);
    render(
      <Reparto
        detail={detailFor()}
        api={fakeApi({ post })}
        onDispatched={() => {}}
        onReload={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Nombre de un contador nuevo'), 'Ana{enter}');
    await userEvent.type(screen.getByLabelText('Nombre de un contador nuevo'), 'Luis{enter}');
    expect(screen.getAllByText('todo el catálogo').length).toBe(2);

    const button = screen.getByRole('button', {
      name: /Despachar y generar enlaces/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await userEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as [string, { counters: { nombre: string }[] }];
    expect(path).toBe('/api/sessions/sesion-1/dispatch');
    expect(body).toEqual({ counters: [{ nombre: 'Ana' }, { nombre: 'Luis' }] });
    // No `secciones` key anywhere: its absence is what asks for the shared mode.
    expect(JSON.stringify(body)).not.toMatch(/secciones/);
  });

  it('closes again when the last person is removed', async () => {
    localStorage.clear();
    savePlan('sesion-1', { roster: ['Ana'] });
    render(
      <Reparto detail={detailFor()} api={fakeApi()} onDispatched={() => {}} onReload={() => {}} />,
    );
    expect(
      (screen.getByRole('button', { name: /Despachar y generar/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Quitar a Ana' }));

    expect(
      (screen.getByRole('button', { name: /Despachar y generar/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/No hay contadores/)).toBeTruthy();
  });
});

describe('the roster', () => {
  it('folds the counters of a sectioned draft back onto the list', () => {
    // A plan saved by the pre-P2.6 planner keeps its people: they are in the
    // sections, and a screen that opened claiming nobody counts would be lying.
    localStorage.clear();
    localStorage.setItem(
      'conteo.reparto.sesion-1',
      JSON.stringify({
        sections: [{ id: 's1', nombre: 'TODO', counterNombre: 'Marta' }],
        asignado: {},
        etiquetas: {},
      }),
    );
    render(
      <Reparto detail={detailFor()} api={fakeApi()} onDispatched={() => {}} onReload={() => {}} />,
    );
    expect(screen.getAllByText('Marta').length).toBeGreaterThan(0);
  });

  it('does not add the same name twice', async () => {
    localStorage.clear();
    savePlan('sesion-1', { roster: ['Ana'] });
    render(
      <Reparto detail={detailFor()} api={fakeApi()} onDispatched={() => {}} onReload={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Nombre de un contador nuevo'), 'Ana{enter}');
    expect(screen.getAllByText('Ana')).toHaveLength(1);
  });
});

describe('deleting a session', () => {
  it('asks in place, says what is destroyed, then deletes and leaves', async () => {
    localStorage.clear();
    const del = vi.fn(async () => ({ deleted: 'sesion-1' }) as never);
    const onDeleted = vi.fn();
    render(
      <Reparto
        detail={detailFor()}
        api={fakeApi({ del })}
        onDispatched={() => {}}
        onReload={() => {}}
        onDeleted={onDeleted}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar este borrador' }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText(/Se borra este borrador/)).toBeTruthy();

    // §3.5: the most destructive act in the panel is confirmed by typing, not
    // by a second click a tired thumb gives away for free.
    expect(
      (screen.getByRole('button', { name: 'Sí, eliminar' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.type(screen.getByLabelText('Escribe «eliminar» para confirmar'), 'eliminar');

    await userEvent.click(screen.getByRole('button', { name: 'Sí, eliminar' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith('/api/sessions/sesion-1');
  });

  it('can be declined, and nothing is sent', async () => {
    localStorage.clear();
    const del = vi.fn();
    render(
      <Reparto
        detail={detailFor()}
        api={fakeApi({ del })}
        onDispatched={() => {}}
        onReload={() => {}}
        onDeleted={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar este borrador' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conservar' }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByText(/Se borra este borrador/)).toBeNull();
  });

  it('is never offered for a sealed session', () => {
    render(
      <DeleteSession api={fakeApi()} sessionId="sesion-1" estado="sellado" onDeleted={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /Eliminar/ })).toBeNull();
  });
});

describe('the dispatch sheet', () => {
  const dispatched = detailFor({
    session: { ...detailFor().session, estado: 'abierto', dispatchedAt: '2026-08-31T13:00:00.000Z' },
    counters: [
      {
        id: 'c1',
        nombre: 'Ana',
        token: 'A'.repeat(22),
        estado: 'asignado',
        fetchedAt: '2026-08-31T13:20:00.000Z',
        fetchCount: 1,
      },
      {
        id: 'c2',
        nombre: 'Luis',
        token: 'B'.repeat(22),
        estado: 'asignado',
        fetchedAt: null,
        fetchCount: 0,
      },
    ],
    sections: [
      { id: 's1', nombre: 'ALMACEN', counterId: 'c1' },
      { id: 's2', nombre: 'NEVERA', counterId: 'c2' },
    ],
    assignments: catalogue.map((item, index) => ({
      idarticulo: item.idarticulo,
      counterId: index % 2 === 0 ? 'c1' : 'c2',
      sectionId: index % 2 === 0 ? 's1' : 's2',
    })),
  });

  it('marks the tablet nobody has loaded on its own card', () => {
    // The standing wifi paragraph is gone (§5.2); what remains is the state on
    // the card and, live, the blocker line in the ANTES DE SELLAR rail.
    render(<Dispatched detail={dispatched} api={fakeApi()} onReload={() => {}} />);
    const luis = screen.getByRole('heading', { name: 'Luis' }).closest('section')!;
    expect(within(luis).getByText('pendiente')).toBeTruthy();
  });

  it('shows each counter’s link, as text and as a QR code', () => {
    render(<Dispatched detail={dispatched} api={fakeApi()} onReload={() => {}} />);
    // By heading: from P2.3.5 the same screen also carries the reassignment
    // panel, where every counter's name appears in a list and in two selects.
    const ana = screen.getByRole('heading', { name: 'Ana' }).closest('section')!;
    expect(within(ana).getByText(/#\/c\/A{22}/)).toBeTruthy();
    expect(within(ana).getByRole('img', { name: 'Enlace de Ana' })).toBeTruthy();
    expect(within(ana).getByText(/descargado/)).toBeTruthy();

    const luis = screen.getByRole('heading', { name: 'Luis' }).closest('section')!;
    expect(within(luis).getByText('pendiente')).toBeTruthy();
  });

  it('keeps the setup work folded until somebody opens «Cambios» (§3.1)', async () => {
    // The monitoring screen is refreshed every ten minutes; a swap form
    // standing in its middle has to justify itself in paragraphs. Folded, it
    // appears attached to the act — and the QR sheet stays printable without
    // unfolding anything.
    const api = fakeApi({
      get: vi.fn(async (path: string) =>
        path.endsWith('/sync')
          ? ({
              session: { id: 'sesion-1', estado: 'abierto', assignmentsVersion: 1, readyToSeal: [] },
              counters: [],
              acciones: [],
              sello: null,
            } as never)
          : ({} as never),
      ),
    });
    render(<Dispatched detail={dispatched} api={api} onReload={() => {}} />);
    expect(screen.queryByText('Cambios durante el conteo')).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Enlaces y cambios ⌄' }));
    expect(await screen.findByText('Cambios durante el conteo')).toBeTruthy();
  });

  it('starts unfolded on a fresh dispatch, when the links are the task', () => {
    // The admin who just clicked «Despachar y generar enlaces» came here to
    // hand out the links. Until a tablet downloads something, folding them
    // away would hide the only thing left to do (the reported bug: «no me
    // muestra los enlaces al agregar los contadores»).
    const fresh = detailFor({
      ...dispatched,
      counters: dispatched.counters.map((counter) => ({
        ...counter,
        fetchedAt: null,
        fetchCount: 0,
      })),
    });
    // Unfolded, `Cambios` polls /sync on its own — it needs a real snapshot.
    const api = fakeApi({
      get: vi.fn(async (path: string) =>
        path.endsWith('/sync')
          ? ({
              session: { id: 'sesion-1', estado: 'abierto', assignmentsVersion: 1, readyToSeal: [] },
              counters: [],
              acciones: [],
              sello: null,
            } as never)
          : ({} as never),
      ),
    });
    render(<Dispatched detail={fresh} api={api} onReload={() => {}} />);
    // Unfolded: the sheet is on screen, not print-only.
    expect(document.querySelector('.sheet')!.className).toBe('sheet');
    expect(screen.getByRole('button', { name: 'Enlaces y cambios ▴' })).toBeTruthy();
    // And once one tablet has pulled (the original fixture), it starts folded.
    cleanup();
    render(<Dispatched detail={dispatched} api={fakeApi()} onReload={() => {}} />);
    expect(document.querySelector('.sheet')!.className).toBe('sheet sheet--printonly');
  });

  it('keeps «¿ya puedo sellar?» standing in the rail (§3.2)', async () => {
    // The rail replaced the setup receipt: one line per blocker with a way to
    // act, and a ✓ where a condition is already met.
    const api = fakeApi({
      get: vi.fn(async (path: string) => {
        if (path.endsWith('/sync')) {
          return {
            session: {
              id: 'sesion-1',
              estado: 'abierto',
              assignmentsVersion: 1,
              readyToSeal: [
                { kind: 'contador-sin-descargar', counterId: 'c2', nombre: 'Luis' },
              ],
            },
            counters: [],
            acciones: [],
            sello: null,
          } as never;
        }
        return { events: [], nextCursor: '0' } as never;
      }),
    });
    render(<Dispatched detail={dispatched} api={api} onReload={() => {}} />);
    const rail = (await screen.findByText('Antes de sellar')).closest('.panel') as HTMLElement;
    expect(
      within(rail).getByText('La tableta de Luis nunca descargó su lista.'),
    ).toBeTruthy();
    expect(within(rail).getAllByRole('button', { name: 'Ver →' }).length).toBeGreaterThan(0);
    // No download ✓ while one is missing; the catalogue line is the ⚠.
    expect(within(rail).queryByText('Tabletas al día')).toBeNull();
    expect(within(rail).getByText(/filas sin contar/)).toBeTruthy();
  });

  it('says «todo el catálogo» for a shared session instead of listing a partition', () => {
    const compartida = detailFor({
      session: {
        ...detailFor().session,
        estado: 'abierto',
        dispatchedAt: '2026-08-31T13:00:00.000Z',
      },
      counters: dispatched.counters,
      sections: [],
      assignments: [],
    });
    render(<Dispatched detail={compartida} api={fakeApi()} onReload={() => {}} />);
    const ana = screen.getByRole('heading', { name: 'Ana' }).closest('section')!;
    expect(within(ana).getByText(`todo el catálogo · ${catalogue.length} artículos`)).toBeTruthy();
  });
});
