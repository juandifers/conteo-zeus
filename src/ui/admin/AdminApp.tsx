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
import { useCallback, useEffect, useState } from 'react';

import { httpApi, type Api } from '../api';
import { formatInstant } from '../format';
import { Dispatched } from './Dispatched';
import { ImportPanel } from './ImportPanel';
import { Reparto } from './Reparto';
import { adminRoute } from './links';
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
}: {
  api?: Api;
  /** Injected so a test does not have to drive `window.location`. */
  hash?: string;
  navigate?: (to: string) => void;
}) {
  const route = adminRoute(hash) ?? { name: 'list' as const };
  return route.name === 'list' ? (
    <SessionList api={api} navigate={navigate} />
  ) : (
    <SessionScreen api={api} id={route.id} navigate={navigate} />
  );
}

function SessionList({ api, navigate }: { api: Api; navigate: (to: string) => void }) {
  const [load, setLoad] = useState<Load<SessionSummary[]>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

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

      <ImportPanel
        api={api}
        onCreated={(id) => {
          setAttempt((n) => n + 1);
          navigate(`#/admin/${id}`);
        }}
      />

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
      {load.phase === 'ready' && (
        <ul className="rows">
          {load.value.map((session) => (
            <li className="row" key={session.id}>
              <button
                type="button"
                className="row__main"
                onClick={() => navigate(`#/admin/${session.id}`)}
              >
                <div className="row__nombre">
                  {session.nombre ?? `Bodega ${session.bodega}`} · {session.estado}
                </div>
                <div className="row__meta">
                  corte {session.fechaCorte} · {session.itemCount} artículos · creada{' '}
                  {formatInstant(session.createdAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
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

  if (load.phase === 'loading') return null;
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
    <Dispatched detail={load.value} onReload={reload} />
  );
}
