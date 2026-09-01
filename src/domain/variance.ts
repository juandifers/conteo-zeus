/**
 * Variance and exposure — DOMAIN.md §2 and §5.
 */
import { multiplyDecimal, subtractDecimal } from '../lib/decimal.js';
import type { Item } from './types.js';
import type { Resolution } from './fold.js';

/**
 * Which way a counted item moved (DOMAIN.md §2).
 *
 * The second of the two orthogonal axes: verification state says whether
 * anybody looked, this says what they found. Keeping them apart is why there
 * is no `counted-zero` state — a shelf counted at zero against a book figure
 * of 79 is `counted` + `shortage`, and an empty shelf confirmed empty is
 * `counted` + `none`. One enum spanning both loses that.
 */
export type VarianceClass = 'none' | 'shortage' | 'overage';

export interface Variance {
  /** `qty - existencia`, decimal. Positive = more on the shelf than the ERP believes. */
  variance: number;
  /** Direction, derived. `none` when the count matched exactly. */
  varianceClass: VarianceClass;
  /** `variance x costo`, in pesos. Signed. */
  valorVariance: number;
  /** `|valorVariance|`. What ranks the review queue: size, not direction. */
  materialidad: number;
}

/**
 * The variance of one item, or `null` when there is none to state.
 *
 * `unchanged` and `untouched` return `null` — **not** a zero variance. §2 and
 * §5 both depend on it: "someone looked and nothing moved" and "nobody went"
 * are equally quantity-free, but only one may post, and neither is evidence
 * that the book figure is right. A zero here would fold both into the same row
 * as a genuine count that matched, and the waived value — the figure §5
 * requires on screen before posting — would fall to zero with them.
 */
export function itemVariance(item: Item, resolution: Resolution): Variance | null {
  if (resolution.qty === undefined) return null;
  if (resolution.state !== 'counted') return null;

  const variance = subtractDecimal(resolution.qty, item.existencia);
  const valorVariance = multiplyDecimal(variance, item.costo);
  return {
    variance,
    varianceClass: classify(variance),
    valorVariance,
    materialidad: Math.abs(valorVariance),
  };
}

function classify(variance: number): VarianceClass {
  if (variance < 0) return 'shortage';
  if (variance > 0) return 'overage';
  return 'none';
}

/** Book value of an item: `existencia x costo`. The accounting figure (§5). */
export function bookValue(item: Item): number {
  return multiplyDecimal(item.existencia, item.costo);
}

/**
 * The quantity an unverified row might actually be holding: the larger of the
 * book figure and the last count (DOMAIN.md §5).
 *
 * `ultimoConteo` is used only when it is above zero. A prior of zero says the
 * shelf was empty last time, which is no evidence that it is holding anything
 * now — and `max` would return `existencia` anyway, so the guard is about
 * intent, not arithmetic.
 */
export function exposureQuantity(item: Item): number {
  const prior = item.ultimoConteo;
  return prior !== null && prior > 0 ? Math.max(item.existencia, prior) : item.existencia;
}

/**
 * `exposureQuantity x costo` — how much value an unverified row *could* be
 * hiding, as opposed to how much the books say it holds.
 *
 * The distinction is not academic here: 31 of the 298 sample rows are
 * perishables booked at zero between purchases, so their book value is nothing
 * and their exposure is 6.24M COP. An estimate, never a valuation — the prior
 * is of unknown age (§5).
 */
export function exposureValue(item: Item): number {
  return multiplyDecimal(exposureQuantity(item), item.costo);
}
