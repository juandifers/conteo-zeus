/**
 * The variance, resolving live under the quantity as it is typed.
 *
 * The bar is the deliberate risk of this build. It is zero-centred: it grows
 * left in red for a shortage and right in blue for an overage, scaled against
 * the larger of the book figure and the count. Nothing on it is decorative —
 * the point is that "how wrong is this" arrives as a *shape*, before either
 * number has been read, so a keypad slip of an order of magnitude is caught
 * from arm's length in a cold room rather than after the fact in a variance
 * report.
 *
 * The scale is honest about the case DOMAIN.md §5 cares about: when the book
 * figure is zero — 31 of the 298 rows — anything found is entirely
 * unaccounted, and the bar goes to the stop.
 */
import { itemVariance, type Item, type Resolution } from '../../domain';
import { formatMoney, formatQty, formatSignedQty } from '../format';

export function VarianceReadout({
  item,
  resolution,
}: {
  item: Item;
  resolution: Resolution;
}) {
  const variance = itemVariance(item, resolution);

  if (!variance) {
    return (
      <div className="variance">
        <div className="variance__bar" aria-hidden="true">
          <div className="variance__zero" />
        </div>
        <div className="variance__line">
          <span className="hint">
            {resolution.state === 'unchanged'
              ? 'sin verificar — se acepta la cifra del sistema'
              : 'sin contar'}
          </span>
        </div>
      </div>
    );
  }

  const scale = Math.max(Math.abs(item.existencia), Math.abs(resolution.qty ?? 0), 1);
  const ratio = Math.min(1, Math.abs(variance.variance) / scale);
  const half = ratio * 50;
  const short = variance.varianceClass === 'shortage';
  const tone = variance.varianceClass === 'none' ? '' : short ? '--short' : '--over';

  return (
    <div className="variance">
      <div className="variance__bar" aria-hidden="true">
        <div className="variance__zero" />
        {variance.varianceClass !== 'none' && (
          <div
            className={`variance__fill variance__fill${tone}`}
            style={{ left: short ? `${50 - half}%` : '50%', width: `${half}%` }}
          />
        )}
      </div>
      <div className={`variance__line variance__line${tone}`} role="status">
        {variance.varianceClass === 'none' ? (
          <span>cuadra con el sistema</span>
        ) : (
          <>
            <span className="num">{formatSignedQty(variance.variance)}</span>
            <span>{short ? 'faltan' : 'sobran'}</span>
            <span className="variance__valor num">
              {formatMoney(Math.abs(variance.valorVariance))} COP
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** The book figure, printed beside the readout as a reference. */
export function Expected({ item }: { item: Item }) {
  return (
    <div className="readout__expected">
      <span className="readout__expected-label">sistema</span>
      <span className="readout__expected-value num">{formatQty(item.existencia)}</span>
    </div>
  );
}
