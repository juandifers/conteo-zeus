/**
 * Search results.
 *
 * Each row carries what is needed to pick it without opening it: the name, the
 * `codigo` and presentation, and — the one that saves a wasted walk — its
 * state. Searching an item a second time shows it is already counted, and with
 * what quantity, before anybody types.
 *
 * There is no book figure in the right-hand column and there is no column: the
 * counter is not told what to expect on any surface they count from
 * (DOMAIN.md §2.1). What sat there was `existencia` for 298 rows at a glance,
 * which is the single largest thing this screen used to give away.
 *
 * The two tiers are separated by a visible rule rather than by weight. Word
 * matches above, mid-word matches below: `EMPANADA DE MAIZ CARNE` really does
 * contain `pan`, and somebody looking for bread should not have to read past
 * it to find `PAN TAJADO`.
 */
import type { Item, Resolution } from '../../domain';
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
              <StateChip resolution={resolutions.get(item.idarticulo) ?? UNTOUCHED} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
