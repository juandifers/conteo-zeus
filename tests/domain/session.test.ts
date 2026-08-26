/**
 * Session summary — the numbers DOMAIN.md §5 requires before posting.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isWriteOff, summarizeSession, type Item, type Session } from '../../src/domain';
import {
  SESSION_ID,
  addCount,
  markUnchanged,
  resetFactory,
  retract,
  setCount,
} from './factory';

function item(
  idarticulo: number,
  existencia: number,
  costo: number,
  nombre = `ITEM ${idarticulo}`,
  ultimoConteo: number | null = null,
): Item {
  return {
    idarticulo,
    codigo: String(idarticulo).padStart(7, '0'),
    nombre,
    presentacion: 'KILO',
    existencia,
    ultimoConteo,
    costo,
  };
}

const SESSION: Session = {
  id: SESSION_ID,
  bodega: '01',
  fechaCorte: '2025/04/30',
  sourceHash: 'not-checked-here',
  createdAt: '2026-08-25T09:00:00.000Z',
  items: [
    item(1, 10, 100), // 1 000 book value
    item(2, 20, 50), // 1 000
    item(3, 5, 1000, 'CAVIAR'), // 5 000 — the expensive one
    item(4, 100, 10), // 1 000
  ],
};

beforeEach(resetFactory);

describe('summarizeSession — states', () => {
  it('counts every item in exactly one state, summing to the item count', () => {
    // Item 2 is counted at zero — a quantity, not a state (§2).
    const summary = summarizeSession(SESSION, [
      setCount(1, 12),
      setCount(2, 0),
      markUnchanged(3),
    ]);
    expect(summary.counts).toEqual({ counted: 2, unchanged: 1, untouched: 1 });
    const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.itemCount);
    expect(total).toBe(4);
  });

  it('blocks posting while anything is untouched (§9)', () => {
    expect(summarizeSession(SESSION, []).canPost).toBe(false);
    expect(summarizeSession(SESSION, [setCount(1, 10)]).canPost).toBe(false);
  });

  it('allows posting once every item is counted or waived', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 10),
      setCount(2, 0),
      markUnchanged(3),
      addCount(4, 100),
    ]);
    expect(summary.counts.untouched).toBe(0);
    expect(summary.canPost).toBe(true);
  });

  it('goes back to blocking the post when a count is withdrawn (§3)', () => {
    const counted = [setCount(1, 10), setCount(2, 0), markUnchanged(3), addCount(4, 100)];
    expect(summarizeSession(SESSION, counted).canPost).toBe(true);

    const summary = summarizeSession(SESSION, [...counted, retract(2)]);
    expect(summary.counts.untouched).toBe(1);
    expect(summary.canPost).toBe(false);
    // …and the withdrawn row is back in the unverified figures, where it
    // belongs: nobody has looked at it.
    expect(summary.byExposicion.map((row) => row.item.idarticulo)).toEqual([2]);
  });
});

describe('summarizeSession — variance', () => {
  it('reports net and gross separately', () => {
    // +2 x 100 = +200, and -2 x 50 = -100.
    const summary = summarizeSession(SESSION, [setCount(1, 12), setCount(2, 18)]);
    expect(summary.netVarianceValue).toBe(100);
    expect(summary.grossVarianceValue).toBe(300);
  });

  it('nets to zero where the gross does not — the case that must stay visible', () => {
    // Two errors of 500 COP in opposite directions. Net says "nothing to see".
    const summary = summarizeSession(SESSION, [setCount(1, 15), setCount(2, 10)]);
    expect(summary.netVarianceValue).toBe(0);
    expect(summary.grossVarianceValue).toBe(1000);
  });

  it('excludes unchanged and untouched from both totals', () => {
    const summary = summarizeSession(SESSION, [markUnchanged(1), markUnchanged(2)]);
    expect(summary.netVarianceValue).toBe(0);
    expect(summary.grossVarianceValue).toBe(0);
    expect(summary.byMateriality).toHaveLength(0);
    expect(summary.items.filter((s) => s.variance === null)).toHaveLength(4);
  });
});

describe('summarizeSession — ranking', () => {
  it('ranks counted items by materialidad descending', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 11), //   +100
      setCount(3, 3), // -2 000
      setCount(4, 130), //  +300
    ]);
    expect(summary.byMateriality.map((s) => s.item.idarticulo)).toEqual([3, 4, 1]);
    expect(summary.byMateriality[0].item.nombre).toBe('CAVIAR');
  });

  it('breaks ties on idarticulo so the order is stable, not input-dependent', () => {
    const forwards = summarizeSession(SESSION, [setCount(1, 11), setCount(2, 22)]);
    const backwards = summarizeSession(SESSION, [setCount(2, 22), setCount(1, 11)]);
    // Both are 100 COP.
    expect(forwards.byMateriality.map((s) => s.item.idarticulo)).toEqual([1, 2]);
    expect(backwards.byMateriality.map((s) => s.item.idarticulo)).toEqual([1, 2]);
  });

  it('keeps items in file order in `items`, whatever the ranking says', () => {
    const summary = summarizeSession(SESSION, [setCount(3, 0)]);
    expect(summary.items.map((s) => s.item.idarticulo)).toEqual([1, 2, 3, 4]);
  });
});

describe('summarizeSession — pendiente — book value (§5, §9)', () => {
  it('sums the book value of untouched items only', () => {
    const summary = summarizeSession(SESSION, [setCount(1, 10), markUnchanged(2)]);
    // Items 3 and 4 remain: 5 000 + 1 000.
    expect(summary.pendiente.valor).toBe(6000);
  });

  it('does not count a waived item as unverified — someone attested to it', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 10),
      setCount(2, 20),
      markUnchanged(3, { motivo: 'congelador sellado' }),
      setCount(4, 100),
    ]);
    expect(summary.counts.unchanged).toBe(1);
    expect(summary.pendiente.valor).toBe(0);
    expect(summary.canPost).toBe(true);
  });

  it('names the highest-value unverified items, descending', () => {
    const summary = summarizeSession(SESSION, []);
    expect(summary.pendienteTop.map((u) => u.item.nombre)).toEqual([
      'CAVIAR',
      'ITEM 1',
      'ITEM 2',
      'ITEM 4',
    ]);
    expect(summary.pendienteTop[0].valor).toBe(5000);
    expect(summary.pendiente.valor).toBe(8000);
  });

  it('honours topN', () => {
    const summary = summarizeSession(SESSION, [], { topN: 2 });
    expect(summary.pendienteTop).toHaveLength(2);
    // The total is the whole waiver, not just the named part.
    expect(summary.pendiente.valor).toBe(8000);
  });

  it('is zero once nothing is untouched', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 1),
      setCount(2, 2),
      setCount(3, 3),
      setCount(4, 4),
    ]);
    expect(summary.pendiente.valor).toBe(0);
    expect(summary.pendienteTop).toEqual([]);
  });
});

describe('summarizeSession — pendiente — exposure (§5)', () => {
  /**
   * The shape §5 is about: a perishable the ERP books at zero between
   * purchases, sitting beside ordinary stock. By book value it is worth
   * nothing and sorts to the bottom; by exposure it is the largest thing in
   * the room.
   */
  const PERISHABLES: Session = {
    ...SESSION,
    items: [
      item(10, 100, 10), //                          book 1 000, no prior
      item(11, 0, 5000, 'MELON', 234.8), //          book     0, exposure 1 174 000
      item(12, 5, 100, 'ARROZ', 2), //               book   500, prior below the book
      item(13, 0, 10, 'SAL', 0), //                  book     0, prior of zero
    ],
  };

  it('adds up the two figures separately', () => {
    const summary = summarizeSession(PERISHABLES, []);
    expect(summary.pendiente.valor).toBe(1500);
    expect(summary.pendiente.exposicion).toBe(1_175_500);
  });

  it('ranks by exposure, which is a different order from book value', () => {
    const summary = summarizeSession(PERISHABLES, []);
    expect(summary.byExposicion.map((u) => u.item.idarticulo)).toEqual([11, 10, 12, 13]);
    expect(summary.pendienteTop.map((u) => u.item.idarticulo)).toEqual([10, 12, 11, 13]);

    // Same item, opposite ends of the two rankings. Walking the count route by
    // book value would send everyone past it last.
    expect(summary.byExposicion[0].item.nombre).toBe('MELON');
    expect(summary.byExposicion[0].valor).toBe(0);
    expect(summary.byExposicion[0].exposicion).toBe(1_174_000);
  });

  it('uses the book figure when the prior is smaller or absent', () => {
    const summary = summarizeSession(PERISHABLES, []);
    const byId = new Map(summary.byExposicion.map((u) => [u.item.idarticulo, u]));
    expect(byId.get(12)!.exposicion).toBe(500); // prior 2 < existencia 5
    expect(byId.get(10)!.exposicion).toBe(1000); // no prior at all
    expect(byId.get(13)!.exposicion).toBe(0); // prior of zero is not evidence
  });

  it('drops an item from both figures the moment somebody verifies it', () => {
    const counted = summarizeSession(PERISHABLES, [setCount(11, 300)]);
    expect(counted.pendiente.exposicion).toBe(1500);
    expect(counted.byExposicion.map((u) => u.item.idarticulo)).toEqual([10, 12, 13]);

    // A waiver counts as verification too: somebody put their name to it (§4).
    const waived = summarizeSession(PERISHABLES, [markUnchanged(11)]);
    expect(waived.pendiente.exposicion).toBe(1500);
    expect(waived.byExposicion.some((u) => u.item.idarticulo === 11)).toBe(false);
  });

  it('is never below the book value beside it', () => {
    for (const events of [[], [setCount(10, 1)], [markUnchanged(12)]]) {
      const summary = summarizeSession(PERISHABLES, events);
      expect(summary.pendiente.exposicion).toBeGreaterThanOrEqual(
        summary.pendiente.valor,
      );
    }
  });

  it('is zero once nothing is untouched', () => {
    const summary = summarizeSession(PERISHABLES, [
      setCount(10, 1),
      setCount(11, 2),
      markUnchanged(12),
      setCount(13, 0),
    ]);
    expect(summary.pendiente.valor).toBe(0);
    expect(summary.pendiente.exposicion).toBe(0);
    expect(summary.byExposicion).toEqual([]);
    expect(summary.canPost).toBe(true);
  });
});

