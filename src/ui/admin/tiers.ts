/**
 * What the live monitor may say about a counter, and how loudly.
 *
 * A separate file from `Monitor.tsx` because it is pure and the component is
 * not: the mapping from what the server holds to how loudly to say it is the
 * decision worth testing, and it should be testable without a browser.
 *
 * Three tiers, and the separation is the whole point of Task 1:
 *
 *     contando, sin señal desde 10:14        NORMAL en bodega — neutro
 *     terminó y faltan registros suyos       NECESITA ACCIÓN — que se acerque
 *                                            a la señal antes de irse
 *     dos tabletas en un enlace              DETENIDO — nada se resuelve solo
 *
 * A bodega with no connectivity means most of a shift looks like the first line.
 * **Styling it as a warning trains the admin to ignore the panel**, and the
 * second line is the one that costs a morning — so silence is neutral here, and
 * only what somebody has to act on is marked (weight always; on the desk, the
 * --warn/--stop state hues of ADMIN_UI.md §6 as well).
 *
 * ## What the server can and cannot see
 *
 * The brief's second line is «terminado_local, 147 en cola», and the server can
 * observe neither half of that: `terminado_local` is a claim a *device* makes
 * about itself and is deliberately not stored (DOMAIN.md §6.2), and a queue
 * sitting in a cooler is invisible by construction. What the server does hold is
 * the same situation one step later — a `finish` arrived and the events behind
 * it did not — which is `terminado_incompleto`, and it is exactly as actionable:
 * that tablet has to reach signal before the person carrying it goes home.
 *
 * The gap that remains is a counter who tapped «Terminar» and whose `finish` has
 * not arrived either. They read as `contando`, and nothing here can tell them
 * apart from somebody still working. That is not a defect of this screen; it is
 * why `FinishEvent` carries a manifest at all.
 */
import type { SyncSnapshot } from './types';

export type MonitorTier =
  /** Expected, including a tablet nobody has heard from all morning. */
  | 'normal'
  /** Somebody has to do something, and usually before people go home. */
  | 'accion'
  /** Stopped. Nothing about it resolves itself. */
  | 'detenido';

export interface MonitorVerdict {
  tier: MonitorTier;
  /** The short reason, for the chip. Empty on the ordinary case. */
  titulo: string;
  /** What to do about it, when there is something to do. */
  detalle: string | null;
}

type CounterSync = SyncSnapshot['counters'][number];

/**
 * How long without a push before the monitor says «sin señal».
 *
 * It is a **label, not a warning**. Fifteen minutes in a cold room is a person
 * counting, and the sentence exists so the admin knows why the numbers stopped
 * moving rather than so they do anything about it.
 */
export const SIN_SENAL_MS = 15 * 60 * 1000;

export function monitorTier(counter: CounterSync, now: string): MonitorVerdict {
  if (counter.forked) {
    return {
      tier: 'detenido',
      titulo: 'dos tabletas en un enlace',
      detalle:
        'El servidor tiene dos cadenas que reclaman el mismo número. No se arregla ' +
        'solo y no se puede sellar así: hay que averiguar qué tableta es cuál.',
    };
  }
  if (counter.estado === 'terminado_incompleto') {
    return {
      tier: 'accion',
      titulo: 'terminó y faltan registros suyos',
      detalle:
        'Tocó «Terminar» y su tableta todavía tiene registros sin subir. Que se ' +
        'acerque a la señal antes de irse: es diez segundos ahora y un conteo ' +
        'incompleto después.',
    };
  }
  if (counter.estado === 'retirado' && !counter.chainComplete) {
    return {
      tier: 'accion',
      titulo: 'retirado, cadena incompleta',
      detalle:
        'Se retiró y al servidor le faltan registros suyos. Lo correcto es esperar ' +
        'la tableta; si no va a volver, hay que firmar «sellar sin sus registros».',
    };
  }
  if (counter.pendingFetch && counter.estado === 'asignado') {
    return {
      tier: 'accion',
      titulo: 'no ha descargado su asignación',
      detalle:
        'Su tableta no ha abierto el enlace. Adentro no hay señal: si entra así, ' +
        'entra sin nada que contar.',
    };
  }
  // Everything else, including a tablet that has been silent for two hours.
  const quiet =
    counter.lastServerAt === null ||
    Date.parse(now) - Date.parse(counter.lastServerAt) > SIN_SENAL_MS;
  return {
    tier: 'normal',
    titulo: quiet ? 'sin señal' : '',
    detalle: null,
  };
}

/** The class for a tier's chip. Neutral is the default and the common case. */
export function tierClass(tier: MonitorTier): string {
  switch (tier) {
    case 'detenido':
      return 'chip chip--stopped';
    case 'accion':
      return 'chip chip--action';
    case 'normal':
      return 'chip';
  }
}

/** How long the session has been open, in words. `null` before it was dispatched. */
export function elapsed(dispatchedAt: string | null, now: string): string | null {
  if (dispatchedAt === null) return null;
  const ms = Date.parse(now) - Date.parse(dispatchedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % 60} min`;
}
