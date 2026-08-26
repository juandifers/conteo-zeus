// @vitest-environment jsdom
/**
 * Review and posting — the screen that produces a file the ERP will believe.
 *
 * Everything before this was recoverable inside the app. These tests are about
 * the guards on the one action that is not: that an incomplete count cannot
 * reach `exportAdjustment` through any path on the screen, that the bulk
 * waiver is the only way past it and carries a name and a reason, and that the
 * bytes the browser is handed are the bytes the adapter produced.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { exportAdjustment } from '../../src/app';
import { MemoryRepository, summarizeSession, type Session } from '../../src/domain';
import { parseXls } from '../../src/zeus';
import { ReviewScreen } from '../../src/ui/screens/ReviewScreen';
import { formatMoney } from '../../src/ui/format';
import { CountStore } from '../../src/ui/store';
import type { Downloader } from '../../src/ui/download';
import { SAMPLE_XLS, firstDifference, readSample } from '../helpers';
import {
  ID,
  SESSION_ID,
  fakeIdentity,
  mismatchedSession,
  sampleSession,
} from './harness';

afterEach(() => {
  cleanup();
  // `quién revisa` is remembered between visits; between *tests* it would be a
  // supervisor's name leaking into a screen that never typed one.
  localStorage.clear();
});

interface Saved {
  filename: string;
  bytes: Uint8Array;
}

/** A `Downloader` that keeps what it was handed. The point of the port. */
function recorder(): Downloader & { saved: Saved[] } {
  const saved: Saved[] = [];
  return {
    saved,
    save(filename, bytes) {
      saved.push({ filename, bytes });
    },
  };
}

interface Options {
  session?: Session;
  /** Items to count at a given quantity. Everything else is waived. */
  counted?: Map<number, number>;
  /** Items to leave untouched — the ones that block a post. */
  untouched?: number[];
}

async function draw(options: Options = {}) {
  const session = options.session ?? sampleSession();
  const repo = new MemoryRepository();
  await repo.createSession(session);
  const store = await CountStore.open(repo, SESSION_ID, fakeIdentity());

  const skip = new Set(options.untouched ?? []);
  const counted = options.counted ?? new Map<number, number>();
  for (const item of session.items) {
    if (skip.has(item.idarticulo)) continue;
    const qty = counted.get(item.idarticulo);
    if (qty === undefined) store.markUnchanged(item.idarticulo);
    else store.setCount(item.idarticulo, qty);
  }
  await store.settled();

  const download = recorder();
  const user = userEvent.setup();
  render(<ReviewScreen store={store} repo={repo} download={download} onBack={() => {}} />);
  // The export history is read in an effect; nothing on screen is final until
  // it has landed, because it decides whether this file is a repeat.
  await screen.findByRole('button', { name: 'Generar archivo' });
  return { session, repo, store, download, user };
}

const generar = () => screen.getByRole('button', { name: 'Generar archivo' });
const summaryOf = (store: CountStore) => {
  const { session, events } = store.getSnapshot();
  return summarizeSession(session, events);
};

/** A count with a write-off, an overage, and a zero-book row counted at zero. */
function mixedCounts(session: Session): Map<number, number> {
  const at = (id: number) => session.items.find((item) => item.idarticulo === id)!;
  return new Map([
    [ID.pancetaKilo, 0], // 97,5 on the books, counted empty — a write-off
    [ID.tilapia600, at(ID.tilapia600).existencia + 10], // an overage
    [ID.name, Math.max(0, at(ID.name).existencia - 3)], // a shortage
    [ID.melon, 0], // booked at zero, counted at zero — not a write-off
  ]);
}

