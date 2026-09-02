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
 *
 * From P2.3.5 it also carries `Cambios`, which is everything that can still
 * change about who counts what: a swap, an extra pair of hands, somebody who
 * never arrived. That belongs on this screen rather than on its own route
 * because it is the screen somebody is already looking at when the radio says
 * Luis has gone home.
 *
 * P2.4 adds the second half of an open session's life, and it is a **tab rather
 * than a route**: watching the count and reviewing it are the same person at the
 * same desk on the same afternoon, and the reason they are separated at all is
 * that they poll different things at different rates. `Seguimiento` refreshes
 * every few seconds off the cheap endpoint; `Revisión` folds five thousand
 * events and is asked for, not pushed.
 */
import { useState } from 'react';

import { QrCode } from '../components/QrCode';
import { Cambios } from './Cambios';
import { Cierre } from './Cierre';
import { DeleteSession } from './Reparto';
import { Monitor } from './Monitor';
import { Revision } from './Revision';
import { counterLink } from './links';
import { formatInstant } from '../format';
import type { Api } from '../api';
import type { SessionDetail } from './types';

/**
 * §3.1 of the admin brief: setup work leaves the monitoring screen.
 *
 * `Cambios`, the add/retire forms and the QR cards are rare, deliberate acts.
 * Sitting in the vertical middle of the screen the admin refreshes every ten
 * minutes, they must explain themselves in standing paragraphs; attached to the
 * moment somebody opens «Cambios», the explanation becomes short and obvious.
 * The sheet still exists in the DOM while collapsed — hidden on screen, shown
 * to the printer — so «Imprimir hoja de reparto» works without opening anything.
 */

type Tab = 'seguimiento' | 'revision' | 'cierre';

/** Sessions whose count is over. Nothing is arriving, so nothing is polled. */
const FROZEN = new Set(['sellado', 'cerrado']);

export function Dispatched({
  detail,
  api,
  onReload,
  tab: initialTab,
}: {
  detail: SessionDetail;
  api: Api;
  onReload: () => void;
  /** Injected so a test can open a tab directly. */
  tab?: Tab;
}) {
  // A sealed session opens on `Sello y acta`, which is the only thing left to do
  // with it — and it keeps `Seguimiento` from polling every five seconds for
  // movement that can no longer happen.
  const [tab, setTab] = useState<Tab>(
    initialTab ?? (FROZEN.has(detail.session.estado) ? 'cierre' : 'seguimiento'),
  );
  /** Whether the setup work — cambios, enlaces, QR — is unfolded. See §3.1 above. */
  const [cambios, setCambios] = useState(false);
  // No sections means a shared session (P2.6): everybody holds the whole
  // catalogue and the sheet says so instead of listing a partition.
  const compartido = detail.sections.length === 0;
  const sectionsOf = (counterId: string) =>
    detail.sections.filter((section) => section.counterId === counterId);
  const countOf = (counterId: string) =>
    detail.assignments.filter((assignment) => assignment.counterId === counterId).length;

  const pending = detail.counters.filter((counter) => counter.fetchedAt === null);

  return (
    <div className="screen screen--desk">
      <div className="masthead">
        <a className="backlink" href="#/admin">
          ← Conteos
        </a>
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

      <div className="chips" role="tablist" aria-label="secciones del conteo">
        {(
          [
            ['seguimiento', 'Seguimiento'],
            ['revision', 'Revisión'],
            ['cierre', 'Sello y acta'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'chipbtn chipbtn--on' : 'chipbtn'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'revision' && (
        <Revision detail={detail} api={api} onReload={onReload} />
      )}

      {tab === 'cierre' && <Cierre detail={detail} api={api} onReload={onReload} />}

      {tab === 'seguimiento' && (
        <div className="desksplit">
          <div className="desksplit__main">
            <Monitor detail={detail} api={api} />

            <div className="sectionhead">
              <div className="sectionhead__title">Contadores</div>
              <div className="sectionhead__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  aria-expanded={cambios}
                  onClick={() => setCambios((open) => !open)}
                >
                  {cambios ? 'Cambios ▴' : 'Cambios ⌄'}
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

            {/*
              Everything that can still change about who counts what (P2.3.5).
              Above the printable sheet, because a sheet printed before a swap
              is a sheet that is wrong, and the person reprinting it needs to
              have made the change first.
            */}
            {cambios && <Cambios detail={detail} api={api} onReload={onReload} />}

            <div className={cambios ? 'sheet' : 'sheet sheet--printonly'}>
              {detail.counters.map((counter) => {
                const link = counterLink(counter.token);
                return (
                  <section className="sheet__counter" key={counter.id}>
                    <h2 className="sheet__nombre">{counter.nombre}</h2>
                    <div className="sheet__meta">
                      {compartido
                        ? `todo el catálogo · ${detail.session.itemCount} artículos`
                        : `${countOf(counter.id)} artículos · ${sectionsOf(counter.id)
                            .map((section) => section.nombre)
                            .join(' · ')}`}
                    </div>
                    <div className="sheet__body">
                      <QrCode value={link} title={`Enlace de ${counter.nombre}`} />
                      <div>
                        {/* The link in full, selectable, in a monospaced face:
                            the QR is for the ordinary case and this is for the
                            tablet whose camera will not focus in a corridor. */}
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

          <aside className="desksplit__rail" aria-label="Estado del despacho">
            <div className="panel">
              <div className="panel__title">
                Descargas: {detail.counters.length - pending.length} de {detail.counters.length}
              </div>
              <div className="panel__body">
                {pending.length > 0 ? (
                  <div className="banner" role="status">
                    Todavía sin descargar: {pending.map((counter) => counter.nombre).join(', ')}.
                    Sus tabletas tienen que abrir el enlace <strong>con wifi</strong> antes de
                    entrar a la bodega; adentro no hay señal y ya no se puede.
                  </div>
                ) : (
                  <div className="hint">Todas las tabletas cargaron su asignación.</div>
                )}
                <div className="actions actions--flat">
                  <button type="button" className="btn btn--small" onClick={onReload}>
                    Actualizar
                  </button>
                </div>
              </div>
            </div>

            <DeleteSession
              api={api}
              sessionId={detail.session.id}
              estado={detail.session.estado}
              onDeleted={() => {
                if (globalThis.location) globalThis.location.hash = '#/admin';
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
