// @vitest-environment jsdom
/**
 * Sellar, generar, y el acta — P2.5 §1, §2, §3, §5.
 *
 * What is worth a test on this screen is not that a button posts. It is the
 * three things the task exists for:
 *
 * **The ordering.** The file is generated *after* the seal, and nothing on the
 * screen offers the other order. A `Generar` button on an open session would be
 * a file that corresponds to no recorded state.
 *
 * **Two grades of evidence, rendered apart.** `terminado_confirmado` is a chain
 * checked against a manifest; `retirado` is contiguity, which cannot see a
 * missing tail. ZEUS_FORMAT.md §7.1 established that presenting proven and
 * unverifiable under one mark invites confidence nobody earned, and the acta is
 * where that discipline costs the most to break.
 *
 * **§8 in full.** The `.txt` will assert something false about thousands of
 * rows. The acta is the only document that says so.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cierre } from '../../src/ui/admin/Cierre';
import type { Downloader } from '../../src/ui/download';
import type { SessionActionRecord } from '../../src/domain';
import { addCount, note, resetFactory } from '../domain/factory';
import { detailFor, item, reviewApi, selloFor, SESSION_ID } from './reviewHarness';

afterEach(cleanup);
beforeEach(() => {
  resetFactory();
  // jsdom has no print dialogue, and «Imprimir el acta» is rendered on every
  // sealed session.
  vi.stubGlobal('print', () => {});
});

const ITEMS = [
  item(1, 10, 100),
  item(2, 20, 50),
  item(3, 5, 1000),
  item(4, 8, 250),
];

const COUNTERS = [
  { id: 'ana', nombre: 'Ana', estado: 'terminado_confirmado', storedMaxSeq: 3 },
  { id: 'luis', nombre: 'Luis', estado: 'retirado', storedMaxSeq: 1 },
];

const DETAIL = detailFor({
  items: ITEMS,
  counters: COUNTERS,
  secciones: { ana: [1, 2], luis: [3, 4] },
});

const EVENTS = [
  addCount(1, 12, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 }),
  // An explicit zero on a row the ERP believes holds 20 — a stock deletion.
  addCount(2, 0, { counterId: 'ana', sessionId: SESSION_ID, seq: 2 }),
  note(null, 'sobra una estiba sin marcar', { counterId: 'ana', sessionId: SESSION_ID, seq: 3 }),
];

/** A retirement and a `sellar_sin_registros`, on the chain the acta prints. */
const ACCIONES: SessionActionRecord[] = [
  {
    id: 'accion-1',
    sessionId: SESSION_ID,
    seq: 1,
    kind: 'retirar_contador',
    payload: { counterId: 'luis', nombre: 'Luis', motivo: 'se fue enfermo' },
    usuario: 'Marta',
    at: '2026-08-25T14:00:00.000Z',
    serverAt: '2026-08-25T14:00:00.000Z',
    prevHash: 'p',
    hash: 'h1',
  },
  {
    id: 'accion-2',
    sessionId: SESSION_ID,
    seq: 2,
    kind: 'sellar_sin_registros',
    payload: {
      counterId: 'luis',
      nombre: 'Luis',
      motivo: 'la tableta se quedó en el bus',
      faltan: '4-7',
      storedMaxSeq: 9,
    },
    usuario: 'Marta',
    at: '2026-08-25T16:00:00.000Z',
    serverAt: '2026-08-25T16:00:00.000Z',
    prevHash: 'h1',
    hash: 'h2',
  },
  {
    id: 'accion-3',
    sessionId: SESSION_ID,
    seq: 3,
    kind: 'waiver',
    payload: { idarticulo: [3, 4], motivo: 'no alcanzó el turno' },
    usuario: 'Marta',
    at: '2026-08-25T16:30:00.000Z',
    serverAt: '2026-08-25T16:30:00.000Z',
    prevHash: 'h2',
    hash: 'h3',
  },
];

