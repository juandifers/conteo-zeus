/**
 * Faltantes — the untouched items, ordered by exposure.
 *
 * This screen is two things at once, which is why it is worth its own route:
 * it is the completeness check *and* it is the count route. Whatever does not
 * get counted before the clock runs out should be the least material thing in
 * the bodega, so the order of this list decides what gets left behind.
 *
 * Both figures on this screen are scoped to `pendiente` — over `untouched`
 * only — because this is the work list. A waived row is not somewhere anybody
 * still has to walk to, so it leaves this screen. The figure that does *not*
 * fall when somebody signs a waiver is `sinVerificar`, and it belongs on the
 * review screen, where the question is what the count is worth rather than
 * what is left of it (DOMAIN.md §5).
 *
 * The order is `byExposicion`, not book value, and DOMAIN.md §5 is the reason:
 * 31 of the 298 rows are perishables the ERP books at zero between purchases,
 * so a value-ordered walk sends everybody past the produce cooler last. Both
 * figures are on screen because they answer different questions — finance
 * wants the book total, the supervisor deciding where to send people needs the
 * exposure.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { summarizeSession, type Item } from '../../domain';
import { formatMoney, formatMoneyShort, formatQty } from '../format';
import type { CountStore } from '../store';

export function FaltantesScreen({
  store,
  onBack,
  onCount,
}: {
  store: CountStore;
  onBack: () => void;
  onCount: (item: Item) => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { session, events } = snapshot;
  const summary = useMemo(() => summarizeSession(session, events), [session, events]);

  // The rows §5 is about: nothing in the books, something on the shelf.
  const invisible = summary.byExposicion.filter(
    (row) => row.valor === 0 && row.exposicion > 0,
  );

  return (
    <div className="screen">
      <div className="topbar">
        <button type="button" className="entry__close" aria-label="volver" onClick={onBack}>
          ‹
        </button>
        <div className="topbar__where">
          <div className="topbar__bodega">Faltantes</div>
          <div className="topbar__corte">
            <span className="num">{summary.counts.untouched}</span> sin contar de{' '}
            <span className="num">{summary.itemCount}</span>
          </div>
        </div>
      </div>

      <div className="total">
        <div className="total__label">en riesgo sin verificar</div>
        <div className="total__value num">
          {formatMoney(summary.pendiente.exposicion)} <span className="total__note">COP</span>
        </div>
        <div className="total__note">
          valor en libros <span className="num">{formatMoney(summary.pendiente.valor)}</span> COP
          {invisible.length > 0 && (
            <>
              {' '}· <span className="num">{invisible.length}</span> artículos valen 0 en libros y{' '}
              <span className="num">
                {formatMoneyShort(
                  invisible.reduce((total, row) => total + row.exposicion, 0),
                )}
              </span>{' '}
              por su último conteo
            </>
          )}
        </div>
      </div>

      <div className="scroll">
        {summary.byExposicion.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No queda nada pendiente</div>
            <div className="empty__body">
              Todos los artículos de esta bodega tienen un conteo o una exención firmada.
            </div>
          </div>
        ) : (
          <ul className="rows">
            {summary.byExposicion.map((row, rank) => (
              <li key={row.item.idarticulo}>
                <button type="button" className="row" onClick={() => onCount(row.item)}>
                  <span className="rank num">{rank + 1}</span>
                  <span className="row__main">
                    <span className="row__nombre">{row.item.nombre}</span>
                    <span className="row__meta">
                      <span className="num">{row.item.codigo}</span> · {row.item.presentacion}
                      {row.valor === 0 && row.exposicion > 0 && ' · sin existencia en libros'}
                    </span>
                  </span>
                  <span className="row__right">
                    <span className="row__existencia num">{formatMoney(row.exposicion)}</span>
                    <br />
                    <span className="chip">
                      sistema <span className="num">{formatQty(row.item.existencia)}</span>
                      {row.item.ultimoConteo !== null && (
                        <>
                          {' '}· antes <span className="num">{formatQty(row.item.ultimoConteo)}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
