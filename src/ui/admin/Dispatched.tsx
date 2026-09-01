/**
 * The session is open. Here are the links, and who has actually loaded one.
 *
 * Two things on this screen earn their place.
 *
 * **The printable sheet.** The tablets are shared and the links end in 22
 * random characters; without a sheet somebody types one, mistypes it, and finds
 * out at the moment the count is starting. Name, sections, article count, link
 * and QR code, one block per counter, and a page break between them.
 *
 * **The download state.** There is no signal in the bodega, so the tablet has
 * to be loaded on office wifi and this is the last moment anybody can notice
 * that one was not. A counter still reading «pendiente» when people are picking
 * up their tablets is a person who will walk in and walk straight back out.
 */
import { QrCode } from '../components/QrCode';
import { counterLink } from './links';
import { formatInstant } from '../format';
import type { SessionDetail } from './types';

export function Dispatched({ detail, onReload }: { detail: SessionDetail; onReload: () => void }) {
  const sectionsOf = (counterId: string) =>
    detail.sections.filter((section) => section.counterId === counterId);
  const countOf = (counterId: string) =>
    detail.assignments.filter((assignment) => assignment.counterId === counterId).length;

  const pending = detail.counters.filter((counter) => counter.fetchedAt === null);

  return (
    <div className="screen screen--desk">
      <div className="masthead">
        <div className="masthead__title">
          Bodega {detail.session.bodega} · corte {detail.session.fechaCorte} · despachada
        </div>
        <div className="hint">
          {detail.session.dispatchedAt
            ? `Despachada ${formatInstant(detail.session.dispatchedAt)}`
            : 'Abierta'}{' '}
          · {detail.counters.length} contadores · {detail.session.itemCount} artículos
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">
          Descargas: {detail.counters.length - pending.length} de {detail.counters.length}
        </div>
        <div className="panel__body">
          {pending.length > 0 ? (
            <div className="banner" role="status">
              Todavía sin descargar: {pending.map((counter) => counter.nombre).join(', ')}. Sus
              tabletas tienen que abrir el enlace <strong>con wifi</strong> antes de entrar a la
              bodega; adentro no hay señal y ya no se puede.
            </div>
          ) : (
            <div className="hint">Todas las tabletas cargaron su asignación.</div>
          )}
          <div className="actions">
            <button type="button" className="btn btn--small" onClick={onReload}>
              Actualizar
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => globalThis.print?.()}
            >
              Imprimir hoja de reparto
            </button>
          </div>
        </div>
      </div>

      <div className="sheet">
        {detail.counters.map((counter) => {
          const link = counterLink(counter.token);
          return (
            <section className="sheet__counter" key={counter.id}>
              <h2 className="sheet__nombre">{counter.nombre}</h2>
              <div className="sheet__meta">
                {countOf(counter.id)} artículos ·{' '}
                {sectionsOf(counter.id)
                  .map((section) => section.nombre)
                  .join(' · ')}
              </div>
              <div className="sheet__body">
                <QrCode value={link} title={`Enlace de ${counter.nombre}`} />
                <div>
                  {/* The link in full, selectable, in a monospaced face: the QR
                      is for the ordinary case and this is for the tablet whose
                      camera will not focus in a corridor. */}
                  <code className="sheet__link">{link}</code>
                  <div className={counter.fetchedAt ? 'chip chip--counted' : 'chip'}>
                    {counter.fetchedAt
                      ? `descargado ${formatInstant(counter.fetchedAt)}${
                          counter.fetchCount > 1 ? ` · ${counter.fetchCount} veces` : ''
                        }`
                      : 'pendiente'}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
