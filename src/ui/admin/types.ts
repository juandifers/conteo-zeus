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
  HandoverRisk,
  Item,
  ReassignBlocker,
  SealBlocker,
  SessionActionRecord,
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
  /**
   * What a reassignment has to be planned against (P2.3.5 §7).
   *
   * Sent back with the move list and checked under the row lock; a mismatch is a
   * `409` and the screen reloads. Two admins reassigning at once is P2.2's
   * transaction bug with a worse blast radius — the second write would silently
   * *reverse* the first — and move lists are never merged, because two
   * partitions that each make sense do not make sense unioned.
   */
  assignmentsVersion: number;
}

export interface AdminCounter {
  id: string;
  nombre: string;
  token: string;
  /** `asignado | contando | terminado_* | retirado` — see `CounterEstado`. */
  estado: string;
  /** `null` until that counter's tablet has pulled its assignment. */
  fetchedAt: string | null;
  fetchCount: number;
  /**
   * When the server last accepted anything from them, or `null`.
   *
   * Read by the reassignment screen (P2.3.5 §4b): moving articles away from a
   * counter the server has not heard from in an hour can produce a double count
   * that **nothing in the system can prevent**, because prevention would mean
   * reaching a tablet in a cold room. The screen's job is to make that visible
   * at the moment of the decision.
   */
  lastServerAt: string | null;
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

/** What `POST /api/sessions/:id/acciones` answers with, for a reassignment. */
export interface ReassignResult {
  assignmentsVersion: number;
  movidos: number;
  seccionesCreadas: { id: string; nombre: string; counterId: string }[];
  seccionesReapuntadas: { id: string; nombre: string; from: string; to: string }[];
  sinSincronizar: HandoverRisk[];
  /** Links for the printable sheet: a counter added at eleven needs the same QR. */
  nuevos: { id: string; nombre: string; token: string }[];
}

/** The `detalle` a refused reassignment carries. */
export interface ReassignRefusal {
  blockers?: ReassignBlocker[];
  code?: string;
  idarticulos?: number[];
  assignmentsVersion?: number;
}

/** `GET /api/sessions/:id/sync` — the admin's cheap poll, as P2.3.5 leaves it. */
export interface SyncSnapshot {
  session: {
    id: string;
    estado: string;
    assignmentsVersion: number;
    readyToSeal: SealBlocker[];
  };
  counters: {
    id: string;
    nombre: string;
    estado: string;
    storedMaxSeq: number;
    headHash: string | null;
    lastServerAt: string | null;
    /** Every device that has pushed for this counter. More than one is a handover. */
    deviceIds: string[];
    /** How far that device's clock ran from the server's, or `null` before a push. */
    clockSkewMs: number | null;
    forked: boolean;
    finishReason: string | null;
    pendingFetch: boolean;
    chainComplete: boolean;
  }[];
  acciones: SessionActionRecord[];
  /** P2.5. Null until the seal. */
  sello: Sello | null;
}

/** What the seal recorded, and what the export added to it. */
export interface Sello {
  sealedAt: string;
  sessionHash: string;
  exportedAt: string | null;
  fileHash: string | null;
  /** The catalogue the counts were taken against. Inside `sessionHash`. */
  sourceHash: string;
  /**
   * Events the server accepted after `sealedAt`.
   *
   * Always empty: the insert is guarded on the session still being open and
   * takes the session row `for share`, so a push and a seal cannot overlap. It
   * is rendered anyway, apart from the sealed set — an event in the database and
   * outside the certificate is the one thing this screen must be able to show
   * rather than argue is impossible.
   */
  tardios: { id: string; counterId: string; seq: number; serverAt: string }[];
}

/** What `POST /api/sessions/:id/sellar` answers with. */
export interface SealResult {
  estado: string;
  sealedAt: string;
  sessionHash: string;
  sourceHash: string;
  contadores: number;
  sinRegistros?: { counterId: string; faltan: string };
}

/** What `POST /api/sessions/:id/exportar` answers with. */
export interface ExportResult {
  estado: string;
  exportedAt: string;
  fileHash: string;
  filename: string;
  filas: number;
  contados: number;
  exonerados: number;
  sinTocar: number;
  parameters: { countTargetColumn: string; uncountedPolicy: string; differenceColumn: string };
}

/** What `GET /api/sessions/:id/exportar` answers with: the stored bytes, base64. */
export interface ExportFile {
  filename: string;
  fileHash: string;
  base64: string;
  bytes: number;
  exportedAt: string | null;
}

/** What `GET /api/sessions/:id/bundle` answers with: the canonical JSON, verbatim. */
export interface BundleFile {
  filename: string;
  canonical: string;
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
