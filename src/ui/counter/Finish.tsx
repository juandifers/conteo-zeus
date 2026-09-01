/**
 * «Terminar», and the banner that takes over when the network does not answer.
 *
 * The rule this screen exists to obey: **finishing must degrade, never hang.**
 * There is no connectivity in the bodega. A blocking spinner is a force-close,
 * and a force-close is the one thing that loses data — so the button always
 * returns, and whatever did not upload becomes a persistent banner with a
 * retry beside it.
 *
 *     [ TERMINAR ]
 *          │
 *          ├─ intenta drenar la bandeja (tope ~8s, con reintentos)
 *          │
 *          ├─ ack ──────────▶  ✓ TERMINADO Y CONFIRMADO
 *          │
 *          └─ sin respuesta ▶  ⏳ TERMINADO — 147 registros sin subir
 *                               banner persistente, reintento automático
 *                               «Acércate a la zona con señal antes de irte»
 *                               [ Reintentar ahora ]
 *
 * The `finish` event is appended **before** the attempt, not after it. Finishing
 * is something the counter did; whether the network cooperated is a separate
 * fact, and conflating them is how a counter ends up having to press a button
 * twice to have finished once.
 */
import { useSyncExternalStore } from 'react';

import type { CountStore } from '../store';
import type { CounterSync } from './sync';

export function FinishPanel({
  store,
  sync,
  onExport,
}: {
  store: CountStore;
  sync: CounterSync;
  /** Offered only when the session was sealed before this tablet got back (§1d). */
  onExport?: (json: string) => void;
}) {
  const state = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  const terminar = () => {
    // Local first, and unconditionally. The manifest is taken from the store's
    // own running chain, so the claim is one the server can check rather than
    // one it has to believe.
    store.finish();
    sync.setDeviceEstado('terminado_local');
    // `settled()` before the count is read, so «147 registros sin subir» is the
    // number that is actually on disk. The store's write is optimistic — the
    // screen moves first and IndexedDB catches up — and a banner that read the
    // outbox in between would report one event fewer than the counter just
    // caused. Not awaited by the click: the button returns immediately, which
    // is the whole rule this panel exists to obey.
    void store.settled().then(() => sync.refresh()).then(() => sync.drainWithin());
  };

  const reabrir = () => {
    // `seq` carries on unbroken: a new chain would defeat the manifest, and
    // every event after the first `finish` is flagged as an amendment for the
    // admin — derived from the log rather than stored, so it cannot drift out
    // of agreement with the events it describes.
    store.reopen();
    sync.setDeviceEstado('contando');
    void store.settled().then(() => sync.refresh()).then(() => sync.drain());
  };

  if (state.stopped) {
    return (
      <div className="panel">
        <div className="empty" role="alert">
          <div className="empty__title">{state.stopped.title}</div>
          <div className="empty__body">{state.stopped.detail}</div>
        </div>
        <div className="actions">
          {state.stopped.kind === 'sealed' && onExport && (
            <button
              type="button"
              className="btn"
              onClick={() => void sync.rejectedExport().then(onExport)}
            >
              Exportar {state.rechazados} registros para el acta
            </button>
          )}
        </div>
      </div>
    );
  }

  const confirmed = state.estado === 'terminado_confirmado';
  const claimed = state.estado === 'terminado_local';

  return (
    <div className="panel">
      <div className="panel__title">
        {confirmed ? '✓ Terminado y confirmado' : claimed ? '⏳ Terminado' : 'Cuando acabes'}
      </div>
      <div className="panel__body">
        {state.pendientes > 0 ? (
          <div className="banner" role="status">
            {/*
              One string, not three nodes. A sentence assembled out of JSX
              expressions renders as separate text nodes, which reads the same
              and is a different thing entirely to anything that queries by
              text — a test, a screen reader, `Ctrl+F` on a tablet.
            */}
            {`${state.pendientes} ${state.pendientes === 1 ? 'registro' : 'registros'} sin subir.` +
              (claimed || confirmed
                ? ' Acércate a la zona con señal antes de irte: tu conteo está guardado en la tableta y se sube solo en cuanto haya red.'
                : ' Se suben solos en cuanto haya red.')}
            {state.problem && <div className="hint">{state.problem}</div>}
          </div>
        ) : (
          <div className="hint">
            {confirmed
              ? 'El servidor tiene todo lo que contaste.'
              : claimed
                ? 'Todo subido. Esperando la confirmación del servidor.'
                : 'Todo lo que llevas está subido.'}
          </div>
        )}
        {state.serverEstado === 'terminado_incompleto' && (
          <div className="banner" role="status">
            El servidor recibió tu «terminar» pero todavía le faltan registros. No apagues
            la tableta: se están reintentando.
          </div>
        )}
      </div>
      <div className="actions">
        {claimed || confirmed ? (
          <button type="button" className="btn" onClick={reabrir}>
            Reabrir
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={terminar}>
            Terminar
          </button>
        )}
        {state.pendientes > 0 && (
          <button
            type="button"
            className="btn"
            disabled={state.draining}
            onClick={() => void sync.retryNow()}
          >
            {state.draining ? 'Subiendo…' : 'Reintentar ahora'}
          </button>
        )}
      </div>
    </div>
  );
}
