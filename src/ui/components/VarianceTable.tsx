/**
 * The variance table.
 *
 * The one screen in this product where a table is right. The counting screen
 * is a tablet held in one hand in a cold room and everything on it is a card;
 * this is a laptop on a desk and the person reading it wants density — every
 * row, sortable, comparable, and the whole ranking visible at once.
 *
 * Ranked by `materialidad` by default, which is the screen's actual argument:
 * a supervisor opens this to find out where the money went, and the answer is
 * the top rows by |variance x costo|, not a strip of totals.
 *
 * Same two colours as everywhere else, carrying the same one meaning: red is
 * short, blue is over, a match gets no colour at all.
 */
import { useState } from 'react';
import type { CountEvent, ItemSummary } from '../../domain';
import { formatInstant, formatMoney, formatQty, formatSignedQty } from '../format';

export type SortKey = 'impacto' | 'nombre' | 'sistema' | 'conteo' | 'diferencia';

interface Sort {
  key: SortKey;
  /** `-1` descending, `1` ascending. */
  dir: -1 | 1;
}

/** Numbers open big-first; a name opens A-first. Nobody wants Z. */
const OPENS: Record<SortKey, -1 | 1> = {
  impacto: -1,
  nombre: 1,
  sistema: -1,
  conteo: -1,
  diferencia: -1,
};

function valueOf(row: ItemSummary, key: SortKey): number | string {
  switch (key) {
    case 'nombre':
      return `${row.item.nombre} ${row.item.presentacion}`;
    case 'sistema':
      return row.item.existencia;
    case 'conteo':
      return row.qty ?? Number.NEGATIVE_INFINITY;
    case 'diferencia':
      return row.variance?.variance ?? Number.NEGATIVE_INFINITY;
    case 'impacto':
      return row.variance?.materialidad ?? Number.NEGATIVE_INFINITY;
  }
}

function sortRows(rows: readonly ItemSummary[], sort: Sort): ItemSummary[] {
  return rows.slice().sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);
    const order =
      typeof left === 'string'
        ? left.localeCompare(right as string, 'es')
        : left - (right as number);
    // idarticulo breaks every tie, so the same count always draws the same
    // table — a ranking that reshuffles between two readings of one screen is
    // a ranking nobody can quote in a meeting.
    return order * sort.dir || a.item.idarticulo - b.item.idarticulo;
  });
}

/** The word for a variance direction. Never `faltante` — that means uncounted. */
function directionOf(row: ItemSummary): { label: string; className: string } {
  if (row.state === 'unchanged') return { label: 'sin cambio', className: '' };
  switch (row.variance?.varianceClass) {
    case 'shortage':
      return { label: 'menos', className: 'grid--short' };
    case 'overage':
      return { label: 'más', className: 'grid--over' };
    default:
      return { label: 'coincide', className: '' };
  }
}

export function VarianceTable({
  rows,
  lastEvents,
  limit,
  caption,
}: {
  rows: readonly ItemSummary[];
  /** The most recent event per item — who last touched the row, and when. */
  lastEvents: ReadonlyMap<number, CountEvent>;
  /** How many rows to draw. The rest are counted, not hidden silently. */
  limit?: number;
  caption: string;
}) {
  const [sort, setSort] = useState<Sort>({ key: 'impacto', dir: -1 });
  const ordered = sortRows(rows, sort);
  const shown = limit === undefined ? ordered : ordered.slice(0, limit);

  function header(key: SortKey, label: string, numeric = true) {
    const active = sort.key === key;
    return (
      <th scope="col" className={numeric ? 'grid__n' : undefined} aria-sort={
        active ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none'
      }>
        <button
          type="button"
          className="grid__sort"
          onClick={() =>
            setSort(
              active ? { key, dir: (sort.dir * -1) as -1 | 1 } : { key, dir: OPENS[key] },
            )
          }
        >
          {label}
          <span aria-hidden="true" className="grid__arrow">
            {active ? (sort.dir === -1 ? '▼' : '▲') : ''}
          </span>
        </button>
      </th>
    );
  }

  return (
    <table className="grid">
      <caption className="grid__caption">{caption}</caption>
      <thead>
        <tr>
          <th scope="col" className="grid__rank">
            #
          </th>
          {header('nombre', 'artículo', false)}
          {header('sistema', 'sistema')}
          {header('conteo', 'conteo')}
          {header('diferencia', 'diferencia')}
          {header('impacto', 'impacto COP')}
        </tr>
      </thead>
      <tbody>
        {shown.map((row, rank) => {
          const direction = directionOf(row);
          const last = lastEvents.get(row.item.idarticulo);
          return (
            <tr key={row.item.idarticulo} className={direction.className}>
              <td className="grid__rank num">{rank + 1}</td>
              <th scope="row" className="grid__name">
                <span className="grid__nombre">{row.item.nombre}</span>
                <span className="grid__meta">
                  <span className="num">{row.item.codigo}</span> · {row.item.presentacion}
                </span>
                {last && (
                  <span className="grid__meta">
                    {last.usuario || 'sin nombre'} · {formatInstant(last.at)}
                    {last.kind === 'unchanged' && last.motivo ? ` · ${last.motivo}` : ''}
                  </span>
                )}
              </th>
              <td className="grid__n num">{formatQty(row.item.existencia)}</td>
              <td className="grid__n num">
                {row.state === 'counted' ? formatQty(row.qty!) : '—'}
              </td>
              <td className="grid__n num">
                {row.variance ? formatSignedQty(row.variance.variance) : '—'}
                <span className="grid__dir">{direction.label}</span>
              </td>
              <td className="grid__n num grid__impacto">
                {row.variance ? formatMoney(row.variance.valorVariance) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
