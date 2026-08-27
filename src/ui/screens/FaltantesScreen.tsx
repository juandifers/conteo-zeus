/**
 * Faltantes — what is still to count, in the order it should be counted.
 *
 * This screen is two things at once, which is why it is worth its own route:
 * it is the completeness check *and* it is the count route. Whatever does not
 * get counted before the clock runs out should be the least material thing in
 * the bodega, so the order of this list decides what gets left behind.
 *
 * **The order is the whole product here, because it is all that is left.** It
 * is `byExposicion` — `max(existencia, ultimoConteo) x costo`, descending —
 * and DOMAIN.md §5 is the reason it is not book value: 31 of the 298 rows are
 * perishables the ERP books at zero between purchases, so a value-ordered walk
 * sends everybody past the produce cooler last.
 *
 * Not one of those pesos reaches the screen. This is a surface a counter
 * counts from, so nothing the ERP believes may be printed on it — not the
 * exposure that ranks the row, not the book quantity, not the previous count
 * (DOMAIN.md §2.1). The ranking carries the materiality; the figures behind it
 * stay in the summary and surface on the review screen, which is a different
 * screen for a different person after the count is over.
 *
 * The figure the supervisor used to read here — `pendiente`, in pesos — is on
 * the review screen under `pendiente · en riesgo`, alongside the same list.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { summarizeSession, type Item } from '../../domain';
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
        <div className="total__label">sin contar</div>
        <div className="total__value num">{summary.pendiente.items}</div>
        <div className="total__note">
          de <span className="num">{summary.itemCount}</span> artículos · la lista va de lo más
          material a lo menos, así que cuenta de arriba hacia abajo
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