describe('canPost is a precondition, not a warning (§2)', () => {
  it('refuses to generate while any item is untouched, and says how many', async () => {
    const { download, user } = await draw({ untouched: [ID.melon, ID.panTajado] });

    expect(generar()).toBeDisabled();
    expect(screen.getByText('Faltan 2 artículos por contar o exentar.')).toBeTruthy();

    await user.click(generar());

    expect(screen.queryByRole('region', { name: 'generar el archivo para Zeus' })).toBeNull();
    expect(download.saved).toEqual([]);
  });

  it('enables it the moment nothing is untouched', async () => {
    await draw();
    expect(generar()).toBeEnabled();
    expect(screen.queryByText(/Faltan/)).toBeNull();
  });

  it('says plainly when the session never kept the file it was imported from', async () => {
    // Sessions imported before the file travelled with them. Nothing is wrong
    // with the count; there is simply no snapshot to write the adjustment over.
    const { source: _source, ...sourceless } = sampleSession();
    const { download, user } = await draw({ session: sourceless });

    expect(generar()).toBeDisabled();
    expect(screen.getByText(/no guardó el archivo de Zeus/)).toBeTruthy();

    await user.click(generar());
    expect(download.saved).toEqual([]);
  });

  it('will not post a count taken against a different snapshot', async () => {
    // Same session, a different export of the same bodega as its source: it
    // parses cleanly and hashes to something else, which is exactly the shape
    // of "the balances under this count moved" (DOMAIN.md §6).
    const { download, user } = await draw({ session: mismatchedSession() });

    expect(generar()).toBeDisabled();
    expect(screen.getByText(/ya no coincide con el conteo/)).toBeTruthy();

    await user.click(generar());
    expect(download.saved).toEqual([]);
  });
});

describe('the bulk waiver — the only route past an incomplete count (§4)', () => {
  it('will not sign without a motivo', async () => {
    const { user } = await draw({ untouched: [ID.melon, ID.panTajado] });
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));

    const sign = screen.getByRole('button', { name: 'Firmar exención' });
    expect(sign).toBeDisabled();
    expect(
      screen.getByText('Escribe el motivo: una exención sin motivo no se puede firmar.'),
    ).toBeTruthy();

    await user.type(screen.getByLabelText('quién autoriza'), 'marta');
    expect(sign).toBeDisabled();
  });

  it('names what is being waived, and what it is worth, before it is signed', async () => {
    // A supervisor waiving 1,4M of melón should read the word melón (§5).
    const { store, user } = await draw({ untouched: [ID.melon, ID.panTajado] });
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));

    const summary = summaryOf(store);
    const panel = screen.getByRole('region', { name: 'exentar artículos sin contar' });
    expect(within(panel).getByText('MELON')).toBeTruthy();
    // The figure reads twice on purpose: once as the headline and once inside
    // the sentence being signed, which has to stand on its own.
    expect(
      within(panel).getAllByText(formatMoney(summary.pendiente.exposicion)),
    ).toHaveLength(2);
    const sentence = within(panel).getByText(/Vas a firmar/);
    expect(sentence).toHaveTextContent('MELON');
    expect(sentence).toHaveTextContent(formatMoney(summary.pendiente.exposicion));
  });

  it('appends one unchanged event per row, signed and reasoned, and unblocks the post', async () => {
    const { store, user } = await draw({ untouched: [ID.melon, ID.panTajado] });
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));

    await user.type(screen.getByLabelText('motivo'), 'cava cerrada por mantenimiento');
    await user.type(screen.getByLabelText('quién autoriza'), 'marta');
    await user.click(screen.getByRole('button', { name: 'Firmar exención' }));

    for (const id of [ID.melon, ID.panTajado]) {
      const events = store.eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'unchanged',
        usuario: 'marta',
        motivo: 'cava cerrada por mantenimiento',
      });
    }
    expect(summaryOf(store).canPost).toBe(true);
    expect(generar()).toBeEnabled();
  });

  it('waives only what is still ticked', async () => {
    const { store, user } = await draw({ untouched: [ID.melon, ID.panTajado] });
    await user.click(screen.getByRole('button', { name: 'Exentar artículos sin contar' }));

    const checks = screen.getAllByRole('checkbox');
    expect(checks).toHaveLength(2);
    await user.click(checks[1]);
    await user.type(screen.getByLabelText('motivo'), 'sólo uno');
    await user.type(screen.getByLabelText('quién autoriza'), 'marta');
    await user.click(screen.getByRole('button', { name: 'Firmar exención' }));

    const waived = [ID.melon, ID.panTajado].filter((id) => store.eventsFor(id).length > 0);
    expect(waived).toHaveLength(1);
    // And the count is still blocked, which is the honest outcome.
    expect(summaryOf(store).canPost).toBe(false);
  });
});

