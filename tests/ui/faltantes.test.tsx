// @vitest-environment jsdom
/**
 * Faltantes — the completeness check and the count route in one screen.
 *
 * What is asserted here is the *order*, because the order is the product: it
 * decides what gets left behind when the clock runs out. DOMAIN.md §5 says
 * rank by exposure rather than book value, and the sample is the argument —
 * 31 perishable rows are booked at zero and would sort last under any
 * value-ordered walk.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeSession } from '../../src/domain';
import { FaltantesScreen } from '../../src/ui/screens/FaltantesScreen';
import { CountStore } from '../../src/ui/store';
import { ID, SESSION_ID, fakeIdentity, sampleSession, seededRepository } from './harness';

afterEach(cleanup);

let store: CountStore;

beforeEach(async () => {
  const repo = await seededRepository();
  store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
});

function draw() {
  const view = render(
    <FaltantesScreen store={store} onBack={() => {}} onCount={() => {}} />,
  );
  const names = () =>
    [...view.container.querySelectorAll('.rows .row__nombre')].map((node) => node.textContent);
  return { user: userEvent.setup(), names };
}

describe('ordering', () => {
  it('is byExposicion, row for row', () => {
    const expected = summarizeSession(sampleSession(), []).byExposicion.map(
      (row) => row.item.nombre,
    );
    const { names } = draw();
    expect(names()).toEqual(expected);
    expect(names()).toHaveLength(298);
  });

  it('lifts the rows a book-value ranking cannot see', () => {
    const summary = summarizeSession(sampleSession(), []);
    const byExposure = summary.byExposicion.findIndex((row) => row.item.idarticulo === ID.melon);
    const byValue = [...summary.byExposicion]
      .sort((a, b) => b.valor - a.valor || a.item.idarticulo - b.item.idarticulo)
      .findIndex((row) => row.item.idarticulo === ID.melon);

    // MELON is booked at zero and worth 1,37 M COP by its last count. Ranked
    // by book value it sits in the tail with 30 other zero rows; ranked by
    // exposure it is 28th of 298.
    expect(byExposure).toBe(27);
    expect(byValue).toBe(273);

    const { names } = draw();
    expect(names()[27]).toBe('MELON');
  });
});

describe('the figures behind the order', () => {
  it('prints none of them', () => {
    // This is a surface a counter counts from, so the money that ranks the
    // list stays out of it (DOMAIN.md §2.1): 152 562 010 exposed against
    // 140 505 651 in the books, and the 31 rows the ERP holds at zero. All of
    // it decides the order above; none of it reaches the glass. It is on the
    // review screen, under `pendiente · en riesgo`.
    draw();
    const total = screen.getByText('sin contar').parentElement!;
    expect(total.textContent).toContain('298');
    expect(total.textContent).toContain('cuenta de arriba hacia abajo');
    expect(document.body.textContent).not.toContain('152.562.010');
    expect(document.body.textContent).not.toContain('140.505.651');
    expect(document.querySelectorAll('.row__existencia')).toHaveLength(0);
    expect(screen.queryByText('en riesgo sin verificar')).toBeNull();
  });

  it('keeps the ranking that those figures produced', () => {
    // The order is the product and it survives intact: ranked by exposure,
    // MELON is 28th of 298 rather than 274th (see `ordering`, above).
    const { names } = draw();
    expect(names()[27]).toBe('MELON');
  });

  it('drops an item from the list the moment it is verified', async () => {
    const { names } = draw();
    expect(names()).toHaveLength(298);

    act(() => {
      store.markUnchanged(ID.melon);
    });

    expect(names()).toHaveLength(297);
    expect(names()).not.toContain('MELON');
  });

  it('empties out when nothing is left untouched', () => {
    for (const item of sampleSession().items) store.setCount(item.idarticulo, item.existencia);
    draw();
    expect(screen.getByText('No queda nada pendiente')).toBeTruthy();
  });
});
