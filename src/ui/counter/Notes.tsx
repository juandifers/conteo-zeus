/**
 * Notes — the one place an observation can go.
 *
 * This exists because there is physically nowhere else to put it: `Observacion`
 * is dropped on the way into the `.txt` and `Grupo1..5` are forbidden by
 * ZEUS_FORMAT.md §9, so an article found on the floor that is not in the
 * catalogue can be recorded in the log or lost.
 *
 * Notes are events like any other: chained, pushed, sealed, and shown to the
 * admin grouped by counter (P2.4). They fold to nothing — a remark asserts
 * nothing about the stock — which is also why a note on an article does not take
 * it out of the gap list at «Terminar». The remark is the reason to go back, not
 * a substitute for going.
 *
 * Attaching one to an article is optional. Most of the notes worth writing are
 * about something that is not in the assignment at all, which is the case the
 * loose note exists for.
 */
import { useState } from 'react';

import { ownNotes, type CountEvent } from '../../domain';
import { formatInstant } from '../format';
import type { CountStore } from '../store';
import type { CounterCatalogue } from './assignment';

export function Notes({
  store,
  catalogue,
  events,
  /** Pre-attach to the article the counter was just looking at. */
  attachTo = null,
}: {
  store: CountStore;
  catalogue: CounterCatalogue;
  events: readonly CountEvent[];
  attachTo?: number | null;
}) {
  const [texto, setTexto] = useState('');
  const [attach, setAttach] = useState<number | null>(attachTo);
  const [problem, setProblem] = useState<string | null>(null);

  const notes = ownNotes(events, store.counterId);

  function guardar(): void {
    const trimmed = texto.trim();
    if (trimmed.length === 0) return;
    try {
      // Control characters are refused at append (P2.0 §3b), not here: the
      // check belongs where every write passes, and a screen that pre-empted it
      // would be a second copy of the rule that drifts.
      store.note(trimmed, attach);
      setTexto('');
      setProblem(null);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <>
      <div className="panel">
        <div className="panel__title">Nota</div>
        <div className="panel__body">
          <textarea
            className="field"
            rows={3}
            aria-label="texto de la nota"
            placeholder="3 cajas sin código en el estante de arriba"
            value={texto}
            onChange={(event) => setTexto(event.target.value)}
          />
          <div className="field__label">
            <label htmlFor="nota-articulo">Sobre un artículo (opcional)</label>
            <select
              id="nota-articulo"
              value={attach === null ? '' : String(attach)}
              onChange={(event) => setAttach(event.target.value === '' ? null : Number(event.target.value))}
            >
              <option value="">— sin artículo —</option>
              {catalogue.items.map((item) => (
                <option key={item.idarticulo} value={item.idarticulo}>
                  {item.codigo} · {item.nombre} · {item.presentacion}
                </option>
              ))}
            </select>
          </div>
          {problem && (
            <div className="banner" role="alert">
              No se pudo guardar la nota: {problem}
            </div>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={texto.trim().length === 0}
            onClick={guardar}
          >
            Guardar nota
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Sin notas todavía</div>
          <div className="empty__body">
            Lo que no cabe en una cantidad se escribe aquí y llega al administrador.
          </div>
        </div>
      ) : (
        <ul className="rows">
          {notes.map((note) => {
            const item = note.idarticulo === null ? null : catalogue.byId.get(note.idarticulo);
            return (
              <li className="row row--static" key={note.id}>
                <div className="row__main">
                  <div className="row__nombre">{(note as { texto: string }).texto}</div>
                  <div className="row__meta">
                    {formatInstant(note.at)}
                    {item && (
                      <>
                        {' · '}
                        <span className="num">{item.codigo}</span> {item.nombre}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
