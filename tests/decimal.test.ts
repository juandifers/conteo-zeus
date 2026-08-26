/**
 * src/lib/decimal.ts — the arithmetic ZEUS_FORMAT.md §3 requires.
 *
 * The subtractDecimal block moved here from formatNumber.test.ts when the
 * utilities left src/zeus/; the domain needs them too, and neither side may
 * import the other.
 */
import { describe, it, expect } from 'vitest';
import { addDecimal, subtractDecimal, multiplyDecimal } from '../src/lib/decimal';
import { formatNumber } from '../src/zeus/formatNumber';

describe('subtractDecimal', () => {
  it('keeps binary noise out of diferencia', () => {
    expect(subtractDecimal(21, 20.8)).toBe(0.2);
    expect(21 - 20.8).not.toBe(0.2); // the reason this function exists
    expect(subtractDecimal(0.3, 0.1)).toBe(0.2);
    expect(subtractDecimal(113.1, 97.5)).toBe(15.6);
    expect(formatNumber(subtractDecimal(21, 20.8))).toBe('0.2');
  });

  it('agrees with plain subtraction on integers', () => {
    expect(subtractDecimal(30, 10)).toBe(20);
    expect(subtractDecimal(0, 1272)).toBe(-1272);
    expect(subtractDecimal(5, 5)).toBe(0);
  });

  it('handles a count below the existencia', () => {
    expect(subtractDecimal(46, 48)).toBe(-2);
    expect(subtractDecimal(20.5, 20.8)).toBe(-0.3);
    expect(formatNumber(subtractDecimal(20.5, 20.8))).toBe('-0.3');
  });

  it('falls back safely when scaling would overflow the exact integer range', () => {
    const value = subtractDecimal(3990.62686567164, 1);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(3989.62686567164, 10);
  });
});

describe('addDecimal', () => {
  it('keeps a tally from drifting', () => {
    expect(addDecimal(0.1, 0.2)).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this function exists
    expect(formatNumber(addDecimal(0.1, 0.2))).toBe('0.3');
  });

  it('survives a long chain of taps, which is how tally mode accumulates', () => {
    // 100 taps of 0.1 kilo. Plain + reaches 9.99999999999998.
    let decimal = 0;
    let plain = 0;
    for (let i = 0; i < 100; i++) {
      decimal = addDecimal(decimal, 0.1);
      plain += 0.1;
    }
    expect(decimal).toBe(10);
    expect(formatNumber(decimal)).toBe('10');
    expect(plain).not.toBe(10);
    expect(formatNumber(plain)).not.toBe('10'); // what would have gone on the wire
  });

  it('mixes decimal places without inventing precision', () => {
    expect(addDecimal(20.8, 0.25)).toBe(21.05);
    expect(addDecimal(113.1, 0.9)).toBe(114);
    expect(formatNumber(addDecimal(113.1, 0.9))).toBe('114');
  });

  it('agrees with plain addition on integers', () => {
    expect(addDecimal(10080, 20)).toBe(10100);
    expect(addDecimal(0, 0)).toBe(0);
  });

  it('handles negative corrections, which is how a mis-tap is undone', () => {
    expect(addDecimal(0.3, -0.1)).toBe(0.2);
    expect(addDecimal(5, -7)).toBe(-2);
  });

  it('falls back safely rather than returning a wrong exact answer', () => {
    const value = addDecimal(3990.62686567164, 0.1);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(3990.72686567164, 10);
  });
});

describe('multiplyDecimal', () => {
  it('is exact when the scaled product fits', () => {
    expect(multiplyDecimal(1.1, 1.1)).toBe(1.21);
    expect(1.1 * 1.1).not.toBe(1.21);
    expect(multiplyDecimal(0.1, 3)).toBe(0.3);
    expect(multiplyDecimal(-15.6, 2.5)).toBe(-39);
  });

  it('falls back on a 13-dp costo rather than returning nonsense', () => {
    // existencia 113.1 x costo2 27819.9547303271 needs 10^14 of headroom.
    const value = multiplyDecimal(113.1, 27819.9547303271);
    expect(value).toBeCloseTo(3146436.88, 2);
  });

  it('agrees with plain multiplication on integers', () => {
    expect(multiplyDecimal(10080, 3)).toBe(30240);
    expect(multiplyDecimal(0, 12.5)).toBe(0);
  });
});
