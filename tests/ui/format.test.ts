/**
 * Numbers in and numbers out.
 *
 * The interesting half is entry. Colombia writes `1.234,5`; an Android
 * keyboard offers whichever separator its own locale feels like; and a
 * warehouse quantity is typed under time pressure with gloves on. So the rule
 * is narrow on purpose — see `parseQty`.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney, formatQty, formatSignedQty, parseQty } from '../../src/ui/format';

describe('parseQty', () => {
  it('takes either separator as the decimal point', () => {
    expect(parseQty('97,5')).toBe(97.5);
    expect(parseQty('97.5')).toBe(97.5);
    expect(parseQty('0,25')).toBe(0.25);
  });

  it('never reads a separator as thousands', () => {
    // The whole point: `1.234` is one and a bit. Guessing wrongly here writes a
    // count three orders of magnitude out into the ERP, and nothing downstream
    // can tell. The largest balance in the sample is 29 400, typed without one.
    expect(parseQty('1.234')).toBe(1.234);
    expect(parseQty('1.234,5')).toBeNull();
    expect(parseQty('29400')).toBe(29_400);
  });

  it('rejects anything that is not a plain positive quantity', () => {
    expect(parseQty('')).toBeNull();
    expect(parseQty('   ')).toBeNull();
    expect(parseQty('-4')).toBeNull();
    expect(parseQty('12 kg')).toBeNull();
    expect(parseQty('.')).toBeNull();
    expect(parseQty('1e3')).toBeNull();
  });

  it('takes a bare zero, because a confirmed-empty shelf is a count', () => {
    expect(parseQty('0')).toBe(0);
    expect(parseQty('0,0')).toBe(0);
  });
});

describe('display', () => {
  it('is Colombian', () => {
    expect(formatQty(1234.5)).toBe('1.234,5');
    expect(formatMoney(6_244_684.3)).toBe('6.244.684');
  });

  it('always shows the direction of a variance', () => {
    expect(formatSignedQty(-12.5)).toBe('-12,5');
    expect(formatSignedQty(3)).toBe('+3');
    expect(formatSignedQty(0)).toBe('0');
  });

  it('drops trailing zeros a scale would print', () => {
    expect(formatQty(97.5)).toBe('97,5');
    expect(formatQty(60)).toBe('60');
  });
});