describe('summarizeSession — guards', () => {
  it('refuses events from another session', () => {
    expect(() =>
      summarizeSession(SESSION, [setCount(1, 5, { sessionId: 'other-session' })]),
    ).toThrow(/belongs to session other-session/);
  });

  it('refuses an event for an item this session does not contain', () => {
    expect(() => summarizeSession(SESSION, [setCount(999, 5)])).toThrow(
      /idarticulo 999, which is not in session/,
    );
  });
});

describe('write-offs — derived, never modelled (§2)', () => {
  it('catches exactly the rows counted at zero against a non-zero book figure', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 0), // 10 x 100 on the books, counted empty — a write-off
      setCount(2, 0.5), // counted low, but counted
      setCount(3, 0), // 5 x 1000 — the expensive write-off
      markUnchanged(4),
    ]);
    expect(summary.writeOffs.map((row) => row.item.idarticulo)).toEqual([3, 1]);
    expect(summary.writeOffValue).toBe(6000);
  });

  it('does not call a zero-book row counted at zero a write-off', () => {
    // The ERP already believed the shelf was empty and somebody confirmed it.
    // Nothing is being written off, and a list that said otherwise would send
    // a supervisor to look at 31 perishables every single time (§5).
    const session: Session = { ...SESSION, items: [item(9, 0, 4000, 'MELON')] };
    const summary = summarizeSession(session, [setCount(9, 0)]);
    expect(summary.counts.counted).toBe(1);
    expect(summary.writeOffs).toEqual([]);
    expect(summary.writeOffValue).toBe(0);
  });

  it('is not a state: a write-off is `counted` with a variance class', () => {
    const summary = summarizeSession(SESSION, [setCount(3, 0)]);
    const row = summary.writeOffs[0];
    expect(row.state).toBe('counted');
    expect(row.variance!.varianceClass).toBe('shortage');
    expect(isWriteOff(row)).toBe(true);
  });

  it('excludes waived and untouched rows, which carry no quantity at all', () => {
    // A waiver posts as `existencia`; an untouched row posts as nothing. Neither
    // is somebody saying "the shelf is empty", which is the whole claim here.
    const summary = summarizeSession(SESSION, [markUnchanged(1), retract(2)]);
    expect(summary.writeOffs).toEqual([]);
  });

  it('ranks them by what they cost, like the main table', () => {
    const summary = summarizeSession(SESSION, [setCount(1, 0), setCount(3, 0), setCount(4, 0)]);
    expect(summary.writeOffs.map((row) => row.variance!.materialidad)).toEqual([
      5000, 1000, 1000,
    ]);
    // Ties break on idarticulo, so the table reads the same twice running.
    expect(summary.writeOffs.map((row) => row.item.idarticulo)).toEqual([3, 1, 4]);
  });
});

