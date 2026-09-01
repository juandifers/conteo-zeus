/**
 * `deriveFamilies` — a proposal, and the conditions under which there is none.
 *
 * The regression that matters is the sample one: bodega 01 yields eleven groups
 * with the counts documented in `docs/DOMAIN.md`, and all 31 rows carrying
 * `existencia = 0` land in one of them. That second fact is what makes the
 * partition worth trusting at all — it was arrived at from `codigo` digits, and
 * the zero rows were identified from the other direction entirely, by Zeus
 * booking perishables at nothing between purchases.
 */
import { describe, expect, it } from 'vitest';

import { deriveFamilies, familyPrefix, type FamilyGroup } from '../../src/domain';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import type { Item } from '../../src/domain';
import { readSample, SAMPLE_XLS } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));

function item(over: Partial<Item> & { idarticulo: number; codigo: string }): Item {
  return {
    nombre: `ART ${over.idarticulo}`,
    presentacion: 'UNIDAD',
    existencia: 1,
    ultimoConteo: null,
    costo: 1000,
    ...over,
  };
}

/** `n` articles all sharing one family prefix. */
function family(prefix: string, count: number, from = 0): Item[] {
  return Array.from({ length: count }, (_, i) =>
    item({ idarticulo: from + i, codigo: `01${prefix}${String(from + i).padStart(3, '0')}` }),
  );
}

describe('deriveFamilies over the real catalogue', () => {
  const groups = deriveFamilies(catalogue) as FamilyGroup[];

  it('proposes exactly the eleven groups the documentation names', () => {
    expect(groups).not.toBeNull();
    expect(groups.map((group) => [group.prefix, group.rows])).toEqual([
      ['09', 123],
      ['11', 54],
      ['10', 27],
      ['13', 22],
      ['12', 17],
      ['04', 14],
      ['06', 12],
      ['03', 9],
      ['08', 8],
      ['07', 7],
      ['01', 5],
    ]);
  });

  it('partitions the catalogue: every article once, nothing invented', () => {
    const assigned = groups.flatMap((group) => group.idarticulos);
    expect(assigned.length).toBe(catalogue.length);
    expect(new Set(assigned).size).toBe(catalogue.length);
    expect(new Set(assigned)).toEqual(new Set(catalogue.map((i) => i.idarticulo)));
  });

  it('puts all 31 rows booked at zero in one group, and it is the produce one', () => {
    // The corroboration. `deriveFamilies` reads `codigo` digits and knows
    // nothing about `existencia`; DOMAIN.md §5 identified these 31 rows by
    // Zeus booking perishables at zero between purchases. Two unrelated routes
    // reaching one split is the only reason to trust a structure inferred from
    // a single file — so if this ever fails, the derivation has stopped meaning
    // what the documentation says it means.
    const zeros = catalogue.filter((i) => i.existencia === 0);
    expect(zeros).toHaveLength(31);

    const holders = new Set(zeros.map((i) => familyPrefix(i.codigo)));
    expect([...holders]).toEqual(['11']);

    const produce = groups.find((group) => group.prefix === '11')!;
    expect(zeros.every((i) => produce.idarticulos.includes(i.idarticulo))).toBe(true);
  });

  it('reports exposure as well as book value, because for produce they differ enormously', () => {
    const produce = groups.find((group) => group.prefix === '11')!;
    // 31 of its 54 rows are booked at zero, so ranking families on `valor`
    // alone would send the last counter to the one shelf most likely to be
    // holding stock nobody has recorded (DOMAIN.md §5).
    expect(produce.exposicion).toBeGreaterThan(produce.valor);
    expect(produce.exposicion - produce.valor).toBeGreaterThan(6_000_000);
  });

  it('carries names, not just numbers — a prefix means nothing on its own', () => {
    for (const group of groups) {
      expect(group.ejemplos.length).toBeGreaterThan(0);
      expect(group.ejemplos.length).toBeLessThanOrEqual(5);
      expect(new Set(group.ejemplos).size).toBe(group.ejemplos.length);
    }
    expect(groups.find((g) => g.prefix === '11')!.ejemplos[0]).toBe('PAPA CRIOLLA');
  });

  it('is stable: two derivations of one catalogue are the same list', () => {
    expect(deriveFamilies(catalogue)).toEqual(groups);
  });
});

describe('the guards — when there is no proposal to make', () => {
  it('refuses a catalogue whose codigo is not uniformly 7 characters', () => {
    // ZEUS_FORMAT.md §7.5: bodega 22 stores 8-character codes, so this is a
    // real export rather than a defensive branch. `codigo[2:4]` does not mean
    // the same thing on a row of a different length, and slicing it anyway
    // produces groups that look plausible and are not.
    const mixed = [...family('09', 10), item({ idarticulo: 99, codigo: '01090999' })];
    expect(deriveFamilies(mixed)).toBeNull();
  });

  it('refuses when one prefix holds more than 80% of the rows', () => {
    const lopsided = [...family('09', 85), ...family('11', 15, 100)];
    expect(lopsided).toHaveLength(100);
    expect(deriveFamilies(lopsided)).toBeNull();

    // 80 of 100 is exactly the bound and is allowed; the guard is "more than".
    const atTheBound = [...family('09', 80), ...family('11', 20, 100)];
    expect(deriveFamilies(atTheBound)).not.toBeNull();
  });

  it('refuses fewer than two groups', () => {
    expect(deriveFamilies(family('09', 40))).toBeNull();
  });

  it('refuses more than thirty', () => {
    const many = Array.from({ length: 31 }, (_, i) =>
      family(String(i).padStart(2, '0'), 2, i * 10),
    ).flat();
    expect(deriveFamilies(many)).toBeNull();

    const thirty = Array.from({ length: 30 }, (_, i) =>
      family(String(i).padStart(2, '0'), 2, i * 10),
    ).flat();
    expect(deriveFamilies(thirty)).not.toBeNull();
  });

  it('refuses an empty catalogue rather than proposing an empty partition', () => {
    expect(deriveFamilies([])).toBeNull();
  });
});

describe('what the derivation is not', () => {
  it('names no families — the labels are the admin’s, and are not in the data', () => {
    // The eleven names in the documentation are one person's reading of one
    // bodega's article names. Nothing in the file says "abarrotes". A hardcoded
    // list would be a second bodega's bug, discovered by somebody counting the
    // wrong shelves.
    const source = deriveFamilies(catalogue)!;
    const labels = ['abarrotes', 'frutas', 'verduras', 'lacteos', 'panaderia', 'embutidos'];
    const rendered = JSON.stringify(source).toLowerCase();
    for (const label of labels) expect(rendered).not.toContain(label);
  });

  it('keeps the prefix a string: 09 is not 9', () => {
    for (const group of deriveFamilies(catalogue)!) {
      expect(typeof group.prefix).toBe('string');
      expect(group.prefix).toHaveLength(2);
    }
  });
});
