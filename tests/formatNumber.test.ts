import { describe, it, expect } from 'vitest';
import { formatNumber, parseNumber, formatExcelGeneral } from '../src/zeus/formatNumber';

describe('formatNumber (§3)', () => {
  it('writes integers without a decimal point', () => {
    expect(formatNumber(10)).toBe('10');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-1)).toBe('-1'); // the "not applicable" sentinel
    expect(formatNumber(14900)).toBe('14900');
    expect(formatNumber(1272)).toBe('1272');
  });

  it('drops trailing zeros', () => {
    expect(formatNumber(20.8)).toBe('20.8');
    expect(formatNumber(20.8)).not.toBe('20.80');
    expect(formatNumber(97.5)).toBe('97.5');
    expect(formatNumber(113.1)).toBe('113.1');
    expect(formatNumber(0.5)).toBe('0.5');
  });

  it('uses no thousands separator', () => {
    expect(formatNumber(1234567.5)).toBe('1234567.5');
  });

  it('keeps full precision for costs (up to 13 dp, §2)', () => {
    expect(formatNumber(3990.626866)).toBe('3990.626866');
    expect(formatNumber(3990.62686567164)).toBe('3990.62686567164');
    expect(formatNumber(2310.04758241758)).toBe('2310.04758241758');
    expect(formatNumber(15676.1925)).toBe('15676.1925');
  });

  it('normalises -0 to 0', () => {
    expect(formatNumber(-0)).toBe('0');
    // A count equal to the existencia must produce "0", not "-0".
    expect(formatNumber(97.5 - 97.5)).toBe('0');
  });

  it('emits a leading zero for values below 1', () => {
    expect(formatNumber(0.25)).toBe('0.25');
    expect(formatNumber(-0.25)).toBe('-0.25');
  });

  it('refuses values it cannot write without exponential notation', () => {
    expect(() => formatNumber(1e21)).toThrowError(/exponential/);
    expect(() => formatNumber(1e-7)).toThrowError(/exponential/);
    expect(() => formatNumber(NaN)).toThrowError(/not a number/);
    expect(() => formatNumber(Infinity)).toThrowError(/not finite/);
  });

  it('round-trips through parseNumber', () => {
    for (const v of [0, -1, 10, 20.8, 97.5, 3990.62686567164, 0.001, 1271.6666666667]) {
      expect(parseNumber(formatNumber(v), 'test')).toBe(v);
    }
  });
});

describe('parseNumber', () => {
  it('rejects anything that is not a bare Zeus number', () => {
    for (const bad of ['', ' 1', '1 ', '1,5', '1.2.3', 'abc', '1e5', '+1', '--1', '0x10']) {
      expect(() => parseNumber(bad, 'row 1 field costo')).toThrowError(/row 1 field costo/);
    }
  });

  it('accepts the forms that appear in the sample', () => {
    expect(parseNumber('0', 'c')).toBe(0);
    expect(parseNumber('-1', 'c')).toBe(-1);
    expect(parseNumber('20.8', 'c')).toBe(20.8);
    expect(parseNumber('3990.62686567164', 'c')).toBe(3990.62686567164);
  });
});

describe('formatExcelGeneral (discovered, see formatNumber.ts)', () => {
  it('leaves values of 11 characters or fewer alone', () => {
    expect(formatExcelGeneral(20.8)).toBe('20.8');
    expect(formatExcelGeneral(14900)).toBe('14900');
    expect(formatExcelGeneral(3990.626866)).toBe('3990.626866'); // exactly 11
    expect(formatExcelGeneral(15676.1925)).toBe('15676.1925');
  });

  it('caps longer values at 11 characters, as Excel does', () => {
    expect(formatExcelGeneral(12333.333333)).toBe('12333.33333');
    expect(formatExcelGeneral(16694.444444)).toBe('16694.44444');
    expect(formatExcelGeneral(124978.730909)).toBe('124978.7309');
    expect(formatExcelGeneral(3990.62686567164)).toBe('3990.626866');
  });

  it('rounds the decimal half-up, not the binary double', () => {
    // toFixed(5) on this double yields ...38545; Excel yields ...38546.
    expect(formatExcelGeneral(14243.385455)).toBe('14243.38546');
    expect(formatExcelGeneral(22185.185185)).toBe('22185.18519');
    expect(formatExcelGeneral(12104.680595)).toBe('12104.6806'); // trailing zero stripped
  });

  it('handles carry across the decimal point', () => {
    expect(formatExcelGeneral(9.99999999999)).toBe('10');
    expect(formatExcelGeneral(99999.999999999)).toBe('100000');
  });

  it('accounts for the sign in the width budget', () => {
    expect(formatExcelGeneral(-12333.333333)).toBe('-12333.3333');
  });
});
