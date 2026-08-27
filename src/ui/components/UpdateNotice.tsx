/**
 * "There is a new version" — and nothing happens until somebody says so.
 *
 * Quiet on purpose. It sits at the foot of the shell, takes one line, and is
 * dismissible; it never covers the keypad, never steals focus, and never
 * appears as a dialog. The update is already downloaded and waiting by the
 * time this renders (see updates.ts), so the only cost of ignoring it is that
 * the tablet keeps running the build it started the shift on — which is very
 * often the right answer in the middle of a count.
 *
 * Dismissal is per-tab and deliberately not remembered: the next launch is
 * exactly when applying an update is free, and that is when the notice should
 * come back.
 */
import { useEffect, useState } from 'react';
import type { Updates } from '../updates';

export function UpdateNotice({ updates }: { updates: Updates }) {
  const [waiting, setWaiting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => updates.subscribe(setWaiting), [updates]);

  if (!waiting || dismissed) return null;

  return (
    <div className="updatebar" role="status">
      <span className="updatebar__text">Hay una versión nueva</span>
      <button
        type="button"
        className="btn btn--small"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          // The page reloads inside this promise, so there is no success path
          // to handle. A rejection leaves the button spent and the notice up,
          // which is the honest state: the new version did not take over.
          void updates.apply().catch(() => setApplying(false));
        }}
      >
        {applying ? 'Actualizando…' : 'Actualizar'}
      </button>
      <button
        type="button"
        className="updatebar__close"
        aria-label="descartar aviso"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
