/**
 * One row per catalogue article — P2.4 §2.
 *
 * The screen the jefe de costos will recognise as something the printed-Excel
 * process cannot do: 2 400 rows, every one of them priced, ranked by what its
 * variance is worth, with the reason a row is near the top written beside it.
 *
 * **Ranked by exposure of the variance, descending.** Not by `codigo`, not by
 * book value. The count route is ordered this way for the reason DOMAIN.md §5
 * gives — 31 of the sample's rows are perishables booked at zero, so a
 * value-ordered list puts the family most likely to be holding unrecorded stock
 * at the bottom — and the review inherits it. A row nobody counted carries the
 * whole row as its exposure, because the whole row is unverified.
 *
 * **Virtualised**, because 2 400 rows is the sample bodega and real ones are
 * larger. The window is computed from the container's declared height rather
 * than a measured one: a measured height is zero until layout, which is a table
 * that renders nothing on first paint and nothing at all in a test.
 *
 * Nothing here is editable. Editing a count from the admin screen is not
 * deferred, it is refused: the count is what somebody saw, and a number typed at
 * a desk would be entered under a counter's identity or under none.
 */
import { useState } from 'react';

import type { ReviewFlag, ReviewRow } from '../../domain';
import { describeFlag } from './blockers';
import { formatMoney, formatQty, formatSignedQty } from '../format';

/** Row height in the virtual window. Must match `.grid--virtual tbody tr` in CSS. */
const ROW_HEIGHT = 58;

/** How many rows to draw above and below the window, so a fast scroll is not blank. */
const OVERSCAN = 6;

function directionClass(row: ReviewRow): string {
  if (row.diferencia === null || row.diferencia === 0) return '';
  return row.diferencia < 0 ? 'grid--short' : 'grid--over';
}

/** The word for what happened to a row. Never `faltante` for a variance. */
function stateLabel(row: ReviewRow): string {
  switch (row.state) {
    case 'counted':
      return 'contado';
    case 'unchanged':
      return 'exonerado';
    case 'untouched':
      return 'sin contar';
  }
}

/** A flag's key, so React can list them without an index. */
function flagKey(flag: ReviewFlag): string {
  return flag.kind === 'outlier' ? `outlier-${flag.motivo}` : flag.kind;
}

export function Aggregate({
  rows,
  height = 620,
  onToggle,
  chosen,
  compartido = false,
}: {
  rows: readonly ReviewRow[];
  /** The scroll window, in pixels. Declared rather than measured — see above. */
  height?: number;
  /** Selecting a row for a waiver. Absent when nothing can be waived. */
  onToggle?: (idarticulo: number) => void;
  chosen?: ReadonlySet<number>;
  /** A shared session (P2.6): overlap flags read as normal, not as a breach. */
  compartido?: boolean;
}) {
  const [top, setTop] = useState(0);

  const perScreen = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const window = rows.slice(first, first + perScreen);
  const before = first * ROW_HEIGHT;
  const after = Math.max(0, (rows.length - first - window.length) * ROW_HEIGHT);

  return (
    <div
      className="gridscroll"
      style={{ height, overflowY: 'auto' }}
      onScroll={(event) => setTop((event.target as HTMLElement).scrollTop)}
      data-rows={rows.length}
    >
      <table className="grid grid--virtual">
        <caption className="grid__caption">
          {`${rows.length} artículos · por exposición de la diferencia`}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="grid__name">
              artículo
            </th>
            <th scope="col" className="grid__n">
              sistema
            </th>
            <th scope="col" className="grid__n">
              conteo
            </th>
            <th scope="col" className="grid__n">
              diferencia
            </th>
            <th scope="col" className="grid__n">
              exposición COP
            </th>
          </tr>
        </thead>
        <tbody>
          {before > 0 && (
            <tr aria-hidden="true" className="grid__spacer">
              <td colSpan={5} style={{ height: before, padding: 0 }} />
            </tr>
          )}
          {window.map((row) => (
            <tr key={row.item.idarticulo} className={directionClass(row)}>
              <th scope="row" className="grid__name">
                <span className="grid__nombre">
                  {onToggle && row.state !== 'counted' ? (
                    <label className="grid__pick">
                      <input
                        type="checkbox"
                        checked={chosen?.has(row.item.idarticulo) ?? false}
                        onChange={() => onToggle(row.item.idarticulo)}
                        aria-label={`elegir ${row.item.nombre}`}
                      />{' '}
                      {row.item.nombre}
                    </label>
                  ) : (
                    row.item.nombre
                  )}
                </span>
                <span className="grid__meta">
                  <span className="num">{row.item.codigo}</span> · {row.item.presentacion} ·{' '}
                  {stateLabel(row)}
                  {row.contadores.length > 0 ? ` · ${row.contadores.join(', ')}` : ''}
                  {row.entradas > 0 ? ` · ${row.entradas} registros` : ''}
                </span>
                {row.flags.map((flag) => (
                  <span className="grid__flag" key={flagKey(flag)}>
                    {describeFlag(flag, { compartido })}
                  </span>
                ))}
              </th>
              <td className="grid__n num">{formatQty(row.item.existencia)}</td>
              <td className="grid__n num">
                {row.conteo === undefined ? '—' : formatQty(row.conteo)}
              </td>
              <td className="grid__n num">
                {row.diferencia === null ? '—' : formatSignedQty(row.diferencia)}
              </td>
              <td className="grid__n num grid__impacto">{formatMoney(row.exposicion)}</td>
            </tr>
          ))}
          {after > 0 && (
            <tr aria-hidden="true" className="grid__spacer">
              <td colSpan={5} style={{ height: after, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
