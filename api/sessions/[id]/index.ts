/**
 * `GET /api/sessions/:id`   — everything the admin screen draws.
 * `PATCH /api/sessions/:id` — the session's own settings.
 *
 * This is the **admin** view and it carries `existencia` and `costo`. That is
 * not an exception to DOMAIN.md §2.1: the rule is that a *counter* is never
 * shown what the ERP believes, because a variance is only evidence to the
 * extent the counter did not know what to find. The person dividing a bodega
 * into five sections is ranking shelves by exposure and has to see the figures.
 * `GET /api/c/:token` is the endpoint the rule applies to, and it is built from
 * an allowlist for exactly that reason.
 */
import {
  isVerifiedTriple,
  sourceHashOfBytes,
  unverifiedParameters,
  type PostingParameters,
} from '../../../src/app';
import {
  assignmentCoverage,
  deriveFamilies,
  dispatchBlockers,
  unassignedByFamily,
  type Assignment,
  type Counter,
  type Section,
  type SessionEstado,
} from '../../../src/domain';
import { dbFromEnv, NoDatabaseError, type Db } from '../../_db';
import {
  fail,
  messageOf,
  ok,
  param,
  send,
  type ApiRequest,
  type ApiResponse,
  type ApiResult,
} from '../../_http';
import {
  loadAssignments,
  loadCatalogue,
  loadCounters,
  loadSections,
  loadSessionRow,
  loadSourceBytes,
  type SessionRow,
} from '../../_store';

export function parametersOf(session: SessionRow): PostingParameters {
  return {
    countTargetColumn: session.countTargetColumn as PostingParameters['countTargetColumn'],
    uncountedPolicy: session.uncountedPolicy as PostingParameters['uncountedPolicy'],
    differenceColumn: session.differenceColumn as PostingParameters['differenceColumn'],
  };
}

export function toCounters(
  rows: { id: string; nombre: string; token: string; estado: string; fetchedAt: string | null }[],
): Counter[] {
  return rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    token: row.token,
    estado: row.estado as Counter['estado'],
    fetchedAt: row.fetchedAt,
  }));
}

/**
 * Whether the stored bytes still hash to what the session was imported as.
 *
 * Re-parsed and re-rendered rather than digested raw, because `sourceHash` is
 * the hash of the canonical `.txt` rendering — that is what makes an `.xls` and
 * the `.txt` beside it the same snapshot (DOMAIN.md §6). Doing it here rather
 * than storing a second digest means the check exercises the parser the export
 * will use, not a number somebody wrote down.
 */
export async function fileIsIntact(db: Db, session: SessionRow): Promise<boolean> {
  const bytes = await loadSourceBytes(db, session.id);
  if (!bytes) return false;
  try {
    return sourceHashOfBytes(bytes) === session.sourceHash;
  } catch {
    return false;
  }
}

export async function getSession(db: Db, id: string): Promise<ApiResult> {
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'esa sesión no existe');

  const catalogue = await loadCatalogue(db, id);
  const items = catalogue.map((row) => row.item);
  const counterRows = await loadCounters(db, id);
  const sectionRows = await loadSections(db, id);
  const assignmentRows = await loadAssignments(db, id);

  const counters = toCounters(counterRows);
  const sections: Section[] = sectionRows;
  const assignments: Assignment[] = assignmentRows;
  const coverage = assignmentCoverage(items, assignments);
  const parameters = parametersOf(session);

  return ok({
    session: {
      ...session,
      parameters,
      parametrosVerificados: isVerifiedTriple(parameters),
      parametrosSinVerificar: unverifiedParameters(parameters),
    },
    items,
    familias: deriveFamilies(items),
    counters: counterRows,
    sections: sectionRows,
    assignments: assignmentRows,
    coverage,
    huecos: unassignedByFamily(items, coverage),
    // Computed here so the screen and the dispatch endpoint agree about what is
    // wrong before the admin presses anything. The `archivoIntacto` read costs a
    // re-parse of the stored file, which is worth it: an admin who is going to
    // be told the file changed should be told on the screen where they can do
    // something about it, not by a refusal.
    blockers: dispatchBlockers({
      estado: session.estado as SessionEstado,
      items,
      counters,
      sections,
      assignments,
      archivoIntacto: await fileIsIntact(db, session),
      parametrosVerificados: isVerifiedTriple(parameters),
    }),
  });
}

export interface PatchSessionBody {
  nombre?: string | null;
  mostrarMarcaRegistrado?: boolean;
}

/**
 * The session's own settings.
 *
 * `mostrarMarcaRegistrado` stays editable after dispatch, which is the whole
 * reason it is config rather than a build flag: the jefe may want the neutral
 * checkmark gone after seeing it in use, and that has to be a toggle rather
 * than a deploy. The honest caveat is that a tablet already in the bodega will
 * not hear about it — there is no signal in there — so it takes effect for
 * devices that fetch again, and the screen says so.
 *
 * The posting parameters are deliberately **not** patchable. They are what the
 * count is taken under; changing them after counting has begun would rewrite
 * the meaning of events already recorded.
 */
export async function updateSession(db: Db, id: string, body: unknown): Promise<ApiResult> {
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'esa sesión no existe');
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'el cuerpo de la petición no es un objeto');
  }
  const input = body as PatchSessionBody;

  if ('parameters' in input) {
    return fail(
      409,
      'los parámetros de subida no se cambian después de crear la sesión: son las ' +
        'condiciones bajo las que se está contando.',
    );
  }

  const sets: string[] = [];
  const params: unknown[] = [id];
  if (input.nombre !== undefined) {
    params.push(input.nombre === null || input.nombre.trim() === '' ? null : input.nombre.trim());
    sets.push(`nombre = $${params.length}`);
  }
  if (input.mostrarMarcaRegistrado !== undefined) {
    params.push(input.mostrarMarcaRegistrado);
    sets.push(`mostrar_marca_registrado = $${params.length}`);
  }
  if (sets.length === 0) return fail(400, 'no hay nada que cambiar');

  await db.query(`update sessions set ${sets.join(', ')} where id = $1`, params);
  return getSession(db, id);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = param(req, 'id');
  if (!id) return send(res, fail(400, 'falta el id de la sesión'));
  try {
    const db = dbFromEnv();
    if (req.method === 'PATCH') return send(res, await updateSession(db, id, req.body));
    if (req.method === undefined || req.method === 'GET') return send(res, await getSession(db, id));
    return send(res, fail(405, 'GET o PATCH'));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