describe('the table is the screen', () => {
  it('ranks by materiality, matching byMateriality row for row', async () => {
    const session = sampleSession();
    const { store } = await draw({ session, counted: mixedCounts(session) });

    const table = screen.getAllByRole('table')[0];
    const impacts = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('.grid__impacto')!.textContent);
    const expected = summaryOf(store)
      .byMateriality.slice(0, impacts.length)
      .map((row) => formatMoney(row.variance!.valorVariance));

    expect(impacts).toEqual(expected);
    expect(within(table).getAllByRole('rowheader')[0]).toHaveTextContent(
      summaryOf(store).byMateriality[0].item.nombre,
    );
  });

  it('filters to shortages, overages and matches', async () => {
    const session = sampleSession();
    const { store, user } = await draw({ session, counted: mixedCounts(session) });
    const summary = summaryOf(store);
    const overages = summary.byMateriality.filter(
      (row) => row.variance!.varianceClass === 'overage',
    );

    await user.click(screen.getByRole('button', { name: `en más ${overages.length}` }));

    const table = screen.getAllByRole('table')[0];
    expect(within(table).getAllByRole('rowheader')).toHaveLength(overages.length);
    expect(within(table).getAllByRole('rowheader')[0]).toHaveTextContent(
      overages[0].item.nombre,
    );
  });

  it('sorts on a column when its header is pressed', async () => {
    const session = sampleSession();
    const { user } = await draw({ session, counted: mixedCounts(session) });

    // Scoped: the write-offs table below carries the same headers, and each
    // table sorts itself.
    const table = screen.getAllByRole('table')[0];
    await user.click(within(table).getByRole('button', { name: 'artículo' }));
    const names = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.querySelector('.grid__nombre')!.textContent!);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'es')));
  });
});

describe('write-offs are called out on their own (§2)', () => {
  it('lists exactly the rows counted at zero against a non-zero book figure', async () => {
    const session = sampleSession();
    const { store } = await draw({ session, counted: mixedCounts(session) });

    const summary = summaryOf(store);
    expect(summary.writeOffs.map((row) => row.item.idarticulo)).toEqual([ID.pancetaKilo]);

    const section = screen.getByRole('region', { name: 'bajas totales' });
    const rows = within(section).getAllByRole('rowheader');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('PANCETA SV');
    // MELON was counted at zero too, and is not a loss: the ERP already had it
    // at zero. It must not be in this list.
    expect(within(section).queryByText('MELON')).toBeNull();
  });

  it('puts every one of them in the confirmation with its peso impact', async () => {
    const session = sampleSession();
    const { store, user } = await draw({ session, counted: mixedCounts(session) });
    await user.click(generar());

    const panel = screen.getByRole('region', { name: 'generar el archivo para Zeus' });
    for (const row of summaryOf(store).writeOffs) {
      expect(within(panel).getByText(row.item.nombre)).toBeTruthy();
      expect(
        within(panel).getByText(formatMoney(row.variance!.valorVariance)),
      ).toBeTruthy();
    }
  });

  it('states the counts and both variance figures, not a summary of them', async () => {
    const session = sampleSession();
    const { store, user } = await draw({ session, counted: mixedCounts(session) });
    await user.click(generar());

    const summary = summaryOf(store);
    const panel = screen.getByRole('region', { name: 'generar el archivo para Zeus' });
    expect(within(panel).getByText(formatMoney(summary.netVarianceValue))).toBeTruthy();
    expect(within(panel).getByText(formatMoney(summary.grossVarianceValue))).toBeTruthy();
    expect(within(panel).getByText('diferencia neta')).toBeTruthy();
    expect(within(panel).getByText('diferencia bruta')).toBeTruthy();
  });
});

