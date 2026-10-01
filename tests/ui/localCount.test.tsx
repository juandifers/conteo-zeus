// @vitest-environment jsdom
/**
 * A file imported on the tablet, counted on the counter screens (2026-10).
 *
 * The single-device app used to have screens of its own — a card that opened
 * on the article's running figure and a «Faltantes» list — while a dispatched
 * counter had four tabs and independent registros. Now an import opens on the
 * four tabs, and the review and the `.txt` are where they always were.
 *
 * The practice under test is the one the change exists for: **every quantity
 * is a new, independent registro.** Fourteen on one shelf and six on another
 * are two entries, the keypad opens empty the second time, nothing on the
 * counting path adds them up, and the review — the reveal — is where 20 first
 * appears.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryChain, MemoryRepository } from '../../src/domain';
import { App } from '../../src/ui/App';
import type { LockManagerLike } from '../../src/ui/counter/counterLock';
import { tapGuard } from '../../src/ui/counter/tapGuard';
import type { Downloader } from '../../src/ui/download';
import { localOutbox } from '../../src/ui/outbox';
import { parseTxt } from '../../src/zeus';
import { SAMPLE_XLS } from '../helpers';
import { ID, memoryStorage, PERSISTED, sampleSession } from './harness';

beforeEach(() => {
  tapGuard.confirmMs = 0;
  tapGuard.openMs = 0;
});

afterEach(() => {
  cleanup();
  // «quién cuenta» is remembered in localStorage; one test's name is not the
  // next test's.
  globalThis.localStorage?.clear();
});

/**
 * The repository and the chain over one table, as `DexieCounterChain` is.
 * `batches` records each write's size; `failBatches` makes multi-event writes
 * fail, the way a full disk refuses the big one first.
 */
function sharedDevice() {
  const repo = new MemoryRepository();
  const chain = new MemoryChain();
  const batches: number[] = [];
  const state = { failBatches: false };
  const append = chain.appendChainedBatch.bind(chain);
  chain.appendChainedBatch = async (links) => {
    if (state.failBatches && links.length > 1) throw new Error('QuotaExceededError');
    batches.push(links.length);
    await append(links);
    for (const link of links) await repo.appendEvent(link.event);
  };
  return { repo, chain, batches, state };
}

function zeusFile(path: string, name: string): File {
  return new NodeFile([readFileSync(path)], name, {
    type: 'application/octet-stream',
  }) as unknown as File;
}

function recorder(): Downloader & { saved: { filename: string; bytes: Uint8Array }[] } {
  const saved: { filename: string; bytes: Uint8Array }[] = [];
  return { saved, save: (filename, bytes) => void saved.push({ filename, bytes }) };
}

function openApp(device: ReturnType<typeof sharedDevice>, locks?: LockManagerLike) {
  const download = recorder();
  const view = render(
    <App
      repo={device.repo}
      chain={device.chain}
      locks={locks}
      outbox={localOutbox(memoryStorage())}
      download={download}
      persistence={async () => PERSISTED}
    />,
  );
  return { view, download, user: userEvent.setup() };
}

/** The tablet, empty; somebody types their name and imports the bodega. */
async function importOnTablet(options: { usuario?: string; locks?: LockManagerLike } = {}) {
  const device = sharedDevice();
  const opened = openApp(device, options.locks);
  await screen.findByText('Trae un archivo de Zeus y empieza');
  if (options.usuario) await opened.user.type(screen.getByLabelText('quién cuenta'), options.usuario);
  const picker = opened.view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [zeusFile(SAMPLE_XLS, 'COMESTIBLES ALMACEN.xls')] } });
  return { device, ...opened };
}

/** PAN TAJADO / NATIPAN X 500 GRS, by its code: the whole bodega has four «TAJADO»s. */
const PAN = '0112006';

const tab = (name: string) => screen.getByRole('button', { name, exact: true });

async function registrar(user: ReturnType<typeof userEvent.setup>, query: string, qty: string) {
  await user.clear(screen.getByLabelText('buscar artículo'));
  await user.type(screen.getByLabelText('buscar artículo'), query);
  await user.click(await screen.findByRole('button', { name: new RegExp(query, 'i') }));
  await user.type(screen.getByLabelText(/cantidad contada/), qty);
  await user.click(screen.getByRole('button', { name: new RegExp(`^Registrar ${qty} `) }));
}

