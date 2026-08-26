/**
 * Decimal arithmetic on JavaScript numbers, by scaling to integers.
 *
 * ZEUS_FORMAT.md §3 requires it: `21 - 20.8` in IEEE754 is
 * `0.20000000000000107`, and the shortest-representation rule would write that
 * 19-digit variance straight into the ERP. Addition matters just as much once
 * counting is done by tally — `0.1 + 0.2` accumulating to
 * `0.30000000000000004` is the same bug with a different sign.
 *
 * This module is the bottom of the dependency graph. It knows nothing about
 * Zeus and nothing about the domain; both are allowed to import it, and it
 * imports neither.
 *
 * Each operation scales its operands by 10^dp, does integer arithmetic, and
 * scales back. When scaling would leave the exactly-representable integer
 * range — which no realistic quantity does — it falls back to the plain float
 * operation rather than returning a silently wrong "exact" answer.
 */

/** Largest scale we will apply. 10^15 already exceeds Number.MAX_SAFE_INTEGER. */
const MAX_DP = 15;

/**
 * Decimal places in a value's shortest textual form, or `null` when the value
 * has no plain decimal form (NaN, Infinity, or exponential notation).
 *
 * `String(number)` is already the shortest decimal that round-trips to the
 * same double, which is exactly the §3 rule, so its fractional part is the
 * decimal the value *means*.
 */
function decimalPlaces(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  // JS switches to exponential at >=1e21 and <1e-6; there is no integer scale
  // that makes those exact.
  if (text.includes('e') || text.includes('E')) return null;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The common scale for a pair of operands, or `null` if they cannot be scaled. */
function commonScale(a: number, b: number): number | null {
  const dpA = decimalPlaces(a);
  const dpB = decimalPlaces(b);
  if (dpA === null || dpB === null) return null;
  const dp = Math.max(dpA, dpB);
  return dp > MAX_DP ? null : dp;
}

/** Scale to an integer, or `null` when the result would not be exact. */
function scaled(value: number, scale: number): number | null {
  const raw = value * scale;
  const rounded = Math.round(raw);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * `a + b`, on the decimal values rather than the binary doubles.
 *
 * The tally mode adds one tap at a time, so this is applied repeatedly to its
 * own output; plain `+` drifts, and §3's shortest-representation rule would
 * put the drift on the wire.
 */
export function addDecimal(a: number, b: number): number {
  const dp = commonScale(a, b);
  if (dp === null) return a + b;
  if (dp === 0) return a + b;

  const factor = 10 ** dp;
  const x = scaled(a, factor);
  const y = scaled(b, factor);
  if (x === null || y === null) return a + b;
  return (x + y) / factor;
}

/** `minuend - subtrahend`, on the decimal values rather than the binary doubles. */
export function subtractDecimal(minuend: number, subtrahend: number): number {
  const dp = commonScale(minuend, subtrahend);
  if (dp === null) return minuend - subtrahend;
  if (dp === 0) return minuend - subtrahend;

  const factor = 10 ** dp;
  const x = scaled(minuend, factor);
  const y = scaled(subtrahend, factor);
  if (x === null || y === null) return minuend - subtrahend;
  return (x - y) / factor;
}

/**
 * `a * b`, on the decimal values rather than the binary doubles.
 *
 * Both operands are scaled by their own decimal places, so the product is
 * exact when it fits. It often will not: a quantity at 1 dp times a `costo2`
 * at 13 dp needs 10^14 of headroom, and the fallback then applies. That is
 * fine for money aggregates, where the question is "how many million pesos",
 * but it is why quantities — not values — are what this module is here for.
 */
export function multiplyDecimal(a: number, b: number): number {
  const dpA = decimalPlaces(a);
  const dpB = decimalPlaces(b);
  if (dpA === null || dpB === null) return a * b;
  if (dpA === 0 && dpB === 0) return a * b;
  if (dpA + dpB > MAX_DP) return a * b;

  const x = scaled(a, 10 ** dpA);
  const y = scaled(b, 10 ** dpB);
  if (x === null || y === null) return a * b;
  const product = x * y;
  if (!Number.isSafeInteger(product)) return a * b;
  return product / 10 ** (dpA + dpB);
}
