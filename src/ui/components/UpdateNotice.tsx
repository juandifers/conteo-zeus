/**
 * "There is a new version" — and the old one goes no further.
 *
 * Blocking on purpose. The update is already downloaded and waiting by the
 * time this renders (see updates.ts), and what a dismissible notice bought —
 * finishing the shift on the build it started on — turned out to cost more:
 * a stale build kept counting against a server that had moved, and the
 * deprecated behaviour it carried looked exactly like the app working. So the
 * gate covers the whole shell, offers one action, and cannot be waved away.
 *
 * What it deliberately does not stop: sync. The overlay stands between the
 * person and the screen, not between the outbox and the server, so a tablet
 * full of unsynced counts drains underneath it — and nothing is lost by the
 * reload, because every event lives in IndexedDB rather than in the page.
 */
import { useEffect, useState } from 'react';
import type { Updates } from '../updates';

export function UpdateNotice({ updates }: { updates: Updates }) {
  const [waiting, setWaiting] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => updates.subscribe(setWaiting), [updates]);

  if (!waiting) return null;

  return (
    <div className="updategate" role="alertdialog" aria-modal="true" aria-label="versión nueva">
      <div className="updategate__card">
        <p className="updategate__title">Hay una versión nueva</p>
        <p className="updategate__text">
          Esta versión ya no sirve para seguir. Actualiza para continuar; no se pierde nada de lo
          registrado.
        </p>
        <button
          type="button"
          className="btn"
          disabled={applying}
          onClick={() => {
            setApplying(true);
            // The page reloads inside this promise, so there is no success path
            // to handle. A rejection leaves the button spent and the gate up,
            // which is the honest state: the new version did not take over.
            void updates.apply().catch(() => setApplying(false));
          }}
        >
          {applying ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
    </div>
  );
}