function catcher(): Downloader & { saved: { filename: string; bytes: Uint8Array }[] } {
  const saved: { filename: string; bytes: Uint8Array }[] = [];
  return {
    saved,
    save(filename, bytes) {
      saved.push({ filename, bytes });
    },
  };
}

const NOW = '2026-08-25T18:00:00.000Z';

function sealed(over: Parameters<typeof reviewApi>[0] = { counters: COUNTERS, events: EVENTS }) {
  return reviewApi({
    counters: COUNTERS,
    events: EVENTS,
    acciones: [...ACCIONES],
    estado: 'cerrado',
    sello: selloFor({
      exportedAt: '2026-08-25T17:30:00.000Z',
      fileHash: 'f'.repeat(64),
    }),
    ...over,
  });
}

describe('the ordering is the design (§1)', () => {
  it('offers the seal on an open session and no way to generate a file', async () => {
    const { api } = reviewApi({ counters: COUNTERS, events: EVENTS, acciones: [...ACCIONES] });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Sellar el conteo');

    expect(screen.getByRole('button', { name: 'Sellar' })).toBeTruthy();
    // Nothing offers the other order. A file generated while a tablet can still
    // drain corresponds to no recorded state.
    expect(screen.queryByText(/Generar el archivo/)).toBeNull();
    expect(screen.queryByText(/Descargar el .txt/)).toBeNull();
  });

  it('refuses to seal while something blocks, and says what', async () => {
    const { api } = reviewApi({
      counters: COUNTERS,
      events: EVENTS,
      readyToSeal: [{ kind: 'contador-bifurcado', counterId: 'ana', nombre: 'Ana' }],
    });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Sellar el conteo');

    expect(screen.getByText(/Dos tabletas escribieron con el enlace de Ana/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sellar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // §4.3: the disabled state says what it is waiting for.
    expect(screen.getByText('Desactivado hasta resolver 1 bloqueo.')).toBeTruthy();
  });

  it('names what is about to be frozen before it freezes it', async () => {
    const { api, posted } = reviewApi({
      counters: COUNTERS,
      events: EVENTS,
      acciones: [...ACCIONES],
    });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Sellar el conteo');

    fireEvent.click(screen.getByRole('button', { name: 'Sellar' }));
    // The consequence in the file, in front of the person, before the act — the
    // same discipline as the bulk-waiver confirmation.
    expect(screen.getByText(/Sin verificar:/)).toBeTruthy();
    expect(
      screen.getByText(/se van a escribir con la cantidad de Zeus, como si se hubieran contado/),
    ).toBeTruthy();
    expect(screen.getByText(/Después del sello no se puede añadir nada/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sí, sellar' }));
    await waitFor(() => expect(posted.some((call) => call.path.endsWith('/sellar'))).toBe(true));
  });

  it('offers `sellar_sin_registros` only for a retired counter, and says what it costs', async () => {
    const { api, posted } = reviewApi({
      counters: COUNTERS,
      events: EVENTS,
      acciones: [...ACCIONES],
    });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Sellar el conteo');

    const select = screen.getByLabelText('Contador cuyo tramo falta') as HTMLSelectElement;
    // Only Luis. Ana is still counting as far as anybody knows, and the answer
    // for somebody who might come back is to wait for the tablet.
    expect([...select.options].map((option) => option.textContent)).toEqual(['ninguno', 'Luis']);

    fireEvent.change(select, { target: { value: 'luis' } });
    expect(screen.getByText(/no está en el archivo y no va a llegar/)).toBeTruthy();

    // §4.3: the signature lives inside the confirmation, in front of the
    // person about to do the irreversible thing — not as standing page fields.
    fireEvent.click(screen.getByRole('button', { name: 'Sellar' }));
    const commit = screen.getByRole('button', { name: 'Sí, sellar' }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Quién firma'), { target: { value: 'Marta' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'no vuelve' } });
    fireEvent.click(commit);

    await waitFor(() => expect(posted.some((call) => call.path.endsWith('/sellar'))).toBe(true));
    const call = posted.find((entry) => entry.path.endsWith('/sellar'))!;
    expect(call.body).toEqual({
      sinRegistros: { counterId: 'luis', usuario: 'Marta', motivo: 'no vuelve' },
    });
  });
});

describe('after the seal (§2, §4a, §5)', () => {
  it('serves the stored bytes rather than rebuilding them', async () => {
    const download = catcher();
    const { api } = sealed();
    render(
      <Cierre
        detail={DETAIL}
        api={api}
        onReload={() => {}}
        download={download}
        now={() => NOW}
      />,
    );
    await screen.findByText(/Conteo cerrado/);

    // §4.4: the download is irreversible in effect — once uploaded, the file
    // moves balances — so it asks first, and the same-bytes fact lives there.
    fireEvent.click(screen.getByRole('button', { name: 'Descargar archivo para Zeus' }));
    expect(download.saved).toHaveLength(0);
    expect(screen.getByText(/Volver a descargar entrega/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sí, descargar' }));
    await waitFor(() => expect(download.saved).toHaveLength(1));
    // The name the server chose, carrying the digest's first eight — which is
    // what makes «which one did I upload» answerable.
    expect(download.saved[0].filename).toBe('AJUSTE_01_2025-04-30_abcd1234.txt');
    // Bytes, decoded from what the server sent. Never a string: the file is
    // CP850 and a string would put every `Ñ` through UTF-8 on the way to disk.
    expect(download.saved[0].bytes).toBeInstanceOf(Uint8Array);
    expect([...download.saved[0].bytes]).toEqual([0x68, 0x6f, 0x6c, 0x61]);
  });

  it('saves the audit bundle verbatim', async () => {
    const download = catcher();
    const { api } = sealed();
    render(
      <Cierre detail={DETAIL} api={api} onReload={() => {}} download={download} now={() => NOW} />,
    );
    await screen.findByText(/Conteo cerrado/);

    fireEvent.click(screen.getByRole('button', { name: 'Descargar el paquete de auditoría' }));
    await waitFor(() => expect(download.saved).toHaveLength(1));
    expect(download.saved[0].filename).toBe(`sesion_${SESSION_ID}.json`);
    // Verbatim, not re-serialised: `canonicalJson` sorted the keys and refused
    // the floats, and a `JSON.stringify` on the way out would undo both.
    expect(new TextDecoder().decode(download.saved[0].bytes)).toBe(
      '{"formato":"conteo-zeus/bundle/v1"}',
    );
  });

  it('does not blame the counter whose tablet turns up afterwards', async () => {
    const { api } = sealed();
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Si aparece una tableta ahora');
    expect(screen.getByText(/no es culpa de quien contó/)).toBeTruthy();
    expect(screen.getByText(/los registros siguen en la tableta/)).toBeTruthy();
  });

  it('shows late arrivals apart from the sealed set, when there are any', async () => {
    const { api } = sealed({
      counters: COUNTERS,
      events: EVENTS,
      acciones: [...ACCIONES],
      estado: 'cerrado',
      sello: selloFor({
        exportedAt: '2026-08-25T17:30:00.000Z',
        fileHash: 'f'.repeat(64),
        tardios: [
          { id: 'tarde-1', counterId: 'ana', seq: 4, serverAt: '2026-08-25T17:10:00.000Z' },
        ],
      }),
    });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Registros que llegaron después del sello');
    // They are real work and they are not part of what was certified. Both
    // halves have to be on the screen.
    expect(screen.getByText(/No están dentro de sessionHash y no están en el archivo/)).toBeTruthy();
    expect(screen.getByText(/Ana · seq 4/)).toBeTruthy();
  });
});

describe('el acta (§3)', () => {
  async function acta() {
    const { api } = sealed();
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Acta de conteo físico');
    return within(document.getElementById('acta')!);
  }

  it('renders the two grades of evidence distinctly (§6a)', async () => {
    const page = await acta();

    const proven = page.getByText(/Manifiesto verificado/).closest('.acta__evidence')!;
    const partial = page.getByText(/Contigüidad verificada/).closest('.acta__evidence')!;
    // Not two checkmarks. Different classes, and different sentences saying
    // what each one actually establishes.
    expect(proven.className).toBe('acta__evidence acta__evidence--proven');
    expect(partial.className).toBe('acta__evidence acta__evidence--partial');
    expect(partial.textContent).toMatch(/un tramo final que nadie ha oído nombrar/);
    // The typed reason travels with the weaker claim.
    expect(partial.textContent).toMatch(/se fue enfermo/);
  });

  it('never collapses `sellar_sin_registros`', async () => {
    const page = await acta();
    const line = page.getByText(/Sellado sin registros/).closest('li')!;
    // A line that names a person and a range of their work that is not in the
    // file. A bulk waiver may collapse; this may not.
    expect(line.querySelector('details')).toBeNull();
    expect(line.className).toContain('acta__decision--grave');
    expect(line.textContent).toMatch(/Luis, faltan 4-7/);
    expect(line.textContent).toMatch(/la tableta se quedó en el bus/);
  });

  it('collapses a bulk waiver but keeps the article list in the document', async () => {
    const page = await acta();
    const line = page.getByText(/Exoneración/).closest('li')!;
    const details = line.querySelector('details')!;
    // Expandable, not hidden: 1 800 primary keys make an acta unreadable, and
    // dropping them makes the decision uncheckable.
    expect(details.textContent).toMatch(/3, 4/);
    expect(line.textContent).toMatch(/2 filas por/);
  });

  it('itemises every explicit zero with the book quantity it writes off (§4.1)', async () => {
    const page = await acta();
    const heading = page.getByText('4.1 · Conteos en cero');
    const table = heading.parentElement!.querySelector('.acta__grid')!;
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    // Who, when, and the balance that disappears. Under ZEUS_FORMAT.md §7.4
    // this line is a stock deletion, which is why it is never a column.
    expect(rows[0].textContent).toMatch(/ITEM 2/);
    expect(rows[0].textContent).toMatch(/Ana/);
    expect(page.getByText(/pone el saldo en cero/)).toBeTruthy();
  });

  it('surfaces a note with no article in its own subsection (§5.1)', async () => {
    const page = await acta();
    expect(page.getByText('5.1 · Notas sin artículo')).toBeTruthy();
    // Once, in the subsection that says why it matters. §5.2 carries the notes
    // that name an article, and a note printed twice is a reader wondering
    // whether there were two.
    expect(page.getAllByText('sobra una estiba sin marcar')).toHaveLength(1);
    expect(page.getByText(/Existencia física que el archivo no puede representar/)).toBeTruthy();
    expect(page.getByText('Ninguna sobre un artículo del catálogo.')).toBeTruthy();
  });

  it('prints §5 pair with their definitions on the page', async () => {
    const page = await acta();
    // Twice each, and deliberately: once as the row label and once inside the
    // sentence that says what it means. Somebody reading this in a year cannot
    // ask what «pendiente» is, so the page says it rather than assuming it.
    expect(page.getAllByText('pendiente').length).toBeGreaterThanOrEqual(2);
    expect(page.getAllByText('sin verificar').length).toBeGreaterThanOrEqual(2);
    expect(page.getByText(/filas que nadie tocó/)).toBeTruthy();
    expect(page.getByText(/Exonerar baja/)).toBeTruthy();
  });

  it('carries §8 in full, including the sentence about the rows nobody looked at', async () => {
    const page = await acta();
    expect(page.getByText('8 · Alcance de esta certificación')).toBeTruthy();
    expect(page.getByText('Lo que estos hashes acreditan')).toBeTruthy();
    expect(page.getByText(/Quién registró cada evento/)).toBeTruthy();
    expect(page.getByText(/no tiene forma de decir «no lo miramos»/)).toBeTruthy();
    expect(
      page.getByText(/Cualquier ajuste hecho en Zeus después de cargar el archivo/),
    ).toBeTruthy();
    // The claim the file makes and the acta corrects: two waived rows plus one
    // nobody touched.
    expect(page.getByText(/como si se hubieran contado y coincidido/)).toBeTruthy();
  });

  it('prints every hash and points at the verifier by filename (§7)', async () => {
    const page = await acta();
    expect(page.getByText('sessionHash')).toBeTruthy();
    expect(page.getByText('fileHash')).toBeTruthy();
    expect(page.getByText('sourceHash')).toBeTruthy();
    expect(page.getByText(/tools\/verificador\.html/)).toBeTruthy();
    // A hash nobody can check is decoration, so the acta says how — and says
    // that the checker travels with the count rather than living on a server.
    expect(page.getByText(/qué byte/)).toBeTruthy();
    expect(page.getByText(/viaja con el conteo/)).toBeTruthy();
  });

  it('reconciles its counts with the fold', async () => {
    const page = await acta();
    const alcance = page.getByText('1 · Alcance').parentElement!;
    const value = (label: string) =>
      [...alcance.querySelectorAll('tr')]
        .find((row) => row.querySelector('th')?.textContent === label)!
        .querySelector('td')!.textContent;

    // Four rows: two counted (one of them at zero), two waived, none untouched.
    expect(value('Filas del catálogo')).toBe('4');
    expect(value('Contadas')).toBe('2');
    expect(value('Contadas en cero')).toBe('1');
    expect(value('Exoneradas por el administrador')).toBe('2');
    expect(value('Sin contar')).toBe('0');
  });

  it('names the parameter triple, and says when it is the verified one', async () => {
    const page = await acta();
    expect(page.getByText(/Es la combinación verificada contra Zeus/)).toBeTruthy();
  });

  it('says so loudly when the triple is not the verified one', async () => {
    const { api } = sealed();
    const detail = {
      ...DETAIL,
      session: {
        ...DETAIL.session,
        parameters: {
          countTargetColumn: 'conteo1',
          uncountedPolicy: 'zero',
          differenceColumn: 'computed',
        },
        parametrosVerificados: false,
        parametrosSinVerificar: ['countTargetColumn', 'uncountedPolicy'],
      },
    };
    render(<Cierre detail={detail} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Acta de conteo físico');
    expect(
      screen.getByText(/No es la combinación verificada contra Zeus/),
    ).toBeTruthy();
  });

  it('gives every participant and every counter a signature line (§9)', async () => {
    const page = await acta();
    const signatures = document.querySelectorAll('.acta__signature');
    // Admin, jefe de costos, and one per counter.
    expect(signatures).toHaveLength(4);
    expect(page.getByText('Jefe de costos')).toBeTruthy();
  });

  it('is not shown before the seal, because there is nothing to certify', async () => {
    const { api } = reviewApi({ counters: COUNTERS, events: EVENTS, acciones: [...ACCIONES] });
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Sellar el conteo');
    expect(document.getElementById('acta')).toBeNull();
  });
});

describe('the acta does not reach for colour', () => {
  it('carries no variance class anywhere in it', async () => {
    const { api } = sealed();
    render(<Cierre detail={DETAIL} api={api} onReload={() => {}} now={() => NOW} />);
    await screen.findByText('Acta de conteo físico');
    // Colour in this product means variance direction. A grade of evidence is
    // not one, and neither is a decision.
    expect(document.getElementById('acta')!.querySelectorAll('.grid--short, .grid--over')).toHaveLength(0);
  });
});