describe('net and gross are not interchangeable', () => {
  it('reports a real gross on a session engineered to net to zero', () => {
    // +1 000 on item 1, -1 000 on item 3. The money nets out and the count is
    // still wrong in two directions, which is a control failure whatever the
    // net says.
    const summary = summarizeSession(SESSION, [setCount(1, 20), setCount(3, 4)]);
    expect(summary.netVarianceValue).toBe(0);
    expect(summary.grossVarianceValue).toBe(2000);
  });

  it('computes each from the item variances rather than from the other', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 12), // +2 x 100 = +200
      setCount(2, 10), // -10 x 50 = -500
      setCount(4, 100), // exact
    ]);
    const signed = summary.byMateriality.map((row) => row.variance!.valorVariance);
    expect(summary.netVarianceValue).toBe(signed.reduce((a, b) => a + b, 0));
    expect(summary.grossVarianceValue).toBe(
      signed.reduce((total, value) => total + Math.abs(value), 0),
    );
    expect(summary.netVarianceValue).toBe(-300);
    expect(summary.grossVarianceValue).toBe(700);
  });

  it('leaves both at zero when nothing was counted, waivers included', () => {
    const summary = summarizeSession(SESSION, [markUnchanged(1), markUnchanged(2)]);
    expect(summary.netVarianceValue).toBe(0);
    expect(summary.grossVarianceValue).toBe(0);
  });
});

