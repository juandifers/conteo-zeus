/**
 * What happened to this item, in one chip.
 *
 * The two axes of DOMAIN.md §2 are rendered as one label deliberately: a
 * counter does not need "counted, shortage", they need "faltan 12,5". The
 * axes stay apart in the model, where the distinction has consequences, and
 * collapse only at the glass.
 *
 * Colour appears here only for a variance direction. `pendiente` and
 * `sin verificar` are shape and weight — a dashed border for a waiver — so
 * that red on this screen always means one thing.
 */
import { itemVariance, type Item, type Resolution } from '../../domain';
import { formatQty } from '../format';

export function StateChip({ item, resolution }: { item: Item; resolution: Resolution }) {
  if (resolution.state === 'untouched') {
    return <span className="chip">pendiente</span>;
  }
  if (resolution.state === 'unchanged') {
    return <span className="chip chip--unchanged">sin verificar</span>;
  }

  const variance = itemVariance(item, resolution);
  if (!variance || variance.varianceClass === 'none') {
    return <span className="chip chip--counted">cuadra</span>;
  }
  const short = variance.varianceClass === 'shortage';
  return (
    <span className={`chip ${short ? 'chip--short' : 'chip--over'}`}>
      {short ? 'faltan ' : 'sobran '}
      <span className="num">{formatQty(Math.abs(variance.variance))}</span>
    </span>
  );
}
