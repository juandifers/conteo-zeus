/**
 * What the plain address opens — and so what the app icon opens.
 *
 * The installed app starts at `/` (vite.config.ts `start_url`), and so does
 * anybody who types the address. Until 2026-10 that was always the
 * single-device app, so a tablet prepared from a counter link and then opened
 * from its icon landed on the *other* screens: a different way of counting,
 * with none of the counter's assignment in it. Now:
 *
 *     links prepared on this tablet
 *       none                       ──▶ the single-device app, as before
 *       one, prepared recently,    ──▶ straight into it (#/c/<token>),
 *       and the page just opened       replacing the history entry, so
 *                                      «back» does not bounce here again
 *       otherwise                  ──▶ a chooser: each link, newest first,
 *                                      and «Conteo de una sola tableta»
 *
 * «The page just opened» (`abrirDirecto`, from Root): coming back to `/` with
 * Back after choosing a link shows the chooser again rather than redirecting —
 * opening the link may have refetched it, which makes it «recent», and an
 * entrance that redirected then would turn Back into a loop.
 *
 * «Recently» is the only judgement here, and it is there because a tablet
 * keeps a link until it is prepared for another session (handover.ts,
 * `clearStaleAssignments`): last month's count is still on it. Opening that
 * without asking would put somebody counting today's bodega into a session
 * that is already sealed. Four days covers a tablet prepared on a Thursday for
 * a Monday count; anything older is shown, not assumed.
 *
 * The single-device app is always one tap away on the chooser, and always at
 * `#/local`.
 */
import { useEffect, useState, type ReactNode } from 'react';

import type { AssignmentStore } from '../store';
import type { CounterAssignmentRow } from '../store/db';
import { LOCAL_HASH } from './admin/links';
import { formatInstant } from './format';

/** How old a single prepared link may be and still open without asking. */
const RECIENTE_MS = 4 * 24 * 60 * 60 * 1000;

export function Entrance({
  assignments,
  app,
  go,
  abrirDirecto = true,
  now = () => Date.now(),
}: {
  assignments: AssignmentStore;
  /** The single-device app, rendered in place when nothing is prepared. */
  app: ReactNode;
  /** Move to another hash route; `replace` leaves no history entry behind. */
  go: (hash: string, options?: { replace?: boolean }) => void;
  /** Whether a single recent link may be opened without asking (see above). */
  abrirDirecto?: boolean;
  /** Injected so a test can age a link without waiting four days. */
  now?: () => number;
}) {
  const [links, setLinks] = useState<CounterAssignmentRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    assignments.list().then(
      (rows) => {
        if (alive) setLinks(rows.slice().sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)));
      },
      // A store that cannot be read has nothing prepared in it that anybody can
      // open: the single-device app is the honest answer, not a blank screen.
      () => {
        if (alive) setLinks([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [assignments]);

  const reciente =
    links !== null &&
    links.length === 1 &&
    now() - Date.parse(links[0].fetchedAt) <= RECIENTE_MS;
  const direct = reciente && abrirDirecto ? links![0] : null;

  useEffect(() => {
    if (direct) go(`#/c/${direct.token}`, { replace: true });
  }, [direct, go]);

  if (links === null || direct) return null;
  if (links.length === 0) return <>{app}</>;

  return (
    <div className="screen">
      <div className="masthead">
        <h1 className="masthead__title">conteo</h1>
      </div>
      <div className="scroll">
        <div className="panel">
          <div className="panel__body">
            <div className="hint">
              {links.length > 1
                ? 'Esta tableta está preparada para más de un conteo. Elige el tuyo.'
                : reciente
                  ? 'Esta tableta está preparada para este conteo. Ábrelo, o empieza un conteo ' +
                    'de una sola tableta.'
                  : 'Esta tableta se preparó para este conteo hace más de unos días. Si es el ' +
                    'tuyo, ábrelo; si hoy cuentas otra cosa, empieza un conteo de una sola tableta.'}
            </div>
          </div>
        </div>
        {links.map((link) => (
          <button
            type="button"
            key={link.token}
            className="sessioncard"
            onClick={() => go(`#/c/${link.token}`)}
          >
            <span className="sessioncard__top">
              <span className="sessioncard__bodega">{link.payload.counter.nombre}</span>
              <span className="num">{link.payload.session.fechaCorte}</span>
            </span>
            <span className="sessioncard__meta">
              <span>
                Bodega <span className="num">{link.payload.session.bodega}</span>
                {link.payload.session.nombre ? ` · ${link.payload.session.nombre}` : ''}
              </span>
              <span>preparada {formatInstant(link.fetchedAt)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => go(LOCAL_HASH)}>
          Conteo de una sola tableta
        </button>
      </div>
    </div>
  );
}
