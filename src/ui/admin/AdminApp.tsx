/**
 * The admin app: create a session, divide the bodega, hand out the tablets.
 *
 * A separate root from the counting app, mounted from the same bundle on the
 * `#/admin` hash. It runs on a desk with a network; the counting screens run in
 * a cooler without one, and the two have almost nothing in common beyond the
 * domain underneath them.
 *
 * Routing is `#/admin` and `#/admin/<id>`, read from the hash and nothing else.
 * A hash rather than a path because the service worker answers navigations from
 * the precache, and because the counter link has to work the same way — see
 * `links.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { httpApi, type Api } from '../api';
import { UpdateNotice } from '../components/UpdateNotice';
import { formatInstant } from '../format';
import { noUpdates, type Updates } from '../updates';
import { Dispatched } from './Dispatched';
import { ImportPanel } from './ImportPanel';
import { Reparto } from './Reparto';
import { adminRoute } from './links';
import { sessionWord, unos } from './vocabulario';
import type { SessionDetail, SessionSummary } from './types';

type Load<T> =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; value: T };

export function AdminApp({
  api = httpApi(),
  hash = globalThis.location?.hash ?? '#/admin',
  navigate = (to: string) => {
    if (globalThis.location) globalThis.location.hash = to;
  },
  updates: injectedUpdates,
}: {
  api?: Api;
  /** Injected so a test does not have to drive `window.location`. */
  hash?: string;
  navigate?: (to: string) => void;
  updates?: Updates;
}) {
  const updates = useMemo(() => injectedUpdates ?? noUpdates(), [injectedUpdates]);
  const route = adminRoute(hash) ?? { name: 'list' as const };
  return (
    <>
      {route.name === 'list' ? (
        <SessionList api={api} navigate={navigate} />
      ) : (
        <SessionScreen api={api} id={route.id} navigate={navigate} />
      )}
      {/* The same quiet foot-of-page notice the counting app carries. The desk
          is where a stale build costs the most — it is always online, and its
          person is the one reading screens this repository just changed. */}
      <UpdateNotice updates={updates} />
    </>
  );
}

/** Sealed and closed sessions are finished work: archive, not agenda. */
const FINISHED = new Set(['sellado', 'cerrado']);

/**
 * What the archive search matches against: the corte date, the file the count
 * was taken from, and the day it was created — in both the wire spelling
 * (`2026-08-31`) and the one the list prints (`31/08/2026`), because the
 * person searching types whichever of the two they are looking at.
 */
function haystack(session: SessionSummary): string {
  return [
    session.fechaCorte,
    session.sourceName ?? '',
    session.nombre ?? '',
    session.bodega,
    session.createdAt.slice(0, 10),
    formatInstant(session.createdAt),
  ]
    .join(' ')
    .toLowerCase();
}

function SessionRow({
  session,
  meta,
  navigate,
}: {
  session: SessionSummary;
  meta: string;
  navigate: (to: string) => void;
}) {
  return (
    <li className="row">
      <button
        type="button"
        className="row__main"
        onClick={() => navigate(`#/admin/${session.id}`)}
      >
        <div className="row__nombre">{session.nombre ?? `Bodega ${session.bodega}`}</div>
        <div className="row__meta">{meta}</div>
      </button>
      <div className="row__right">
        {/* The state as a chip rather than folded into the title: which
            sessions are still drafts is the question this list answers. */}
        <span className={session.estado === 'borrador' ? 'chip' : 'chip chip--counted'}>
          {sessionWord(session.estado)}
        </span>
      </div>
    </li>
  );
}

