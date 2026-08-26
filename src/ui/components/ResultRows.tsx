/**
 * Search results.
 *
 * Each row carries the four things needed to pick without opening it: the
 * name, the `codigo` and presentation, the book figure, and — the one that
 * saves a wasted walk — its current state. Searching an item a second time
 * shows it is already counted before anybody types.
 *
 * The two tiers are separated by a visible rule rather than by weight. Word
 * matches above, mid-word matches below: `EMPANADA DE MAIZ CARNE` really does
 * contain `pan`, and somebody looking for bread should not have to read past
 * it to find `PAN TAJADO`.
 */
import type { Item, Resolution } from '../../domain';
import { formatQty } from '../format';
import type { SearchHit } from '../search';
import { StateChip } from './StateChip';

const UNTOUCHED: Resolution = { state: 'untouched' };

export function ResultRows({
  hits,
  resolutions,
  onPick,
}: {
  hits: readonly SearchHit[];
  resolutions: ReadonlyMap<number, Resolution>;
  onPick: (item: Item) => void;
}) {
  const exact = hits.filter((hit) => hit.tier === 'prefix');
  const partial = hits.filter((hit) => hit.tier === 'partial');

  return (
    <>
      <Group hits={exact} resolutions={resolutions} onPick={onPick} />
      {partial.length > 0 && (
        <>
          <div className="divider">coincidencias parciales</div>
          <Group hits={partial} resolutions={resolutions} onPick={onPick} />
        </>
      )}
    </>
  );
}

function Group({
  hits,
  resolutions,
  onPick,
}: {
  hits: readonly SearchHit[];
  resolutions: ReadonlyMap<number, Resolution>;
  onPick: (item: Item) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <ul className="rows">
      {hits.map(({ item }) => (
        <li key={item.idarticulo}>
          <button type="button" className="row" onClick={() => onPick(item)}>
            <span className="row__main">
              <span className="row__nombre">{item.nombre}</span>
              <span className="row__meta">
                <span className="num">{item.codigo}</span> · {item.presentacion}
              </span>
            </span>
            <span className="row__right">
              <span className="row__existencia num">{formatQty(item.existencia)}</span>
              <br />
              <StateChip item={item} resolution={resolutions.get(item.idarticulo) ?? UNTOUCHED} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