describe('the two scopes (§5)', () => {
  it('pendiente is over untouched; sinVerificar is over untouched and unchanged', () => {
    // Item 1 counted, item 2 waived, items 3 and 4 untouched.
    const summary = summarizeSession(SESSION, [setCount(1, 10), markUnchanged(2)]);

    expect(summary.pendiente.items).toBe(2);
    expect(summary.pendiente.valor).toBe(6000); // 5 000 + 1 000
    expect(summary.sinVerificar.items).toBe(3);
    expect(summary.sinVerificar.valor).toBe(7000); // and item 2's 1 000
  });

  it('sinVerificar falls only when an item is genuinely counted', () => {
    const before = summarizeSession(SESSION, []);
    expect(before.sinVerificar.valor).toBe(8000);

    // Four waivers: every row leaves `pendiente` and none leaves `sinVerificar`.
    const waived = summarizeSession(SESSION, [
      markUnchanged(1),
      markUnchanged(2),
      markUnchanged(3),
      markUnchanged(4),
    ]);
    expect(waived.pendiente).toEqual({ items: 0, valor: 0, exposicion: 0 });
    expect(waived.sinVerificar.valor).toBe(8000);
    expect(waived.sinVerificar.items).toBe(4);
    expect(waived.canPost).toBe(true);

    // One real count, and only then does it move — by that item's book value.
    const counted = summarizeSession(SESSION, [
      markUnchanged(1),
      markUnchanged(2),
      setCount(3, 5),
      markUnchanged(4),
    ]);
    expect(counted.sinVerificar.valor).toBe(3000);
  });

  it('a retraction puts a waived row back into pendiente without moving sinVerificar', () => {
    const events = [markUnchanged(3), retract(3)];
    const summary = summarizeSession(SESSION, events);
    expect(summary.pendiente.items).toBe(4);
    expect(summary.sinVerificar.items).toBe(4);
    expect(summary.sinVerificar.valor).toBe(8000);
  });

  it('reports exposure above book value in both scopes, never below', () => {
    const session: Session = {
      ...SESSION,
      items: [item(20, 0, 5000, 'MELON', 234.8), item(21, 4, 1000, 'ARROZ', 2)],
    };
    const summary = summarizeSession(session, [markUnchanged(20)]);
    expect(summary.sinVerificar.valor).toBe(4000);
    expect(summary.sinVerificar.exposicion).toBe(1_178_000); // 234,8 x 5 000 + 4 000
    expect(summary.pendiente.valor).toBe(4000);
    expect(summary.pendiente.exposicion).toBe(4000);
  });

  it('leaves both empty on a fully counted session', () => {
    const summary = summarizeSession(SESSION, [
      setCount(1, 1),
      setCount(2, 1),
      setCount(3, 1),
      setCount(4, 1),
    ]);
    expect(summary.pendiente).toEqual({ items: 0, valor: 0, exposicion: 0 });
    expect(summary.sinVerificar).toEqual({ items: 0, valor: 0, exposicion: 0 });
  });
});

