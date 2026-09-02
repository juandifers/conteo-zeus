/**
 * The plan the admin is building, before it is anything the server knows.
 *
 * Since P2.6 the plan is just the roster: the people counting today. The
 * bodega is divided outside the app — counters coordinate on the floor, by the
 * layout in front of them — and every tablet receives the whole catalogue, so
 * there is no partition to draw here and the app deliberately stays out of it.
 *
 * Held in the browser and mirrored into `localStorage`, because a list of
 * names typed at six in the evening should survive a reload. It becomes
 * durable at dispatch and not before.
 *
 * The sectioned planner this replaces (sections, `asignado`, coverage) is
 * disabled rather than removed: the server still accepts a sectioned dispatch
 * body and still serves sectioned sessions, and the domain machinery is all
 * still there. What is gone is this screen's use of it.
 */
import {
  sharedDispatchBlockers,
  type DispatchBlocker,
} from '../../domain';

export interface Plan {
  /** The people counting today, in the order they were written down. */
  roster: string[];
}

export const EMPTY_PLAN: Plan = { roster: [] };

const KEY = 'conteo.reparto';

/** What a pre-P2.6 draft looked like, as much of it as migration reads. */
interface StoredDraft {
  roster?: unknown;
  sections?: { counterNombre?: string }[];
}

export function loadPlan(sessionId: string): Plan {
  try {
    const raw = globalThis.localStorage?.getItem(`${KEY}.${sessionId}`);
    if (!raw) return EMPTY_PLAN;
    const parsed = JSON.parse(raw) as StoredDraft;
    const stored = Array.isArray(parsed.roster)
      ? parsed.roster.filter((name): name is string => typeof name === 'string')
      : [];
    // A draft saved by the sectioned planner still has its people — some on the
    // roster, some only inside sections. Folding the section names in means an
    // old draft opens with everybody listed instead of claiming nobody counts.
    const roster = [...stored];
    for (const section of Array.isArray(parsed.sections) ? parsed.sections : []) {
      const nombre = section.counterNombre?.trim() ?? '';
      if (nombre !== '' && !roster.includes(nombre)) roster.push(nombre);
    }
    return { roster };
  } catch {
    // A corrupt draft is a list of names to retype, not a screen that will not
    // open.
    return EMPTY_PLAN;
  }
}

export function savePlan(sessionId: string, plan: Plan): void {
  try {
    globalThis.localStorage?.setItem(`${KEY}.${sessionId}`, JSON.stringify(plan));
  } catch {
    // Private mode, or a full quota. Losing the draft is survivable; refusing
    // to let somebody keep working is not.
  }
}

/**
 * Where the plan stands, computed with the same gate the server will run.
 *
 * `archivoIntacto` and `parametrosVerificados` come from the server's own view
 * of the session — the browser cannot check either, and pretending it can
 * would mean a screen that says «listo» about something dispatch is going to
 * refuse.
 */
export function planState(
  plan: Plan,
  server: { estado: string; archivoIntacto: boolean; parametrosVerificados: boolean },
): { blockers: DispatchBlocker[] } {
  return {
    blockers: sharedDispatchBlockers({
      estado: server.estado as 'borrador',
      counters: plan.roster.map((nombre) => ({ id: nombre, nombre })),
      archivoIntacto: server.archivoIntacto,
      parametrosVerificados: server.parametrosVerificados,
    }),
  };
}

/**
 * The body `POST /api/sessions/:id/dispatch` takes for a shared dispatch:
 * names, and nothing else. No `secciones` key on any counter is what tells the
 * server this is the shared mode.
 */
export function dispatchBody(plan: Plan): { counters: { nombre: string }[] } {
  return { counters: plan.roster.map((nombre) => ({ nombre })) };
}