/** Every event this count has written to its chain, oldest first. */
async function chained(device: ReturnType<typeof sharedDevice>) {
  const [meta] = await device.repo.listSessions();
  const session = await device.repo.getSession(meta.id);
  return device.chain.unsynced(session!.id, session!.contadorLocal!.id, 1000);
}

describe('a file imported on the tablet', () => {
  it('opens on the counter screens, as one counter named after whoever is counting', async () => {
    const { device } = await importOnTablet({ usuario: 'ana' });

    for (const name of ['Contar', 'Mis registros', 'Notas', 'Terminar']) {
      expect(await screen.findByRole('button', { name, exact: true })).toBeTruthy();
    }
    expect(screen.getByText('ana')).toBeTruthy();
    // Not the older screens: no progress bar, no running figure, no «Faltantes».
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Faltantes/ })).toBeNull();

    const [meta] = await device.repo.listSessions();
    const session = await device.repo.getSession(meta.id);
    expect(session?.contadorLocal).toMatchObject({ nombre: 'ana' });
    expect(session?.contadorLocal?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records two piles of one article as two registros, and never shows the first', async () => {
    const { device, user } = await importOnTablet({ usuario: 'ana' });
    await screen.findByRole('button', { name: 'Contar' });

    await registrar(user, PAN, '14');

    // The second pile. The keypad opens empty — not on 14, not on anything —
    // because the 6 is counted, not reconciled against what is already there.
    await user.clear(screen.getByLabelText('buscar artículo'));
    await user.type(screen.getByLabelText('buscar artículo'), PAN);
    await user.click(await screen.findByRole('button', { name: /PAN TAJADO/ }));
    expect(screen.getByLabelText(/cantidad contada/)).toHaveValue('');
    expect(document.body.textContent).not.toMatch(/\b14\b/);
    await user.type(screen.getByLabelText(/cantidad contada/), '6');
    await user.click(screen.getByRole('button', { name: /^Registrar 6 / }));

    // Two entries, in the order they were made, each correctable on its own.
    await user.click(tab('Mis registros'));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('6');
    expect(rows[1]).toHaveTextContent('14');
    // And the sum is nowhere on the counting path.
    expect(document.body.textContent).not.toMatch(/\b20\b/);

    await waitFor(async () => expect(await chained(device)).toHaveLength(2));
    const events = (await chained(device)).map((link) => link.event);
    expect(events.map((event) => [event.kind, 'qty' in event ? event.qty : null])).toEqual([
      ['add', 14],
      ['add', 6],
    ]);
    // No zone on a single-device count, as before: there is one section.
    expect(events.every((event) => event.zona === '' && event.usuario === 'ana')).toBe(true);
  });

  it('reaches the review from «Terminar», where the 20 appears and the file carries it', async () => {
    const { device, download, user } = await importOnTablet({ usuario: 'ana' });
    await screen.findByRole('button', { name: 'Contar' });
    await registrar(user, PAN, '14');
    await registrar(user, PAN, '6');

    // «Terminar» is the dispatched counter's gap review, over the whole bodega.
    await user.click(tab('Terminar'));
    const seccion = screen.getByText('Tu sección: Toda la bodega · 298 artículos').parentElement!;
    const pendientes = within(seccion).getByText('sin registrar').parentElement!;
    expect(pendientes).toHaveTextContent('297');

    // The review is still the reveal, and still asks first.
    await user.click(screen.getByRole('button', { name: 'Revisar y generar archivo' }));
    expect(screen.getByText('Esta pantalla muestra lo que dice Zeus')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ver las cifras del sistema' }));

    // The reviewer signs the rest off. Into this counter's chain: it is the
    // only log a single-device count has.
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));
    await user.type(screen.getByLabelText('motivo'), 'bodega pequeña, sólo el pan');
    await user.type(screen.getByLabelText('quién autoriza'), 'marta');
    await user.click(screen.getByRole('button', { name: 'Firmar exención' }));

    // All 297 in one write: a chain cannot take them one by one, where a
    // failure at row 40 would let rows 41… land over the hole.
    await waitFor(() => expect(device.batches.slice(-1)).toEqual([297]));
    const generar = screen.getByRole('button', { name: 'Generar archivo', exact: true });
    await waitFor(() => expect(generar).toBeEnabled());
    await user.click(generar);
    const confirm = screen.getAllByRole('button', { name: 'Generar archivo', exact: true });
    await user.click(confirm[confirm.length - 1]);
    expect(await screen.findByText('Archivo generado')).toBeTruthy();

    expect(download.saved).toHaveLength(1);
    const written = parseTxt(download.saved[0].bytes);
    const pan = written.items.find((item) => item.idarticulo === ID.panTajado)!;
    expect(pan.toma).toBe(20);

    // The waivers are the reviewer's, not registros: back on the tablet,
    // «Mis registros» still lists the two entries and nothing else.
    await waitFor(async () => expect((await chained(device)).length).toBe(2 + 297));
    await user.click(screen.getByRole('button', { name: 'volver', exact: true }));
    await user.click(screen.getByRole('button', { name: 'volver', exact: true }));
    await user.click(tab('Mis registros'));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryAllByRole('button', { name: 'Deshacer' })).toHaveLength(2);

    // Nor are they the counter's gaps: somebody signed for them. The gap
    // review breaks them out under the reviewer's word for them — the same
    // shape a handover's inherited articles take on a dispatched tablet,
    // «298 resolved, 297 of them not by you».
    await user.click(tab('Terminar'));
    const trabajo = screen.getByText('Tu trabajo').parentElement!;
    expect(within(trabajo).getByText('artículos registrados').parentElement).toHaveTextContent(
      '298',
    );
    expect(within(trabajo).getByText('exentos en la revisión').parentElement).toHaveTextContent(
      '297',
    );
    expect(within(trabajo).getByText('sin registrar').parentElement).toHaveTextContent('0');
    // And the search does not mark a waived article «ya registraste algo aquí».
    await user.click(tab('Contar'));
    await user.type(screen.getByLabelText('buscar artículo'), 'MELON');
    await screen.findAllByRole('button', { name: /MELON/ });
    expect(screen.queryAllByLabelText('ya registraste algo aquí')).toHaveLength(0);
  }, 30_000);

  it('will not generate the file while the waivers are not on disk', async () => {
    const { device, user } = await importOnTablet({ usuario: 'ana' });
    await screen.findByRole('button', { name: 'Contar' });
    await registrar(user, PAN, '14');

    await user.click(tab('Terminar'));
    await user.click(screen.getByRole('button', { name: 'Revisar y generar archivo' }));
    await user.click(screen.getByRole('button', { name: 'Ver las cifras del sistema' }));
    device.state.failBatches = true;
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));
    await user.type(screen.getByLabelText('motivo'), 'cierre');
    await user.type(screen.getByLabelText('quién autoriza'), 'marta');
    await user.click(screen.getByRole('button', { name: 'Firmar exención' }));

    // On screen every row is resolved, and the file would have built: the
    // waivers exist only in this tab. So the review says so and refuses.
    expect(await screen.findByText(/No se está guardando nada/)).toBeTruthy();
    const generar = screen.getByRole('button', { name: 'Generar archivo', exact: true });
    expect(generar).toBeDisabled();
    expect(screen.getByText(/No se genera el archivo hasta que el guardado funcione/)).toBeTruthy();

    // And the retry is right there; once it lands, the file can be made.
    device.state.failBatches = false;
    await user.click(screen.getByRole('button', { name: /Reintentar guardado/ }));
    await waitFor(() => expect(generar).toBeEnabled());
    expect(await chained(device)).toHaveLength(1 + 297);
  }, 30_000);

  it('carries a note written at the shelf to the review', async () => {
    const { user } = await importOnTablet({ usuario: 'ana' });
    await screen.findByRole('button', { name: 'Contar' });

    await user.click(tab('Notas'));
    await user.type(screen.getByLabelText('texto de la nota'), '3 cajas sin código arriba');
    await user.click(screen.getByRole('button', { name: 'Guardar nota' }));

    await user.click(tab('Terminar'));
    await user.click(screen.getByRole('button', { name: 'Revisar y generar archivo' }));
    await user.click(screen.getByRole('button', { name: 'Ver las cifras del sistema' }));
    const notas = screen.getByRole('region', { name: 'notas' });
    expect(notas).toHaveTextContent('3 cajas sin código arriba');
    expect(notas).toHaveTextContent('sin artículo');
    expect(notas).toHaveTextContent(/el archivo para Zeus no la puede llevar/);
  });
});

