/**
 * The supervisor's bulk waiver — the only route to generating a file from an
 * incomplete count (DOMAIN.md §4).
 *
 * `uncountedPolicy: 'existencia'` would produce the same bytes with nobody's
 * name on them, which is why `exportAdjustment` does not expose it. Everything
 * on this panel exists to make the claim explicit before it is signed: what is
 * being waived, what it is worth, who is signing, and why.
 *
 * The `motivo` is required here and refused on the counter's waiver (§3). One
 * action covering two hundred rows is a much larger claim than one person
 * skipping one shelf.
 *
 * Ordered by exposure, not book value, and showing both: 31 of the 298 sample
 * rows are perishables the ERP books at zero, so a book-value list would put
 * 1,4M of melón at the bottom under a `0` (§5). A supervisor waiving melón
 * should read the word melón.
 */
import { useState } from 'react';
import type { UnverifiedItem } from '../../domain';
import { formatMoney, formatQty } from '../format';

/** How many are named in the sentence above the signature. */
const NAMED = 3;

export function BulkWaiver({
  rows,
  usuario,
  onUsuario,
  onWaive,
  onCancel,
}: {
  /** Untouched items, by exposure descending. */
  rows: readonly UnverifiedItem[];
  usuario: string;
  onUsuario: (usuario: string) => void;
  onWaive: (idarticulos: number[], motivo: string) => void;
  onCancel: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(rows.map((row) => row.item.idarticulo)),
  );

  const chosen = rows.filter((row) => selected.has(row.item.idarticulo));
  const exposicion = chosen.reduce((total, row) => total + row.exposicion, 0);
  const valor = chosen.reduce((total, row) => total + row.valor, 0);
  const named = chosen.slice(0, NAMED).map((row) => row.item.nombre);
  const ready = chosen.length > 0 && motivo.trim().length > 0 && usuario.trim().length > 0;

  function toggle(idarticulo: number): void {
    const next = new Set(selected);
    if (!next.delete(idarticulo)) next.add(idarticulo);
    setSelected(next);
  }

  return (
    <section className="panel" aria-label="exentar artículos sin contar">
      <h2 className="panel__title">Exentar artículos sin contar</h2>
      <p className="panel__body">
        Firmar una exención dice que el saldo del sistema es el bueno. Los artículos
        exentos salen en el archivo con la existencia que Zeus ya tiene, y quedan en el
        registro con tu nombre y la hora.
      </p>

      <div className="panel__figures">
        <div>
          <div className="total__label">en riesgo</div>
          <div className="total__value num">{formatMoney(exposicion)}</div>
          <div className="total__note">
            valor en libros <span className="num">{formatMoney(valor)}</span> COP
          </div>
        </div>
        <div>
          <div className="total__label">artículos</div>
          <div className="total__value num">{chosen.length}</div>
          <div className="total__note">
            de <span className="num">{rows.length}</span> sin contar
          </div>
        </div>
      </div>

      <div className="checklist" role="group" aria-label="artículos por exentar">
        <button
          type="button"
          className="btn btn--small"
          onClick={() =>
            setSelected(
              chosen.length === rows.length
                ? new Set()
                : new Set(rows.map((row) => row.item.idarticulo)),
            )
          }
        >
          {chosen.length === rows.length ? 'Quitar todos' : 'Marcar todos'}
        </button>
        <ul className="rows">
          {rows.map((row) => (
            <li key={row.item.idarticulo}>
              <label className="checkrow">
                <input
                  type="checkbox"
                  checked={selected.has(row.item.idarticulo)}
                  onChange={() => toggle(row.item.idarticulo)}
                />
                <span className="row__main">
                  <span className="row__nombre">{row.item.nombre}</span>
                  <span className="row__meta">
                    <span className="num">{row.item.codigo}</span> · {row.item.presentacion} ·
                    sistema <span className="num">{formatQty(row.item.existencia)}</span>
                    {row.item.ultimoConteo !== null && (
                      <>
                        {' '}
                        · antes <span className="num">{formatQty(row.item.ultimoConteo)}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="row__right">
                  <span className="row__existencia num">{formatMoney(row.exposicion)}</span>
                  {row.valor === 0 && row.exposicion > 0 && (
                    <span className="chip">sin existencia en libros</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <label className="field">
        <span className="field__label">Motivo — obligatorio</span>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="por qué no se contaron"
          aria-label="motivo"
        />
      </label>

      <label className="field">
        <span className="field__label">Quién autoriza</span>
        <input
          value={usuario}
          onChange={(e) => onUsuario(e.target.value)}
          placeholder="nombre"
          aria-label="quién autoriza"
        />
      </label>

      <div className="confirm">
        <p className="confirm__text">
          Vas a firmar <span className="num">{chosen.length}</span> exenciones por{' '}
          <span className="num">{formatMoney(exposicion)}</span> COP en riesgo
          {named.length > 0 && <>, entre ellas {named.join(', ')}</>}.
        </p>
        <div className="actions__pair">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!ready}
            onClick={() =>
              onWaive(
                chosen.map((row) => row.item.idarticulo),
                motivo,
              )
            }
          >
            Firmar exención
          </button>
        </div>
        {!ready && (
          <p className="hint">
            {chosen.length === 0
              ? 'Marca al menos un artículo.'
              : motivo.trim().length === 0
                ? 'Escribe el motivo: una exención sin motivo no se puede firmar.'
                : 'Escribe quién autoriza.'}
          </p>
        )}
      </div>
    </section>
  );
}
