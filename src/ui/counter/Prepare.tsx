/**
 * Preparing a tablet: one fetch on office wifi, and then it is on its own.
 *
 * This is the whole of the counter's side in P2.1. The entry screen is P2.3;
 * what has to exist first is the guarantee underneath it — **everything this
 * device will need is resident before it leaves the office** — because there is
 * no signal in the bodega and no second chance at it.
 *
 * So the order here is deliberate: read what is already stored *first*, then try
 * the network. A tablet that has been prepared opens this screen and says
 * «listo» whether or not there is a network, which is exactly what somebody
 * standing in a corridor needs to see. A fetch that succeeds replaces the
 * stored copy with a newer one; a fetch that fails on a device that already has
 * one is not an error, it is Tuesday.
 */
import { useEffect, useState } from 'react';

import type { CounterPayload } from '../../domain';
import type { AssignmentStore } from '../../store';
import { ApiError, type Api } from '../api';
import { formatInstant } from '../format';

interface Held {
  payload: CounterPayload;
  fetchedAt: string;
}

type Phase =
  | { name: 'reading' }
  | { name: 'ready'; held: Held; refreshing: boolean; problem: string | null }
  | { name: 'empty'; problem: string };

/** How the network attempt went. Separate from what the device holds, because they are separate facts. */
type Remote = { status: 'trying' } | { status: 'done' } | { status: 'failed'; problem: string };

export function Prepare({
  token,
  api,
  store,
  now = () => new Date().toISOString(),
  onReady,
}: {
  token: string;
  api: Api;
  store: AssignmentStore;
  now?: () => string;
  /**
   * Called with whatever this device holds, as soon as it holds it.
   *
   * The seam `CounterScreen` boots the counting session through. Prepare stays
   * the screen that answers one question — «is this tablet ready to walk into a
   * bodega with no signal» — and does not acquire a chain, a device identity or
   * an outbox in order to answer it.
   */
  onReady?: (payload: CounterPayload, fetchedAt: string) => void;
}) {
  /** `undefined` while the local read is still in flight; `null` once we know there is nothing. */
  const [held, setHeld] = useState<Held | null | undefined>(undefined);
  const [remote, setRemote] = useState<Remote>({ status: 'trying' });
  const [attempt, setAttempt] = useState(0);

  // The local read comes first and does not depend on the fetch. A tablet that
  // has been prepared says «listo» whether or not there is a network, which is
  // exactly what somebody standing in a corridor needs to see.
  useEffect(() => {
    let live = true;
    store.load(token).then(
      (row) => {
        if (live) setHeld(row ? { payload: row.payload, fetchedAt: row.fetchedAt } : null);
      },
      () => {
        if (live) setHeld(null);
      },
    );
    return () => {
      live = false;
    };
  }, [store, token]);

  // The fetch runs alongside it. On success it replaces what the device holds
  // with a newer copy; on failure it is only ever a *remark*, because a device
  // that already has its assignment is not broken by a corridor with no wifi.
  useEffect(() => {
    let live = true;
    setRemote({ status: 'trying' });
    api
      .get<CounterPayload>(`/api/c/${token}`)
      .then(async (payload) => {
        const fetchedAt = now();
        await store.save(token, payload, fetchedAt);
        return { payload, fetchedAt };
      })
      .then(
        (fresh) => {
          if (!live) return;
          setHeld(fresh);
          setRemote({ status: 'done' });
        },
        (cause: unknown) => {
          if (!live) return;
          setRemote({
            status: 'failed',
            problem:
              cause instanceof ApiError
                ? cause.message
                : `No se pudo descargar: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        },
      );
    return () => {
      live = false;
    };
    // `now` is not in the list on purpose: it is a clock, and a new identity for
    // it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, store, token, attempt]);

  const phase: Phase =
    held === undefined
      ? { name: 'reading' }
      : held === null
        ? remote.status === 'failed'
          ? { name: 'empty', problem: remote.problem }
          : { name: 'reading' }
        : {
            name: 'ready',
            held,
            refreshing: remote.status === 'trying',
            problem: remote.status === 'failed' ? remote.problem : null,
          };

  const retry = () => setAttempt((n) => n + 1);

  useEffect(() => {
    if (held) onReady?.(held.payload, held.fetchedAt);
  }, [held, onReady]);

  if (phase.name === 'reading') return null;

  if (phase.name === 'empty') {
    return (
      <div className="screen">
        <div className="empty" role="alert">
          <div className="empty__title">Esta tableta todavía no está lista</div>
          <div className="empty__body">
            {phase.problem}
            <br />
            Conéctate al wifi de la oficina y vuelve a abrir el enlace. La bodega no tiene señal:
            si entras sin descargar, no vas a poder contar.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={retry}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const { payload, fetchedAt } = phase.held;
  const total = payload.secciones.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <div className="screen">
      <div className="masthead">
        <div className="masthead__title">{payload.counter.nombre}</div>
        <div className="hint">
          Bodega {payload.session.bodega} · corte {payload.session.fechaCorte}
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">Listo para contar sin señal</div>
        <div className="panel__body">
          <div className="hint">
            {total} artículos en {payload.secciones.length}{' '}
            {payload.secciones.length === 1 ? 'sección' : 'secciones'}, descargados{' '}
            {formatInstant(fetchedAt)}. Ya puedes entrar a la bodega: esta tableta no necesita
            volver a conectarse.
          </div>
          {phase.refreshing && <div className="hint">Buscando cambios…</div>}
          {phase.problem && (
            <div className="banner" role="status">
              No se pudo verificar si hay cambios ({phase.problem}). Lo que ya está descargado
              sirve igual.
            </div>
          )}
        </div>
      </div>

      <ul className="rows">
        {payload.secciones.map((section) => (
          <li className="row row--static" key={section.id}>
            <div className="row__main">
              <div className="row__nombre">{section.nombre}</div>
              <div className="row__meta">
                {section.items.length} artículos ·{' '}
                {section.items
                  .slice(0, 3)
                  .map((item) => item.nombre)
                  .join(', ')}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="colofon">
        <div className="colofon__row">
          La pantalla de conteo todavía no está en esta versión. Esta tableta ya tiene su
          asignación guardada; cuando llegue, la va a encontrar aquí.
        </div>
      </div>
    </div>
  );
}