describe('the file', () => {
  const SOURCE = parseXls(readSample(SAMPLE_XLS));

  async function generate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(generar());
    await user.click(
      within(screen.getByRole('region', { name: 'generar el archivo para Zeus' })).getByRole(
        'button',
        { name: 'Generar archivo' },
      ),
    );
  }

  it('hands the browser exactly the bytes exportAdjustment produced', async () => {
    const session = sampleSession();
    const { store, download, user } = await draw({ session, counted: mixedCounts(session) });

    await generate(user);

    expect(download.saved).toHaveLength(1);
    const expected = exportAdjustment(session, store.getSnapshot().events, { file: SOURCE });
    expect(firstDifference(download.saved[0].bytes, expected)).toBeNull();
  });

  it('is offered under the imported name, the corte, and a sequence number', async () => {
    const { user, download } = await draw();
    await user.click(generar());
    expect(screen.getByLabelText('nombre del archivo')).toHaveValue(
      'COMESTIBLES ALMACEN - conteo 2025-04-30 #1.txt',
    );
    await user.click(
      within(screen.getByRole('region', { name: 'generar el archivo para Zeus' })).getByRole(
        'button',
        { name: 'Generar archivo' },
      ),
    );
    expect(download.saved[0].filename).toBe('COMESTIBLES ALMACEN - conteo 2025-04-30 #1.txt');
  });

  it('cannot offer two files of one session the same default name', async () => {
    // The collision this prevents is silent: the browser resolves it by
    // appending `(1)`, leaving two adjustments for one bodega in one folder,
    // distinguishable only by which one you happened to download second.
    const session = sampleSession();
    const { store, download, user } = await draw({ session, counted: mixedCounts(session) });

    await generate(user);
    await user.click(screen.getByRole('button', { name: 'Listo' }));

    const target = session.items.find((item) => item.idarticulo === ID.ajiChipotle)!;
    store.setCount(target.idarticulo, target.existencia + 5);
    await store.settled();
    await generate(user);

    expect(download.saved.map((file) => file.filename)).toEqual([
      'COMESTIBLES ALMACEN - conteo 2025-04-30 #1.txt',
      'COMESTIBLES ALMACEN - conteo 2025-04-30 #2.txt',
    ]);
  });

  it('keeps a typed name for the file being generated, and only that one', async () => {
    const session = sampleSession();
    const { store, download, user } = await draw({ session, counted: mixedCounts(session) });

    await user.click(generar());
    const field = screen.getByLabelText('nombre del archivo');
    await user.clear(field);
    await user.type(field, 'ajuste abril.txt');
    await user.click(
      within(screen.getByRole('region', { name: 'generar el archivo para Zeus' })).getByRole(
        'button',
        { name: 'Generar archivo' },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Listo' }));

    const target = session.items.find((item) => item.idarticulo === ID.ajiChipotle)!;
    store.setCount(target.idarticulo, target.existencia + 5);
    await store.settled();
    await user.click(generar());

    // The next file falls back to the sequenced default rather than inheriting
    // a name that no longer says which file it is.
    expect(screen.getByLabelText('nombre del archivo')).toHaveValue(
      'COMESTIBLES ALMACEN - conteo 2025-04-30 #2.txt',
    );
    expect(download.saved[0].filename).toBe('ajuste abril.txt');
  });

  it('records who generated it, when, and the digest of the bytes', async () => {
    const session = sampleSession();
    const { repo, store, download, user } = await draw({
      session,
      counted: mixedCounts(session),
    });
    await user.type(screen.getByLabelText('quién revisa'), 'marta');

    await generate(user);

    const [record] = await repo.exportsForSession(SESSION_ID);
    const summary = summaryOf(store);
    expect(record).toMatchObject({
      usuario: 'marta',
      filename: 'COMESTIBLES ALMACEN - conteo 2025-04-30 #1.txt',
      byteLength: download.saved[0].bytes.length,
      counts: summary.counts,
      coberturaValor: summary.cobertura.fraccionValor,
      coberturaFilas: summary.cobertura.fraccionFilas,
      netVarianceValue: summary.netVarianceValue,
      grossVarianceValue: summary.grossVarianceValue,
      eventCount: store.getSnapshot().events.length,
    });
    // The two coverages are recorded separately because they come apart: four
    // counted rows out of 298 are 1% of the rows and rather more of the money.
    expect(record.coberturaValor).not.toBe(record.coberturaFilas);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('says so rather than silently producing an identical file', async () => {
    const session = sampleSession();
    const { repo, download, user } = await draw({ session, counted: mixedCounts(session) });

    await generate(user);
    await user.click(screen.getByRole('button', { name: 'Listo' }));
    await generate(user);

    expect(screen.getByText('Este archivo ya lo generaste')).toBeTruthy();
    expect(download.saved).toHaveLength(1);
    expect((await repo.exportsForSession(SESSION_ID))).toHaveLength(1);

    // And it still lets them have it — the first download may have gone into a
    // folder nobody can find.
    await user.click(screen.getByRole('button', { name: 'Descargar otra vez' }));
    expect(download.saved).toHaveLength(2);
    expect(firstDifference(download.saved[1].bytes, download.saved[0].bytes)).toBeNull();
    const records = await repo.exportsForSession(SESSION_ID);
    expect(records).toHaveLength(2);
    expect(records[0].sha256).toBe(records[1].sha256);
  });

  it('says what changed when something did', async () => {
    const session = sampleSession();
    const { store, download, user } = await draw({ session, counted: mixedCounts(session) });

    await generate(user);
    await user.click(screen.getByRole('button', { name: 'Listo' }));

    // A recount between the two files: one row moves from waived to counted.
    const target = session.items.find((item) => item.idarticulo === ID.ajiChipotle)!;
    await user.click(screen.getByRole('button', { name: 'Generar archivo' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    store.setCount(target.idarticulo, target.existencia + 5);
    await store.settled();

    await user.click(generar());
    const panel = screen.getByRole('region', { name: 'generar el archivo para Zeus' });
    expect(panel).toHaveTextContent('Sería el archivo n.º 2 de esta sesión');
    expect(panel).toHaveTextContent('1 registros nuevos en el conteo');
    expect(panel).toHaveTextContent('exentos');

    await user.click(within(panel).getByRole('button', { name: 'Generar archivo' }));
    expect(download.saved).toHaveLength(2);
    expect(firstDifference(download.saved[1].bytes, download.saved[0].bytes)).not.toBeNull();
  });

  it('leads with sinVerificar and states the coverage', async () => {
    // A session waived end to end: `pendiente` is zero and `sinVerificar` is
    // the whole bodega, which is the reading the confirmation must give.
    const { store, user } = await draw();
    await user.click(generar());

    const summary = summaryOf(store);
    expect(summary.pendiente.exposicion).toBe(0);
    expect(summary.cobertura.fraccionValor).toBe(0);

    const panel = screen.getByRole('region', { name: 'generar el archivo para Zeus' });
    expect(within(panel).getByText('sin verificar')).toBeTruthy();
    expect(
      within(panel).getByText(formatMoney(summary.sinVerificar.exposicion)),
    ).toBeTruthy();
    expect(within(panel).getByText('cobertura')).toBeTruthy();
    expect(within(panel).getAllByText('0%').length).toBeGreaterThan(0);
  });

  it('never says the app posted anything to Zeus', async () => {
    const { user } = await draw();
    await user.click(generar());
    const panel = screen.getByRole('region', { name: 'generar el archivo para Zeus' });
    expect(panel).toHaveTextContent('Subirlo a Zeus lo hace una persona, igual que hoy.');
    await user.click(within(panel).getByRole('button', { name: 'Generar archivo' }));
    expect(screen.getByText('Archivo generado')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'archivo generado' })).toHaveTextContent(
      'Esta aplicación no sube nada.',
    );
  });
});
