// @vitest-environment jsdom
/**
 * The review screen — P2.4 §2, §3c, §4 and §6.
 *
 * The load-bearing test in this file is the last one in the first block:
 * **waiving lowers `pendiente` and does not move `sinVerificar`**, asserted
 * against what is on the screen rather than against the domain. The domain
 * already proves the arithmetic; what this proves is that the screen shows both,
 * at the same time, so that the number which does not fall is impossible to miss
 * while clicking the button that makes the other one fall.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Revision } from '../../src/ui/admin/Revision';
import { formatMoney } from '../../src/ui/format';
import { addCount, note, resetFactory, retract } from '../domain/factory';
import { detailFor, item, reviewApi, SESSION_ID } from './reviewHarness';

afterEach(cleanup);
beforeEach(() => {
  resetFactory();
  globalThis.localStorage?.clear();
});

const ITEMS = [
  item(1, 10, 100), // 1 000 en libros
  item(2, 20, 50), // 1 000
  item(3, 5, 1000, { nombre: 'CAVIAR' }), // 5 000
  item(4, 0, 2000, { nombre: 'MELON', ultimoConteo: 6 }), // 12 000 de exposición
];

const COUNTERS = [
  { id: 'ana', nombre: 'Ana', estado: 'terminado_confirmado' },
  { id: 'luis', nombre: 'Luis', estado: 'retirado', chainComplete: false },
];

const DETAIL = detailFor({
  items: ITEMS,
  counters: COUNTERS,
  secciones: { ana: [1, 2], luis: [3, 4] },
});

function counted() {
  return [addCount(1, 12, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 })];
}

async function open(over: Parameters<typeof reviewApi>[0]) {
  const { api, posted, acciones } = reviewApi(over);
  const user = userEvent.setup();
  render(<Revision detail={DETAIL} api={api} onReload={() => {}} />);
  await screen.findByText('Sin verificar');
  return { user, api, posted, acciones };
}

describe('the two figures, and when the second one earns its place (§2a, §4.2)', () => {
  it('shows one figure while nothing is waived — two identical numbers explain nothing', async () => {
    await open({ counters: COUNTERS, events: counted() });

    // pendiente: items 2, 3 and 4 — 1 000 + 5 000 + 12 000 of exposure. The
    // figures are the same until somebody waives something, so only one is
    // rendered, with the split reserved for when a split exists.
    const cifras = within(document.getElementById('cifras')!);
    expect(cifras.getAllByText(formatMoney(18000))).toHaveLength(1);
    expect(cifras.getByText('3 de 4 filas')).toBeTruthy();
    expect(cifras.queryByText('Pendiente')).toBeNull();
    expect(cifras.queryByText(/acepta el riesgo/)).toBeNull();
  });

  it('waiving lowers pendiente and leaves sinVerificar exactly where it was', async () => {
    const { user } = await open({ counters: COUNTERS, events: counted() });

    // Waive CAVIAR — 5 000 of the 18 000.
    await user.click(screen.getByLabelText('elegir CAVIAR'));
    await user.type(screen.getByLabelText('Quién firma'), 'marta');
    await user.type(screen.getByLabelText('Motivo'), 'no alcanzó el turno');
    await user.click(screen.getByRole('button', { name: 'Exonerar 1 filas' }));
    await user.click(screen.getByRole('button', { name: 'Sí, exonerar 1 filas' }));

    // The waiver creates the split, so the second figure appears now — with
    // the one-line reason the two differ (§4.2).
    await waitFor(() =>
      expect(within(document.getElementById('cifras')!).getByText('Pendiente')).toBeTruthy(),
    );
    const cifras = within(document.getElementById('cifras')!);
    // pendiente fell by the waived row…
    expect(cifras.getByText(formatMoney(13000))).toBeTruthy();
    expect(cifras.getByText('2 filas · 1 exon.')).toBeTruthy();
    // …and sinVerificar did not move by a peso. It is still 18 000.
    expect(cifras.getByText(formatMoney(18000))).toBeTruthy();
    expect(cifras.getByText('↳ Exonerar acepta el riesgo, no lo retira.')).toBeTruthy();
  });

  it('says what waiving does to the file, before it is signed (§4d)', async () => {
    const { user, posted } = await open({ counters: COUNTERS, events: counted() });

    await user.click(screen.getByLabelText('elegir CAVIAR'));
    await user.click(screen.getByLabelText('elegir MELON'));
    await user.type(screen.getByLabelText('Quién firma'), 'marta');
    await user.type(screen.getByLabelText('Motivo'), 'cierre');
    await user.click(screen.getByRole('button', { name: 'Exonerar 2 filas' }));

    // Named, and priced, before anything is sent.
    expect(
      screen.getByText(new RegExp(`Vas a exonerar 2 filas por ${escape(formatMoney(5000))} COP`)),
    ).toBeTruthy();
    // And the consequence in the file, in words.
    expect(
      screen.getByText(/se van a escribir en el archivo con la cantidad de\s+Zeus, como si se hubieran contado y coincidido/),
    ).toBeTruthy();
    expect(posted).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Sí, exonerar 2 filas' }));
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({
      kind: 'waiver',
      usuario: 'marta',
      motivo: 'cierre',
      idarticulo: [3, 4],
    });
    // No quantity crosses the wire. The waived value is `existencia`, read where
    // it lives, and a copy in the payload would be a second figure.
    expect(JSON.stringify(posted[0].body)).not.toMatch(/cantidad|qty|existencia/);
  });

  it('withdraws one without deleting it', async () => {
    const { user, posted } = await open({ counters: COUNTERS, events: counted() });

    await user.click(screen.getByLabelText('elegir CAVIAR'));
    await user.type(screen.getByLabelText('Quién firma'), 'marta');
    await user.type(screen.getByLabelText('Motivo'), 'cierre');
    await user.click(screen.getByRole('button', { name: 'Exonerar 1 filas' }));
    await user.click(screen.getByRole('button', { name: 'Sí, exonerar 1 filas' }));

    await waitFor(() => expect(screen.getByText('Exoneraciones firmadas')).toBeTruthy());
    await user.type(screen.getByLabelText('Motivo'), 'me equivoqué');
    await user.click(screen.getByLabelText('anular la exoneración de marta'));

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].body).toMatchObject({ kind: 'anular_waiver', waiverId: 'accion-1' });
    // Back to three untouched rows and a collapsed header — no standing
    // waivers, no split — and the original action is still on the chain.
    await waitFor(() =>
      expect(
        within(document.getElementById('cifras')!).getByText('3 de 4 filas'),
      ).toBeTruthy(),
    );
  });
});

describe('the lists somebody walks before sealing', () => {
  it('gives explicit zeros their own list, priced, with no bulk dismiss', async () => {
    await open({
      counters: COUNTERS,
      events: [
        addCount(3, 0, { counterId: 'luis', sessionId: SESSION_ID, seq: 1 }),
        addCount(1, 0, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 }),
      ],
    });

    const panel = document.getElementById('hallazgo-ceros')!;
    expect(within(panel).getByText('Registrados en cero (2)')).toBeTruthy();
    // Sorted by what each line writes off: CAVIAR at 5 000 first.
    const names = within(panel)
      .getAllByText(/ITEM 1|CAVIAR/)
      .map((node) => node.textContent);
    expect(names).toEqual(['CAVIAR', 'ITEM 1']);
    // Nothing here clears the list. Every line is a write-off.
    for (const button of within(panel).queryAllByRole('button')) {
      expect(button.textContent).not.toMatch(/descartar|ignorar|limpiar|ocultar/i);
    }
    expect(within(panel).queryAllByRole('button')).toEqual([]);
  });

  it('separates an explained overlap from an unexplained one', async () => {
    await open({
      counters: COUNTERS,
      events: [
        addCount(3, 4, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 }),
        addCount(3, 6, { counterId: 'luis', sessionId: SESSION_ID, seq: 1 }),
      ],
    });
    const panel = document.getElementById('hallazgo-overlap')!;
    expect(
      within(panel).getByText(/nadie lo reasignó — dos secciones, o alguien contó fuera/),
    ).toBeTruthy();
    // The breakdown is there: neither of them counted ten.
    expect(within(panel).getByText(/Ana: 4 en 1 registros/)).toBeTruthy();
    expect(within(panel).getByText(/Luis: 6 en 1 registros/)).toBeTruthy();
  });

  it('pulls notes with no article into their own section', async () => {
    await open({
      counters: COUNTERS,
      events: [
        note(1, 'la caja está abollada', { counterId: 'ana', sessionId: SESSION_ID, seq: 1 }),
        note(null, 'hay dos canastas sin código', {
          counterId: 'ana',
          sessionId: SESSION_ID,
          seq: 2,
        }),
      ],
    });
    const loose = document.getElementById('hallazgo-notas')!;
    expect(within(loose).getByText('Notas sin artículo (1)')).toBeTruthy();
    expect(within(loose).getByText('hay dos canastas sin código')).toBeTruthy();
    expect(within(loose).queryByText('la caja está abollada')).toBeNull();
  });

  it('surfaces a trailing retraction for a counter who is done', async () => {
    const entry = addCount(1, 5, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 });
    await open({
      counters: COUNTERS,
      events: [
        entry,
        retract(1, {
          counterId: 'ana',
          sessionId: SESSION_ID,
          seq: 2,
          retractsEventId: entry.id,
        }),
      ],
    });
    const panel = document.getElementById('hallazgo-retraccion')!;
    expect(within(panel).getByText('Terminaron deshaciendo (1)')).toBeTruthy();
  });
});

describe('the pre-seal panel separates what blocks from what does not (§6)', () => {
  it('shows the blocking list and the advisory list under different headings', async () => {
    await open({
      counters: COUNTERS,
      events: counted(),
      readyToSeal: [
        { kind: 'contador-retirado-incompleto', counterId: 'luis', nombre: 'Luis' },
      ],
    });

    const panel = document.getElementById('sellado')!;
    expect(within(panel).getByText('Bloquea')).toBeTruthy();
    expect(within(panel).getByText('No bloquea, pero míralo')).toBeTruthy();
    expect(
      within(panel).getByText(/Luis se retiró y faltan registros suyos/),
    ).toBeTruthy();
    expect(within(panel).getByText('3 filas que nadie tocó')).toBeTruthy();
  });

  it('does not present a confirmed finish and a retirement as the same evidence (§6a)', async () => {
    await open({ counters: COUNTERS, events: counted() });
    const panel = document.getElementById('sellado')!;
    expect(
      within(panel).getByText(/verificado: su tableta declaró cuánto registró/),
    ).toBeTruthy();
    expect(
      within(panel).getByText(/sin verificar: se retiró sin tocar «Terminar»/),
    ).toBeTruthy();
  });
});

describe('scale', () => {
  it('draws 2 400 rows without putting 2 400 rows in the DOM', async () => {
    const many = Array.from({ length: 2400 }, (_, i) => item(i + 1, (i % 40) + 1, 100 + i));
    const detail = detailFor({
      items: many,
      counters: COUNTERS,
      secciones: { ana: many.slice(0, 1200).map((row) => row.idarticulo) },
    });
    const { api } = reviewApi({ counters: COUNTERS, events: [] });
    render(<Revision detail={detail} api={api} onReload={() => {}} />);
    await screen.findByText(/2400 artículos · por exposición de la diferencia/);

    const scroll = document.querySelector('.gridscroll')!;
    expect(scroll.getAttribute('data-rows')).toBe('2400');
    // The window plus two spacers, nowhere near the whole catalogue.
    const drawn = scroll.querySelectorAll('tbody tr').length;
    expect(drawn).toBeLessThan(60);
    expect(drawn).toBeGreaterThan(4);
  });
});

/** Escape a formatted figure for use inside a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
