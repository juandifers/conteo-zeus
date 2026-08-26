/**
 * Variance and exposure — DOMAIN.md §2 and §5.
 */
import { describe, expect, it } from 'vitest';
import {
  bookValue,
  exposureQuantity,
  exposureValue,
  itemVariance,
  resolve,
  type Item,
} from '../../src/domain';
import { addCount, markUnchanged, setCount } from './factory';

/** PANCETA SV / KILO, from the real sample. */
const PANCETA: Item = {
  idarticulo: 1181,
  codigo: '0103005',
  nombre: 'PANCETA SV',
  presentacion: 'KILO',
  existencia: 97.5,
  ultimoConteo: 20.8,
  costo: 3990.62686567164,
};

/** MELON / KILO — booked at zero, last counted at 234.8 (DOMAIN.md §5). */
const MELON: Item = {
  idarticulo: 77,
  codigo: '0201013',
  nombre: 'MELON',
  presentacion: 'KILO',
  existencia: 0,
  ultimoConteo: 234.8,
  costo: 5821.67802385009,
};

describe('itemVariance', () => {
  it('is qty - existencia, decimally', () => {
    const variance = itemVariance(PANCETA, resolve([setCount(1181, 113.1)]));
    expect(variance?.variance).toBe(15.6);
    expect(113.1 - 97.5).not.toBe(15.6); // the reason subtractDecimal exists
  });

  it('is negative when the shelf holds less than the book', () => {
    const variance = itemVariance(PANCETA, resolve([setCount(1181, 90)]));
    expect(variance?.variance).toBe(-7.5);
    expect(variance?.varianceClass).toBe('shortage');
    expect(variance?.valorVariance).toBeCloseTo(-29929.7, 1);
    expect(variance?.materialidad).toBeCloseTo(29929.7, 1);
  });

  it('ranks on size, not direction — but keeps the direction', () => {
    const over = itemVariance(PANCETA, resolve([setCount(1181, 107.5)]))!;
    const under = itemVariance(PANCETA, resolve([setCount(1181, 87.5)]))!;
    expect(over.valorVariance).toBeGreaterThan(0);
    expect(under.valorVariance).toBeLessThan(0);
    expect(over.materialidad).toBeCloseTo(under.materialidad, 6);
    expect(over.varianceClass).toBe('overage');
    expect(under.varianceClass).toBe('shortage');
  });

  it('reports zero variance for a count that matched — that is evidence', () => {
    const variance = itemVariance(PANCETA, resolve([setCount(1181, 97.5)]));
    expect(variance).not.toBeNull();
    expect(variance?.variance).toBe(0);
    expect(variance?.varianceClass).toBe('none');
    expect(variance?.materialidad).toBe(0);
  });

  it('classifies a count of zero by what it was measured against (§2)', () => {
    // The same quantity, two different findings. This is why 'counted-zero' is
    // not a state: it cannot tell these apart, and a UI grouping by state would
    // put the write-off and the confirmed-empty shelf in the same bucket.
    const writeOff = itemVariance(PANCETA, resolve([setCount(1181, 0)]));
    expect(writeOff?.varianceClass).toBe('shortage');
    expect(writeOff?.variance).toBe(-97.5);
    expect(writeOff?.materialidad).toBeCloseTo(389086.1, 1);

    const confirmedEmpty = itemVariance(MELON, resolve([setCount(77, 0)]));
    expect(confirmedEmpty?.varianceClass).toBe('none');
    expect(confirmedEmpty?.variance).toBe(0);
    expect(confirmedEmpty?.materialidad).toBe(0);
  });

  it('classifies an overage', () => {
    const variance = itemVariance(MELON, resolve([setCount(77, 12)]));
    expect(variance?.varianceClass).toBe('overage');
    expect(variance?.variance).toBe(12);
  });

  it('returns null for unchanged — not a zero variance (§9)', () => {
    expect(itemVariance(PANCETA, resolve([markUnchanged(1181)]))).toBeNull();
  });

  it('returns null for untouched — not a zero variance (§9)', () => {
    expect(itemVariance(PANCETA, resolve([]))).toBeNull();
  });

  it('keeps a matched count and a waiver apart, though both move no money', () => {
    // Both contribute 0 to the net. Only one is evidence the book is right,
    // and collapsing them to a shared zero is exactly what §9 forbids.
    const counted = itemVariance(PANCETA, resolve([setCount(1181, 97.5)]));
    const waived = itemVariance(PANCETA, resolve([markUnchanged(1181)]));
    expect(counted?.materialidad).toBe(0);
    expect(waived).toBeNull();
  });

  it('survives a tally arriving in pieces', () => {
    const events = [addCount(1181, 90), addCount(1181, 7.5)];
    expect(itemVariance(PANCETA, resolve(events))?.variance).toBe(0);
  });
});

describe('bookValue', () => {
  it('is existencia x costo', () => {
    expect(bookValue(PANCETA)).toBeCloseTo(389086.12, 2);
  });

  it('is zero for an item the ERP believes is out of stock', () => {
    expect(bookValue(MELON)).toBe(0);
  });
});

describe('exposure (§5)', () => {
  it('is the book quantity when that is the larger', () => {
    expect(exposureQuantity(PANCETA)).toBe(97.5); // last count was 20.8
    expect(exposureValue(PANCETA)).toBeCloseTo(bookValue(PANCETA), 6);
  });

  it('is the last count when the book says zero — the case §5 exists for', () => {
    expect(exposureQuantity(MELON)).toBe(234.8);
    expect(bookValue(MELON)).toBe(0);
    expect(Math.round(exposureValue(MELON))).toBe(1_366_930);
  });

  it('ignores a prior of zero: an empty shelf last time is not evidence of stock', () => {
    const item = { ...MELON, ultimoConteo: 0 };
    expect(exposureQuantity(item)).toBe(0);
    expect(exposureValue(item)).toBe(0);
  });

  it('falls back to the book figure when there is no prior at all', () => {
    const item = { ...PANCETA, ultimoConteo: null };
    expect(exposureQuantity(item)).toBe(97.5);
  });

  it('never understates the book figure', () => {
    for (const prior of [null, 0, 1, 97.5, 200]) {
      expect(exposureQuantity({ ...PANCETA, ultimoConteo: prior })).toBeGreaterThanOrEqual(
        PANCETA.existencia,
      );
    }
  });
});
