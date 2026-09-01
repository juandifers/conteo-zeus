/**
 * «Mis registros» — where a correction happens.
 *
 * A separate tab, reached deliberately, and the separation from the entry
 * screen is the whole design: the blind rule protects the *act of counting*,
 * not the act of reviewing what you did. A counter is allowed to know what they
 * typed. What they are not given is a number to reconcile toward while standing
 * in front of a shelf.
 *
 * **Chronological, never grouped by article.** Grouping puts one article's
 * entries adjacent and makes their sum trivial to read off, which puts the
 * anchor back on the one screen a counter visits between counts. Chronological
 * answers «what did I do», which is the question correction actually needs —
 * and nothing on this screen is summed anywhere, including the footer, which is
 * why there is no footer.
 *
 * **Retracted rows stay.** Struck through and dimmed, never removed: the log is
 * append-only, and a correction screen that hid what it corrected would be
 * lying about the one thing it exists to make honest.
 *
 * There is no whole-item discard. P2.2's gate removed it and there is nothing
 * to restore it to — undo already withdraws a named event, and under several
 * counters «descartar este artículo» means «descartar lo de todos».
 */
import { useState } from 'react';

import { ownLog, type CountEvent, type OwnEntry } from '../../domain';
import { formatInstant, formatQty, parseQty } from '../format';
import type { CountStore } from '../store';
import type { CounterCatalogue } from './assignment';

export function MyEntries({
  store,
  catalogue,
  events,
}: {
  store: CountStore;
  catalogue: CounterCatalogue;
  events: readonly CountEvent[];
}) {
  /** The row being edited, if any. One at a time: this is a phone-sized screen. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const entries = ownLog(events, store.counterId).slice().reverse();

  if (entries.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">Todavía no has registrado nada</div>
        <div className="empty__body">
          Lo que registres aparece aquí, en orden, y desde aquí se corrige.
        </div>
      </div>
    );
  }

  function corregir(entry: OwnEntry): void {
    const qty = parseQty(draft);
    if (qty === null) return;
    // Both halves in one transaction (§3). A withdrawal that landed without its
    // replacement is a count somebody deleted.
    store.correct(entry.event.idarticulo as number, entry.event.id, qty);
    setEditing(null);
    setDraft('');
  }

  return (
    <ul className="rows">
      {entries.map((entry) => {
        const item = catalogue.byId.get(entry.event.idarticulo as number);
        const qty = (entry.event as { qty?: number }).qty ?? 0;
        const open = editing === entry.event.id;
        return (
          <li className={`row row--static ${entry.withdrawn ? 'row--withdrawn' : ''}`} key={entry.event.id}>
            <div className="row__main">
              <div className="row__nombre">{item?.nombre ?? `artículo ${entry.event.idarticulo}`}</div>
              <div className="row__meta">
                {formatInstant(entry.event.at)} · <span className="num">{item?.codigo ?? ''}</span>
                {item ? ` · ${item.presentacion}` : ''}
              </div>
            </div>
            <div className="row__right">
              <span className="num">{formatQty(qty)}</span>
              {entry.withdrawn && <span className="hint"> deshecho</span>}
            </div>
            {!entry.withdrawn && (
              <div className="corrections">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => store.withdraw(entry.event.idarticulo as number, entry.event.id)}
                >
                  Deshacer
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setEditing(open ? null : entry.event.id);
                    setDraft('');
                  }}
                >
                  Corregir
                </button>
              </div>
            )}
            {open && (
              <div className="confirm">
                <div className="confirm__text">
                  {`Cambiar ${formatQty(qty)} por:`}
                </div>
                <div className="readout__field">
                  <input
                    className="readout__input num"
                    inputMode="decimal"
                    autoFocus
                    aria-label={`nueva cantidad para ${item?.nombre ?? entry.event.idarticulo}`}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <span className="readout__unit">{item?.unidad ?? ''}</span>
                </div>
                <div className="actions__pair">
                  <button type="button" className="btn" onClick={() => setEditing(null)}>
                    Volver
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={parseQty(draft) === null}
                    onClick={() => corregir(entry)}
                  >
                    Guardar corrección
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
