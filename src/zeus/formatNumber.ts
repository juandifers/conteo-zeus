/**
 * Zeus number formatting (ZEUS_FORMAT.md §3).
 *
 * This module is load-bearing: it is the reason the .txt round-trip can be
 * byte-exact. Every numeric field written back into a Zeus .txt goes through
 * `formatNumber`.
 */

/**
 * Convert a number to Zeus's exact textual form: shortest representation,
 * `.` as decimal separator, no thousands separator, no trailing zeros,
 * integers with no decimal point.
 *
 * JavaScript's own `String(number)` already produces the shortest decimal that
 * round-trips to the same double, which is precisely the §3 rule. The guards
 * below reject the cases where it would deviate.
 */
export function formatNumber(value: number): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Cannot format ${String(value)} as a Zeus number: not a number`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot format ${String(value)} as a Zeus number: not finite`);
  }
  // -0 is still zero on the wire; Zeus never writes "-0".
  if (Object.is(value, -0)) return '0';

  const text = String(value);
  // JS switches to exponential notation at >=1e21 and <1e-6. Zeus has no
  // notation for either, so emitting one would produce a file Zeus mis-ingests.
  if (text.includes('e') || text.includes('E')) {
    throw new Error(
      `Cannot format ${text} as a Zeus number: value is outside the range Zeus ` +
        'can represent without exponential notation',
    );
  }
  return text;
}

/**
 * Parse a Zeus numeric field. Strict: only the forms §3 permits.
 *
 * `context` is used to make failures locatable (row / field).
 */
export function parseNumber(text: string, context: string): number {
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    throw new Error(`${context}: ${JSON.stringify(text)} is not a valid Zeus number`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`${context}: ${JSON.stringify(text)} does not parse to a finite number`);
  }
  return value;
}

/**
 * Round a *decimal* string half-away-from-zero to `dp` places, then strip
 * trailing zeros.
 *
 * Deliberately string-based rather than `toFixed`: `toFixed` rounds the binary
 * double, so 14243.385455 rounds down to "14243.38545" where Excel — which
 * rounds the decimal it displays — gives "14243.38546".
 */
function roundDecimalString(text: string, dp: number): string {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = unsigned.split('.');

  let result: string;
  if (fracPart.length <= dp) {
    result = fracPart ? `${intPart}.${fracPart}` : intPart;
  } else {
    const digits = (intPart + fracPart.slice(0, dp)).split('');
    const nextDigit = fracPart.charCodeAt(dp) - 48;
    if (nextDigit >= 5) {
      let i = digits.length - 1;
      for (; i >= 0; i--) {
        if (digits[i] === '9') {
          digits[i] = '0';
        } else {
          digits[i] = String(Number(digits[i]) + 1);
          break;
        }
      }
      if (i < 0) digits.unshift('1');
    }
    const all = digits.join('');
    const cut = all.length - dp;
    result = dp > 0 ? `${all.slice(0, cut) || '0'}.${all.slice(cut)}` : all;
  }

  if (result.includes('.')) {
    result = result.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (result === '' || result === '-') result = '0';
  return negative && Number(result) !== 0 ? `-${result}` : result;
}

/**
 * Render a number the way Excel's "General" format does when a workbook is
 * saved as Text (MS-DOS).
 *
 * NOT in the spec. Discovered from the samples: §3 describes the .txt numbers
 * as plain shortest-representation, but 54 of the 298 `costo` values in
 * COMESTIBLES ALMACEN.txt are *shorter* than the corresponding .xls value —
 * e.g. .xls 12333.333333 -> .txt "12333.33333". Excel's General format caps
 * output at 11 characters and rounds the decimal to fit. Applying that rule
 * reproduces all 298 `costo` values from the .xls exactly.
 *
 * Used when synthesising a .txt row from .xls cells (parseXls), and available
 * to writeTxt via `numberFormat: 'excelGeneral'`. It is NOT the default for
 * writeTxt, because §3's stated rule is plain shortest representation.
 */
export function formatExcelGeneral(value: number, width = 11): string {
  const shortest = formatNumber(value);
  if (shortest.length <= width) return shortest;

  const negative = value < 0;
  const magnitude = Math.abs(value);
  const intDigits = magnitude >= 1 ? Math.floor(Math.log10(magnitude)) + 1 : 1;
  // width = intDigits + "." + dp (+ "-")
  const dp = Math.max(0, width - intDigits - 1 - (negative ? 1 : 0));
  return roundDecimalString(shortest, dp);
}
