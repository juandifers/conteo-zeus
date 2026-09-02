/**
 * The live monitor — P2.4 §1.
 *
 * Polls `/sync`, which is cheap, and pulls `/events` only when `/sync` shows
 * movement. That split is the whole design of the monitoring read: a screen
 * refreshing every few seconds must not drag a session's whole log across the
 * wire to find out that nothing happened.
 *
 * ## Three tiers, and one of them is normal
 *
 * A bodega with no connectivity means most of a shift looks like «contando, sin
 * señal». Styling that as a warning trains the admin to ignore the panel, and
 * then the line that costs a morning — somebody who finished with events still
 * on their tablet — is one more grey row among twelve. So silence is neutral,
 * and only what somebody has to act on is marked. `monitorTier` is where that
 * decision lives, and it is a pure function so it can be tested without a
 * browser.
 *
 * Colour is not used for any of it. In this product colour carries exactly one
 * meaning — variance direction — and a red counter row would be the second.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReactNode } from 'react';

import {
  exposureValue,
  ownSummary,
  registeredArticles,
  type AssignedSection,
  type CountEvent,
} from '../../domain';
import type { Api } from '../api';
import { formatMoney, formatQty } from '../format';
import { describeSeal } from './blockers';
import { EventFeed } from './feed';
import { monitorTier, tierClass } from './tiers';
import type { SessionDetail, SyncSnapshot } from './types';

/** How often the cheap poll runs. Injected so a test does not wait in real time. */
const POLL_MS = 5_000;

export interface MonitorLive {
  sync: SyncSnapshot;
  events: CountEvent[];
  at: string;
}

/**
 * The trailing window the pace line reads. A session average would keep
 * promising the morning's rate all afternoon; twenty minutes is short enough
 * to be about now and long enough that one cold room does not zero it.
 */
const PACE_WINDOW_MS = 20 * 60_000;

/** Active dot: the server heard from this tablet within the last five minutes. */
const ACTIVE_MS = 5 * 60_000;

