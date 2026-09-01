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

import { ownSummary, type AssignedSection, type CountEvent } from '../../domain';
import type { Api } from '../api';
import { formatInstant, formatQty } from '../format';
import { describeSeal } from './blockers';
import { EventFeed } from './feed';
import { elapsed, monitorTier, tierClass } from './tiers';
import type { SessionDetail, SyncSnapshot } from './types';

/** How often the cheap poll runs. Injected so a test does not wait in real time. */
const POLL_MS = 5_000;

interface Live {
  sync: SyncSnapshot;
  events: CountEvent[];
  at: string;
}

export function Monitor({
  detail,
  api,
  pollMs = POLL_MS,
}: {
  detail: SessionDetail;
  api: Api;
  pollMs?: number;
}) {
  const feed = useRef<EventFeed>(new EventFeed());
  /** The last total this screen pulled events for. Movement is a change in it. */
  const seen = useRef<number>(-1);
  const [live, setLive] = useState<Live | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const sessionId = detail.session.id;

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
    setLive({ sync, events: feed.current.events, at: new Date().toISOString() });
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

  const sectionsOf = (counterId: string): AssignedSection[] =>
    detail.sections
      .filter((section) => section.counterId === counterId)
      .map((section) => ({
        id: section.id,
        nombre: section.nombre,
        items: detail.assignments
          .filter((assignment) => assignment.sectionId === section.id)
          .map((assignment) => ({ idarticulo: assignment.idarticulo })),
      }));

  return (
    <div className="panel" id="monitor">
      <div className="panel__title">Seguimiento</div>
      <div className="panel__body">
        {problem && (
          <div className="banner" role="alert">
            {problem}
          </div>
        )}
        {live && (
          <div className="hint">
            {(() => {
              const abierto = elapsed(detail.session.dispatchedAt, live.at);
              const registros = live.events.filter(
                (event) => event.kind === 'add' || event.kind === 'set',
              ).length;
              return (
                `${live.sync.counters.length} contadores · ${registros} registros` +
                (abierto ? ` · abierta hace ${abierto}` : '')
              );
            })()}
          </div>
        )}
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
            // Counts of rows, from the module that answers progress questions
            // without handing back a quantity. The admin may see quantities —
            // §2.1 governs the tablet — but there is no reason to compute these
            // a second way when the same numbers already exist.
            const suyo = ownSummary(secciones, live.events, counter.id);
            return (
              <li className="row row--static" key={counter.id}>
                <div className="row__main">
                  <div className="row__nombre">{`${counter.nombre} · ${counter.estado}`}</div>
                  <div className="row__meta">
                    {`${suyo.registrados} de ${asignados} artículos · faltan ${suyo.sinRegistrar} · ` +
                      `${suyo.registros} registros · ${suyo.ceros} en cero · ${suyo.notas} notas`}
                  </div>
                  <div className="row__meta">
                    {secciones.map((section) => section.nombre).join(' · ') || 'sin secciones'}
                  </div>
                  <div className="row__meta">
                    {(counter.lastServerAt
                      ? `último contacto ${formatInstant(counter.lastServerAt)}`
                      : 'nunca sincronizó') +
                      ` · ${counter.storedMaxSeq} en el servidor` +
                      (counter.deviceIds.length > 0
                        ? ` · ${counter.deviceIds.length} tabletas`
                        : '') +
                      (counter.clockSkewMs === null
                        ? ''
                        : ` · reloj ${formatQty(Math.round(counter.clockSkewMs / 1000))} s`)}
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
