/**
 * What the tablet is doing about the network, said honestly.
 *
 * The rule this component exists to obey: **a normal state must not look like a
 * problem.** `contando` with a queue is the *expected* condition in a bodega —
 * there is no signal down there, that is why the whole thing is offline-first,
 * and a red banner every afternoon teaches people to ignore red banners. So a
 * queue while counting is a neutral line with a number on it.
 *
 * Exactly one state needs action, and it gets the persistent banner: **finished,
 * with things still queued.** That counter is about to walk out of the building
 * with the only copy of their afternoon on a tablet in their hand.
 *
 * A tablet can also be carrying somebody **else's** queue after a handover
 * (P2.3.5 §6a) — Pedro counting on Luis's tablet, with twenty-three of Luis's
 * events still waiting. That is named rather than counted into the total: the
 * two numbers belong to two people, and merging them would tell Pedro he has
 * work outstanding that is not his.
 *
 * Two states stop the drain and neither is a network problem, so neither is
 * phrased as one:
 *
 *   fork    two tablets on one link, or a restored backup. Retrying makes it
 *           worse, so there is no retry button.
 *   sealed  the session was closed before this got back. Their work exists and
 *           did not reach the file — the admin's problem to solve, not the
 *           counter's to have quietly erased. The export is offered right here.
 */
import { useSyncExternalStore } from 'react';

import type { OtherOutbox } from './handover';
import type { CounterSync } from './sync';

export function SyncBar({
  sync,
  otros = [],
  onExport,
}: {
  sync: CounterSync;
  /**
   * Other counters' queues on this same tablet (P2.3.5 §6a).
   *
   * Named, because «23 registros sin subir» attached to nobody is a number the
   * person holding the tablet cannot act on, and the action is specific: find
   * Luis, or at least tell the administrator that his tablet is this one.
   */
  otros?: readonly OtherOutbox[];
  /** Offered only when the session was sealed before this tablet got back (P2.2 §1d). */
  onExport?: (json: string) => void;
}) {
  const state = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  if (state.stopped) {
    return (
      <div className="panel">
        <div className="empty" role="alert">
          <div className="empty__title">{state.stopped.title}</div>
          <div className="empty__body">{state.stopped.detail}</div>
        </div>
        {state.stopped.kind === 'sealed' && onExport && (
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => void sync.rejectedExport().then(onExport)}
            >
              Exportar {state.rechazados} registros para el acta
            </button>
          </div>
        )}
      </div>
    );
  }

  const finished = state.estado === 'terminado_local' || state.estado === 'terminado_confirmado';
  const needsAction = finished && state.pendientes > 0;
  const plural = state.pendientes === 1 ? 'registro' : 'registros';

  if (needsAction) {
    return (
      <div className="banner" role="alert">
        {/*
          One string, not three nodes. A sentence assembled out of JSX
          expressions renders as separate text nodes, which reads the same and is
          a different thing entirely to anything that queries by text — a test, a
          screen reader, `Ctrl+F` on a tablet.
        */}
        {`${state.pendientes} ${plural} sin subir. Acércate a la zona con señal antes de irte: ` +
          'tu conteo está guardado en la tableta y se sube solo en cuanto haya red.'}
        {state.problem && <div className="hint">{state.problem}</div>}
        <div className="actions">
          <button
            type="button"
            className="btn btn--small"
            disabled={state.draining}
            onClick={() => void sync.retryNow()}
          >
            {state.draining ? 'Subiendo…' : 'Reintentar ahora'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="who" role="status">
        {state.pendientes > 0
          ? `${state.pendientes} ${plural} sin subir · se suben solos cuando haya señal`
          : state.estado === 'terminado_confirmado'
            ? 'Terminado y confirmado · el servidor tiene todo lo que contaste'
            : 'Todo lo que llevas está subido'}
      </div>
      <Otros otros={otros} />
    </>
  );
}

/**
 * Whoever else's work is still on this tablet.
 *
 * Neutral, like a queue while counting is neutral: this is the ordinary shape of
 * a handover, not a fault, and the events are draining on their own. It is
 * *visible* because the alternative is a queue whose owner is not here to notice
 * it — which is the whole failure §6a describes.
 *
 * There is deliberately no button beside it. Discarding another person's
 * unsynced counts is not a thing a tablet may offer to do, and «reintentar» is
 * already happening on every wake.
 */
function Otros({ otros }: { otros: readonly OtherOutbox[] }) {
  if (otros.length === 0) return null;
  return (
    <div className="who" role="status">
      {otros
        .map(
          (other) =>
            `${other.nombre}: ${other.pendientes} ${
              other.pendientes === 1 ? 'registro' : 'registros'
            } sin subir`,
        )
        .join(' · ')}
    </div>
  );
}
