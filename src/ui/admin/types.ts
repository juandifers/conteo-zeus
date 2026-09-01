/**
 * The shapes the admin screens receive.
 *
 * Declared here rather than imported from `api/`: the browser bundle must not
 * pull a serverless handler in, and these are the wire contract rather than the
 * handler's internals. Where a type is genuinely the same thing — a
 * `DispatchBlocker`, an `Item`, a `FamilyGroup` — it comes from the domain,
 * which both sides already share.
 */
import type {
  AssignmentCoverage,
  CoverageGap,
  DispatchBlocker,
  FamilyGroup,
  Item,
} from '../../domain';

export interface SessionSummary {
  id: string;
  bodega: string;
  fechaCorte: string;
  nombre: string | null;
  estado: string;
  sourceName: string | null;
  sourceHash: string;
  createdAt: string;
  dispatchedAt: string | null;
  itemCount: number;
  mostrarMarcaRegistrado: boolean;
}

export interface AdminCounter {
  id: string;
  nombre: string;
  token: string;
  estado: string;
  /** `null` until that counter's tablet has pulled its assignment. */
  fetchedAt: string | null;
  fetchCount: number;
}

export interface AdminSection {
  id: string;
  nombre: string;
  counterId: string | null;
}

export interface AdminAssignment {
  idarticulo: number;
  counterId: string;
  sectionId: string;
}

export interface SessionDetail {
  session: SessionSummary & {
    parameters: { countTargetColumn: string; uncountedPolicy: string; differenceColumn: string };
    parametrosVerificados: boolean;
    parametrosSinVerificar: string[];
  };
  items: Item[];
  /** `null` when the guards refused to propose a partition — see `deriveFamilies`. */
  familias: FamilyGroup[] | null;
  counters: AdminCounter[];
  sections: AdminSection[];
  assignments: AdminAssignment[];
  coverage: AssignmentCoverage;
  huecos: CoverageGap[];
  blockers: DispatchBlocker[];
}

/** What dispatch answers with: the links, and what is behind each one. */
export interface DispatchResult {
  estado: string;
  dispatchedAt: string;
  counters: {
    id: string;
    nombre: string;
    token: string;
    articulos: number;
    secciones: { nombre: string; articulos: number }[];
  }[];
}
