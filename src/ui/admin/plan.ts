/**
 * The partition the admin is building, before it is anything the server knows.
 *
 * Held in the browser and mirrored into `localStorage`, because it is thirty
 * minutes of somebody's judgement and a reload should not cost it. It becomes
 * durable at dispatch and not before: until then there is nothing to be
 * inconsistent with, and a half-saved partition on the server is a state the
 * dispatch gate would have to reason about for no benefit.
 *
 * **Sections carry a counter's *name*, not an id.** The counters do not exist
 * until dispatch mints them, and letting the browser choose the ids would mean
 * a client choosing the identity the hash chain is later anchored to
 * (`src/domain/chain.ts`).
 */
import {
  assignmentCoverage,
  dispatchBlockers,
  unassignedByFamily,
  type Assignment,
  type AssignmentCoverage,
  type Counter,
  type CoverageGap,
  type DispatchBlocker,
  type Item,
  type Section,
} from '../../domain';

export interface DraftSection {
  id: string;
  nombre: string;
  /** Empty while the admin has not said who walks it. A blocker at dispatch. */
  counterNombre: string;
}

export interface Plan {
  sections: DraftSection[];
  /** `idarticulo -> section id`. The resolved fact, never the rule that produced it. */
  asignado: Record<number, string>;
  /** What the admin decided a family prefix is called. Prefix -> label. */
  etiquetas: Record<string, string>;
}

export const EMPTY_PLAN: Plan = { sections: [], asignado: {}, etiquetas: {} };

const KEY = 'conteo.reparto';

export function loadPlan(sessionId: string): Plan {
  try {
    const raw = globalThis.localStorage?.getItem(`${KEY}.${sessionId}`);
    if (!raw) return EMPTY_PLAN;
    const parsed = JSON.parse(raw) as Partial<Plan>;
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      asignado: parsed.asignado ?? {},
      etiquetas: parsed.etiquetas ?? {},
    };
  } catch {
    // A corrupt draft is a partition to rebuild, not a screen that will not
    // open. There is nothing here that cannot be redone.
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

/** Distinct counter names, in the order the sections introduce them. */
export function countersIn(plan: Plan): string[] {
  const names: string[] = [];
  for (const section of plan.sections) {
    const nombre = section.counterNombre.trim();
    if (nombre !== '' && !names.includes(nombre)) names.push(nombre);
  }
  return names;
}

/**
 * The draft in the domain's own vocabulary, so the screen and the server ask
 * the same functions the same question.
 *
 * A counter's id here is their **name**, which is exactly what dispatch will
 * key on when it mints the real ones. That keeps `dispatchBlockers` honest
 * about "one counter per article" without inventing identities.
 */
export function asDomain(plan: Plan): {
  counters: Counter[];
  sections: Section[];
  assignments: Assignment[];
} {
  const counterOf = new Map(
    plan.sections.map((section) => [section.id, section.counterNombre.trim()]),
  );
  return {
    counters: countersIn(plan).map((nombre) => ({
      id: nombre,
      nombre,
      token: '',
      estado: 'asignado' as const,
      fetchedAt: null,
    })),
    sections: plan.sections.map((section) => ({
      id: section.id,
      nombre: section.nombre,
      counterId: section.counterNombre.trim() === '' ? null : section.counterNombre.trim(),
    })),
    assignments: Object.entries(plan.asignado).flatMap(([idarticulo, sectionId]) => {
      const counterId = counterOf.get(sectionId);
      // An assignment to a section that has since been removed is dropped
      // rather than carried: it will read as an uncovered article, which is
      // what it is, instead of as a reference nobody can resolve.
      if (counterId === undefined) return [];
      return [{ idarticulo: Number(idarticulo), counterId, sectionId }];
    }),
  };
}

export interface PlanState {
  coverage: AssignmentCoverage;
  huecos: CoverageGap[];
  blockers: DispatchBlocker[];
}

/**
 * Where the plan stands, computed with the same functions the server will use.
 *
 * `archivoIntacto` and `parametrosVerificados` come from the server's own view
 * of the session — the browser cannot check either, and pretending it can would
 * mean a screen that says "listo" about something dispatch is going to refuse.
 */
export function planState(
  items: readonly Item[],
  plan: Plan,
  server: { estado: string; archivoIntacto: boolean; parametrosVerificados: boolean },
): PlanState {
  const domain = asDomain(plan);
  const coverage = assignmentCoverage(items, domain.assignments);
  return {
    coverage,
    huecos: unassignedByFamily(items, coverage),
    blockers: dispatchBlockers({
      estado: server.estado as 'borrador',
      items,
      counters: domain.counters,
      sections: domain.sections,
      assignments: domain.assignments,
      archivoIntacto: server.archivoIntacto,
      parametrosVerificados: server.parametrosVerificados,
    }),
  };
}

/** The body `POST /api/sessions/:id/dispatch` takes: counters, each with their sections. */
export function dispatchBody(plan: Plan): {
  counters: { nombre: string; secciones: { nombre: string; idarticulos: number[] }[] }[];
} {
  const byArticle = plan.asignado;
  return {
    counters: countersIn(plan).map((nombre) => ({
      nombre,
      secciones: plan.sections
        .filter((section) => section.counterNombre.trim() === nombre)
        .map((section) => ({
          nombre: section.nombre,
          idarticulos: Object.keys(byArticle)
            .filter((idarticulo) => byArticle[Number(idarticulo)] === section.id)
            .map(Number)
            .sort((a, b) => a - b),
        })),
    })),
  };
}

/** A section id that does not collide with anything in the plan. */
export function newSectionId(plan: Plan): string {
  const used = new Set(plan.sections.map((section) => section.id));
  for (let n = 1; ; n++) {
    const id = `s${n}`;
    if (!used.has(id)) return id;
  }
}

/** Move a set of articles into a section, or out of every section when `null`. */
export function move(plan: Plan, idarticulos: readonly number[], sectionId: string | null): Plan {
  const asignado = { ...plan.asignado };
  for (const idarticulo of idarticulos) {
    if (sectionId === null) delete asignado[idarticulo];
    else asignado[idarticulo] = sectionId;
  }
  return { ...plan, asignado };
}

/**
 * Split a list of articles into `parts` contiguous chunks.
 *
 * Contiguous rather than round-robin: the order is the order Zeus exported,
 * which is the order of the printed list and, roughly, of the shelf. Dealing
 * every third row to a different person sends three people down one aisle.
 */
export function chunk(idarticulos: readonly number[], parts: number): number[][] {
  const out: number[][] = [];
  const size = Math.ceil(idarticulos.length / parts);
  for (let i = 0; i < parts; i++) {
    const slice = idarticulos.slice(i * size, (i + 1) * size);
    if (slice.length > 0) out.push([...slice]);
  }
  return out;
}
