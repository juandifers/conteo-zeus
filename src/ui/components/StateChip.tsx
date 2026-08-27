/**
 * What happened to this item, in one chip.
 *
 * Three states and the counter's own quantity — never a variance, because a
 * variance is `existencia` arrived at by subtraction and no counting surface
 * may put that on screen (DOMAIN.md §2.1). `faltan 12,5` used to live here.
 *
 * Which leaves this file with no colour at all: colour on a counting screen
 * meant shortage or overage, and neither is a thing the counter is told. Red
 * appears for the first time on the review screen, after the count is over.
 */
import type { Resolution } from '../../domain';
import { formatQty } from '../format';

export function StateChip({ resolution }: { resolution: Resolution }) {
  if (resolution.state === 'untouched') {
    return <span className="chip">pendiente</span>;
  }
  if (resolution.state === 'unchanged') {
    return <span className="chip chip--unchanged">sin verificar</span>;
  }
  return (
    <span className="chip chip--counted">
      contado <span className="num">{formatQty(resolution.qty ?? 0)}</span>
    </span>
  );
}