/** `hace 3 min`, `hace 2 h` — the monitor's clock words, always relative. */
function since(at: string | null, now: string): string {
  if (at === null) return 'sin sincronizar';
  const minutes = Math.floor((Date.parse(now) - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function Monitor({
  detail,
  api,
  pollMs = POLL_MS,
  actions,
  onLive,
}: {
  detail: SessionDetail;
  api: Api;
  pollMs?: number;
  /** Controls for the Contadores header — the folded «Cambios», the reprint. */
  actions?: ReactNode;
  /** The rail reads the same poll rather than running a second one (§3.2). */
  onLive?: (live: MonitorLive) => void;
}) {
  const feed = useRef<EventFeed>(new EventFeed());
  /** The last total this screen pulled events for. Movement is a change in it. */
  const seen = useRef<number>(-1);
  const [live, setLive] = useState<MonitorLive | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const sessionId = detail.session.id;

  // Through a ref, so a parent handing an inline arrow does not recreate the
  // poll — an effect keyed on a new function every render is a poll loop.
  const liveRef = useRef(onLive);
  liveRef.current = onLive;

  const poll = useCallback(async () => {
    const sync = await api.get<SyncSnapshot>(`/api/sessions/${sessionId}/sync`);
    // «Movement» is the sum of what the server holds. It cannot go down, so a
    // change in it is new events and nothing else — and when it has not changed
    // there is nothing to pull, which is the point of polling the cheap endpoint.
    const total = sync.counters.reduce((sum, counter) => sum + counter.storedMaxSeq, 0);
    if (total !== seen.current) {
      await feed.current.pull(api, sessionId);
      seen.current = total;
    }
    const fresh = { sync, events: feed.current.events, at: new Date().toISOString() };
    setLive(fresh);
    liveRef.current?.(fresh);
    setProblem(null);
  }, [api, sessionId]);

  useEffect(() => {
    let live = true;
    const run = () => {
      void poll().catch((cause: unknown) => {
        if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
      });
    };
    run();
    const handle = setInterval(run, pollMs);
    return () => {
      live = false;
      clearInterval(handle);
    };
  }, [poll, pollMs]);

  // No sections means a shared session (P2.6): everybody holds the whole
  // catalogue, so «12 de 298» per person would be a debt nobody owes. Progress
  // is per person's own work, and coverage is the session's, shown once above.
  const compartido = detail.sections.length === 0;
  const todo: AssignedSection[] = [
    {
      id: 'todo',
      nombre: 'todo el catálogo',
      items: detail.items.map((item) => ({ idarticulo: item.idarticulo })),
    },
  ];
  const sectionsOf = (counterId: string): AssignedSection[] =>
    compartido
      ? todo
      : detail.sections
          .filter((section) => section.counterId === counterId)
          .map((section) => ({
            id: section.id,
            nombre: section.nombre,
            items: detail.assignments
              .filter((assignment) => assignment.sectionId === section.id)
              .map((assignment) => ({ idarticulo: assignment.idarticulo })),
          }));

  // §4.1: the verdict block is the largest thing on the page. One fraction,
  // one bar, one context line — the standing answer to «¿vamos bien?». The
  // fraction is the session's whichever way it was dispatched: in a shared
  // session coverage belongs to everybody at once, and in a sectioned one the
  // sum over the partition is the same number.
  const registered = live ? registeredArticles(live.events) : new Set<number>();
  const total = detail.items.length;
  const sinContar = total - registered.size;
  const sinVerificar = detail.items.reduce(
    (sum, item) => (registered.has(item.idarticulo) ? sum : sum + exposureValue(item)),
    0,
  );
  const pct = total === 0 ? 0 : Math.round((registered.size / total) * 100);
  // Pace over a trailing window, never a projection: a projected finish that
  // is wrong is worse than none, so the screen reports what actually happened
  // in the last twenty minutes and lets the admin do the arithmetic they
  // trust. Quiet when nothing moved — an idle «0 registros» line is noise.
  const recientes = live
    ? live.events.filter(
        (event) =>
          (event.kind === 'add' || event.kind === 'set') &&
          Date.parse(live.at) - Date.parse(event.at) <= PACE_WINDOW_MS,
      ).length
    : 0;

  return (
    <div id="monitor">
      {problem && (
        <div className="banner" role="alert">
          {problem}
        </div>
      )}

      {live && (
        <div className="verdict">
          <div className="verdict__row">
            <div className="verdict__fraction">
              <span className="verdict__big num">{registered.size}</span>
              {` de ${total} artículos`}
            </div>
            <div className="verdict__pct num">{`${pct} %`}</div>
          </div>
          <span className="progressbar verdict__bar">
            <span className="progressbar__fill" style={{ width: `${pct}%` }} />
          </span>
          <div className="verdict__context">
            {`${sinContar} sin contar · ${formatMoney(sinVerificar)} COP sin verificar` +
              (recientes > 0 ? ` · ${recientes} registros en los últimos 20 min` : '')}
          </div>
        </div>
      )}

      <div className="sectionhead">
        <div className="sectionhead__title">Contadores</div>
        {actions && <div className="sectionhead__actions">{actions}</div>}
      </div>

      {live && (
        <ul className="rows">
          {live.sync.counters.map((counter) => {
            const verdict = monitorTier(counter, live.at);
            const secciones = sectionsOf(counter.id);
            const asignados = secciones.reduce(
              (sum, section) => sum + section.items.length,
              0,
            );
            const activo =
              counter.lastServerAt !== null &&
              Date.parse(live.at) - Date.parse(counter.lastServerAt) <= ACTIVE_MS;
            // Counts of rows, from the module that answers progress questions
            // without handing back a quantity. The admin may see quantities —
            // §2.1 governs the tablet — but there is no reason to compute these
            // a second way when the same numbers already exist.
            const suyo = ownSummary(secciones, live.events, counter.id);
            return (
              <li className="row row--static" key={counter.id}>
                <span
                  className={activo ? 'livedot livedot--on' : 'livedot'}
                  aria-label={activo ? 'activo en los últimos 5 minutos' : 'sin actividad reciente'}
                >
                  {activo ? '●' : '○'}
                </span>
                <div className="row__main">
                  <div className="row__nombre">{`${counter.nombre} · ${counter.estado}`}</div>
                  <div className="row__meta">
                    {(compartido
                      ? `${suyo.registrados} artículos registrados`
                      : `${suyo.registrados} de ${asignados} artículos · faltan ${suyo.sinRegistrar}`) +
                      ` · ${suyo.registros} registros · ${suyo.ceros} en cero · ${suyo.notas} notas` +
                      ` · ${since(counter.lastServerAt, live.at)}`}
                  </div>
                  <div className="row__meta">
                    {`${counter.storedMaxSeq} en el servidor` +
                      (counter.deviceIds.length > 0
                        ? ` · ${counter.deviceIds.length} tabletas`
                        : '') +
                      (counter.clockSkewMs === null
                        ? ''
                        : ` · reloj ${formatQty(Math.round(counter.clockSkewMs / 1000))} s`) +
                      (compartido
                        ? ''
                        : ` · ${secciones.map((section) => section.nombre).join(' · ')}`)}
                  </div>
                  {verdict.titulo !== '' && (
                    <div className={tierClass(verdict.tier)}>{verdict.titulo}</div>
                  )}
                  {verdict.detalle && <div className="hint">{verdict.detalle}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {live && live.sync.session.readyToSeal.length > 0 && (
        <div className="panel__body">
          {/* Live rather than a link, so the admin can see what is still
              outstanding without navigating. */}
          <div className="panel__subtitle">Para poder sellar</div>
          <ul className="checklist">
            {live.sync.session.readyToSeal.map((blocker, index) => (
              <li className="checkrow" key={`${blocker.kind}-${index}`}>
                <span>{describeSeal(blocker)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