describe('cobertura (§5)', () => {
  it('is counted book value over total book value, and rows beside it', () => {
    // Item 3 is 5 000 of the 8 000 in the bodega, and one row of four.
    const summary = summarizeSession(SESSION, [setCount(3, 5)]);
    expect(summary.cobertura.valor).toBe(5000);
    expect(summary.cobertura.valorTotal).toBe(8000);
    expect(summary.cobertura.fraccionValor).toBe(0.625);
    expect(summary.cobertura.filas).toBe(1);
    expect(summary.cobertura.filasTotal).toBe(4);
    expect(summary.cobertura.fraccionFilas).toBe(0.25);
  });

  it('diverges from row coverage, which is the reason both are reported', () => {
    // Three of four rows counted — 75% of the rows, 37,5% of the money.
    const summary = summarizeSession(SESSION, [setCount(1, 1), setCount(2, 1), setCount(4, 1)]);
    expect(summary.cobertura.fraccionFilas).toBe(0.75);
    expect(summary.cobertura.fraccionValor).toBe(0.375);
  });

  it('credits nothing to a waiver, because nobody counted it', () => {
    const summary = summarizeSession(SESSION, [markUnchanged(3), markUnchanged(1)]);
    expect(summary.cobertura.valor).toBe(0);
    expect(summary.cobertura.fraccionValor).toBe(0);
    expect(summary.cobertura.fraccionFilas).toBe(0);
    // Completeness is a different question and `canPost` is where it is asked.
    expect(summary.counts.unchanged).toBe(2);
  });

  it('counts a row at its book value, not at what was found on the shelf', () => {
    // Coverage says how much of the bodega was looked at. A shelf found empty
    // was still looked at, and a shelf found full does not become more covered.
    const empty = summarizeSession(SESSION, [setCount(3, 0)]);
    const full = summarizeSession(SESSION, [setCount(3, 500)]);
    expect(empty.cobertura.valor).toBe(5000);
    expect(full.cobertura.valor).toBe(5000);
  });

  it('reports zero rather than one when the whole book is worth nothing', () => {
    const session: Session = { ...SESSION, items: [item(30, 0, 4000), item(31, 0, 100)] };
    const summary = summarizeSession(session, [setCount(30, 3)]);
    expect(summary.cobertura.valorTotal).toBe(0);
    expect(summary.cobertura.fraccionValor).toBe(0);
    expect(summary.cobertura.fraccionFilas).toBe(0.5);
  });
});