function SessionList({ api, navigate }: { api: Api; navigate: (to: string) => void }) {
  const [load, setLoad] = useState<Load<SessionSummary[]>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    api
      .get<{ sessions: SessionSummary[] }>('/api/sessions')
      .then((body) => live && setLoad({ phase: 'ready', value: body.sessions }))
      .catch((cause: unknown) => {
        if (live) {
          setLoad({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
        }
      });
    return () => {
      live = false;
    };
  }, [api, attempt]);

  return (
    <div className="screen screen--desk">
      <div className="masthead">
        <div className="masthead__title">Conteos</div>
      </div>

      <div className="desksplit">
        <div className="desksplit__main">
          {load.phase === 'loading' && (
            <div className="empty">
              <div className="empty__body">Cargando las sesiones…</div>
            </div>
          )}
          {load.phase === 'failed' && (
            <div className="banner" role="alert">
              {load.message}
            </div>
          )}
          {load.phase === 'ready' && load.value.length === 0 && (
            <div className="empty">
              <div className="empty__title">Todavía no hay sesiones</div>
              <div className="empty__body">Sube un archivo exportado de Zeus para empezar.</div>
            </div>
          )}
          {load.phase === 'ready' &&
            load.value.length > 0 &&
            (() => {
              // A sealed count is done. Leaving it on the working list would
              // make the page that answers «¿qué está pasando hoy?» grow by
              // one row per month forever, so finished sessions live below,
              // behind a search — by date or by the file, because those are
              // the two things anybody remembers about an old count.
              const activas = load.value.filter((session) => !FINISHED.has(session.estado));
              const anteriores = load.value.filter((session) => FINISHED.has(session.estado));
              const needle = query.trim().toLowerCase();
              const matched =
                needle === ''
                  ? anteriores
                  : anteriores.filter((session) => haystack(session).includes(needle));
              return (
                <>
                  {activas.length === 0 ? (
                    <div className="empty">
                      <div className="empty__title">No hay conteos en curso</div>
                      <div className="empty__body">
                        Sube un archivo exportado de Zeus para empezar uno.
                      </div>
                    </div>
                  ) : (
                    <ul className="rows">
                      {activas.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          navigate={navigate}
                          meta={
                            `Bodega ${session.bodega} · corte ${session.fechaCorte} · ` +
                            `${session.itemCount} artículos · creada ${formatInstant(session.createdAt)}`
                          }
                        />
                      ))}
                    </ul>
                  )}

                  {anteriores.length > 0 && (
                    <section aria-label="Conteos anteriores">
                      <div className="sectionhead">
                        <div className="sectionhead__title">Conteos anteriores</div>
                        <div className="sectionhead__actions">
                          <span className="hint">
                            {unos(anteriores.length, 'conteo sellado', 'conteos sellados')}
                          </span>
                        </div>
                      </div>
                      {/* Worth a search box only once there is something to
                          miss: one archived count is found by looking at it. */}
                      {anteriores.length > 1 && (
                        <input
                          type="search"
                          className="tinput tinput--buscar"
                          aria-label="Buscar conteos anteriores"
                          placeholder="Buscar por fecha o archivo"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      )}
                      {matched.length === 0 ? (
                        <div className="hint">
                          Ningún conteo anterior coincide con «{query.trim()}».
                        </div>
                      ) : (
                        <ul className="rows">
                          {matched.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              navigate={navigate}
                              meta={
                                // The searchable facts, printed on the row —
                                // a result that hides why it matched sends
                                // the reader back to the search box.
                                `Bodega ${session.bodega} · corte ${session.fechaCorte}` +
                                (session.sourceName ? ` · ${session.sourceName}` : '') +
                                ` · ${session.itemCount} artículos · creada ${formatInstant(session.createdAt)}`
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </>
              );
            })()}
        </div>

        <aside className="desksplit__rail" aria-label="Nueva sesión">
          <ImportPanel
            api={api}
            onCreated={(id) => {
              setAttempt((n) => n + 1);
              navigate(`#/admin/${id}`);
            }}
          />
        </aside>
      </div>
    </div>
  );
}

function SessionScreen({
  api,
  id,
  navigate,
}: {
  api: Api;
  id: string;
  navigate: (to: string) => void;
}) {
  const [load, setLoad] = useState<Load<SessionDetail>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    api
      .get<SessionDetail>(`/api/sessions/${id}`)
      .then((detail) => live && setLoad({ phase: 'ready', value: detail }))
      .catch((cause: unknown) => {
        if (live) {
          setLoad({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
        }
      });
    return () => {
      live = false;
    };
  }, [api, id, attempt]);

  // Never a blank screen: on a slow function cold-start the void reads as a
  // crash, and the person who just clicked a session has no way to tell.
  if (load.phase === 'loading') {
    return (
      <div className="screen screen--desk">
        <div className="masthead">
          <a className="backlink" href="#/admin">
            ← Conteos
          </a>
          <div className="masthead__title">Cargando…</div>
        </div>
      </div>
    );
  }
  if (load.phase === 'failed') {
    return (
      <div className="screen screen--desk">
        <div className="banner" role="alert">
          {load.message}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => navigate('#/admin')}>
            Volver
          </button>
        </div>
      </div>
    );
  }

  // `borrador` is the only state that can still be repartitioned. Everything
  // else is a session people are counting, and P2.1 implements exactly one
  // transition into that.
  return load.value.session.estado === 'borrador' ? (
    <Reparto detail={load.value} api={api} onDispatched={reload} onReload={reload} />
  ) : (
    <Dispatched detail={load.value} api={api} onReload={reload} />
  );
}