describe('a reload mid-count', () => {
  it('reopens from the list with «Mis registros» intact, and continues the chain', async () => {
    const first = await importOnTablet({ usuario: 'ana' });
    await screen.findByRole('button', { name: 'Contar' });
    await registrar(first.user, PAN, '14');
    await waitFor(async () => expect(await chained(first.device)).toHaveLength(1));
    first.view.unmount();

    const second = openApp(first.device);
    await second.user.click(await screen.findByRole('button', { name: /Bodega/ }));
    await second.user.click(await screen.findByRole('button', { name: 'Mis registros', exact: true }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('14');

    await second.user.click(tab('Contar'));
    await registrar(second.user, PAN, '6');
    await waitFor(async () => expect(await chained(first.device)).toHaveLength(2));
    const links = await chained(first.device);
    // One chain, not two: seq 2 builds on seq 1's hash.
    expect(links.map((link) => link.event.seq)).toEqual([1, 2]);
    expect(links[1].prevHash).toBe(links[0].hash);
  });

  it('goes back to the list from the masthead', async () => {
    const { user } = await importOnTablet();
    await screen.findByRole('button', { name: 'Contar' });
    await user.click(screen.getByRole('button', { name: 'volver a las sesiones' }));
    expect(await screen.findByRole('button', { name: /Bodega/ })).toBeTruthy();
  });
});

describe('a log with events from somewhere else', () => {
  it('is refused rather than counted into', async () => {
    // A tab still running an older build, opening this session on the P1 path,
    // would write unchained events into it: they would fold into the file and
    // stay invisible to «Mis registros». Loud, before anything is appended.
    const first = await importOnTablet();
    await screen.findByRole('button', { name: 'Contar' });
    const [meta] = await first.device.repo.listSessions();
    await first.device.repo.appendEvent({
      id: 'p1-intruso',
      sessionId: meta.id,
      idarticulo: ID.panTajado,
      kind: 'set',
      qty: 3,
      usuario: 'otra pestaña',
      zona: '',
      at: '2026-10-01T10:00:00.000Z',
      deviceId: 'otro',
      seq: 1,
    });
    first.view.unmount();

    const second = openApp(first.device);
    await second.user.click(await screen.findByRole('button', { name: /Bodega/ }));
    expect(await screen.findByText('No se pudo abrir el conteo en esta tableta')).toBeTruthy();
    expect(screen.getByText(/no son del conteo de esta tableta/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Contar', exact: true })).toBeNull();
  });
});

describe('a session imported before the change', () => {
  it('keeps the screens it was started on', async () => {
    // Imported by an older build: no counter on it, a P1 log. It must finish
    // the way it started — mixing the two in one log is the one thing the
    // design does not allow (docs/MIGRATION-P1-P2.md).
    const device = sharedDevice();
    await device.repo.createSession(sampleSession());
    const { user } = openApp(device);
    await user.click(await screen.findByRole('button', { name: /Bodega/ }));

    expect(await screen.findByRole('progressbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mis registros', exact: true })).toBeNull();
  });
});

describe('one count, one writer', () => {
  it('tells a second tab the count is open elsewhere, and lets it retry', async () => {
    // Somebody else holds every lock: the installed app, say, with this count open.
    const taken: LockManagerLike = { request: async (_name, _options, callback) => callback(null) };
    await importOnTablet({ locks: taken });
    expect(await screen.findByText('Este conteo ya está abierto en esta tableta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Contar', exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });
});
