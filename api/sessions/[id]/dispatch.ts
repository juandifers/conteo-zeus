/**
 * `POST /api/sessions/:id/dispatch` — `borrador -> abierto`, and the gate.
 *
 * The moment the tablets can be handed out. Everything the admin built in the
 * browser arrives here as one plan and is written in one transaction, because a
 * half-dispatched session is a session where some counters have links and some
 * shelves have nobody.
 *
 * **The plan is validated before it is written, against the catalogue as this
 * database holds it.** Not against what the browser thinks the catalogue is: an
 * admin with a stale tab could otherwise dispatch a partition covering
 * articles that are not in the file. `dispatchBlockers` is the same function
 * the admin screen renders its warnings from, so the refusal is never a
 * surprise — it is the screen's own list, arrived at again on the other side of
 * the network.
 */
import {
  isVerifiedTriple,
  type PostingParameters,
} from '../../../src/app/index.js';
import {
  counterPayload,
  dispatchBlockers,
  sharedDispatchBlockers,
  sharedScope,
  type Assignment,
  type Counter,
  type Section,
  type SessionEstado,
} from '../../../src/domain/index.js';
import { newToken } from '../../../src/lib/token.js';
import { dbFromEnv, NoDatabaseError, type Db } from '../../_db.js';
import {
  fail,
  messageOf,
  ok,
  param,
  send,
  type ApiRequest,
  type ApiResponse,
  type ApiResult,
} from '../../_http.js';
import {
  dispatchStatements,
  loadCatalogue,
  loadSessionRow,
  type DispatchPlan,
} from '../../_store.js';
import { fileIsIntact, parametersOf } from './index.js';

/**
 * The plan, as the admin built it.
 *
 * Names and article ids, not database ids: the counters and sections do not
 * exist yet, and letting the browser choose their primary keys would mean
 * trusting a client with the identity the hash chain is later anchored to.
 *
 * Two shapes share this body, told apart by whether any counter carries
 * `secciones` (P2.6):
 *
 *   - **Shared** — names only. Every counter's tablet receives the whole
 *     catalogue; no sections and no assignments are written, and the bodega is
 *     divided outside the app by the people standing in it. This is what the
 *     admin screen sends.
 *   - **Sectioned** — the P2.1 partition, kept working because the machinery
 *     under it (reassignment, zonas, the coverage gate) is disabled for now
 *     rather than removed, and because every dispatched session before P2.6
 *     was built this way.
 *
 * Mixing the two — one counter with sections, one without — is a malformed
 * body, not a plan.
 */
export interface DispatchBody {
  counters: {
    nombre: string;
    secciones?: { nombre: string; idarticulos: number[] }[];
  }[];
}

/** Whether a body asks for the shared dispatch: no counter names a section. */
export function isSharedBody(body: DispatchBody): boolean {
  return body.counters.every((counter) => counter.secciones === undefined);
}

export interface DispatchOptions {
  newId?: () => string;
  mintToken?: () => string;
  now?: () => string;
}

/** Everything the plan needs turned into rows, with ids and tokens minted here. */
export function planFrom(
  body: DispatchBody,
  options: Required<Pick<DispatchOptions, 'newId' | 'mintToken'>>,
): DispatchPlan {
  const counters: DispatchPlan['counters'] = [];
  const sections: DispatchPlan['sections'] = [];
  const assignments: DispatchPlan['assignments'] = [];

  for (const counter of body.counters) {
    const counterId = options.newId();
    counters.push({ id: counterId, nombre: counter.nombre.trim(), token: options.mintToken() });
    for (const section of counter.secciones ?? []) {
      const sectionId = options.newId();
      sections.push({ id: sectionId, nombre: section.nombre.trim(), counterId });
      for (const idarticulo of section.idarticulos) {
        assignments.push({ idarticulo, counterId, sectionId });
      }
    }
  }
  return { counters, sections, assignments };
}

/** Shape checks, before anything is minted. A blocker is about a plan; these are about a body. */
export function malformed(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'el cuerpo de la petición no es un objeto';
  const input = body as Partial<DispatchBody>;
  if (!Array.isArray(input.counters)) return 'falta la lista de contadores';
  const nombres = new Set<string>();
  const seccionNombres = new Set<string>();
  for (const counter of input.counters) {
    if (typeof counter?.nombre !== 'string' || counter.nombre.trim() === '') {
      return 'cada contador necesita un nombre';
    }
    if (nombres.has(counter.nombre.trim())) {
      // Two counters called "Ana" on one printed sheet are two people nobody
      // can tell apart when a chain turns out to have a gap in it.
      return `hay dos contadores llamados «${counter.nombre.trim()}»`;
    }
    nombres.add(counter.nombre.trim());
    // No `secciones` at all is the shared dispatch (P2.6) — but only if it is
    // nobody's. Half a partition is not a plan, and the honest reading of one
    // counter with sections and one without is a bug in whatever sent this.
    if (counter.secciones === undefined) {
      if (!input.counters.every((other) => other?.secciones === undefined)) {
        return 'unos contadores traen secciones y otros no: eso no es ni un reparto ni un conteo compartido';
      }
      continue;
    }
    if (!Array.isArray(counter.secciones)) return `«${counter.nombre}» no trae secciones`;
    for (const section of counter.secciones) {
      if (typeof section?.nombre !== 'string' || section.nombre.trim() === '') {
        return 'cada sección necesita un nombre';
      }
      if (seccionNombres.has(section.nombre.trim())) {
        // `sections` is unique on `(session_id, nombre)`, so this would be a
        // constraint violation with no readable message. It is also the name
        // that becomes `zona` on every event, and two zones with one name are
        // two places nobody can separate afterwards.
        return `hay dos secciones llamadas «${section.nombre.trim()}»`;
      }
      seccionNombres.add(section.nombre.trim());
      if (!Array.isArray(section.idarticulos)) return `«${section.nombre}» no trae artículos`;
      if (section.idarticulos.some((id) => !Number.isInteger(id))) {
        return `«${section.nombre}» trae un idarticulo que no es un entero`;
      }
    }
  }
  return null;
}

export async function dispatchSession(
  db: Db,
  id: string,
  body: unknown,
  options: DispatchOptions = {},
): Promise<ApiResult> {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const mintToken = options.mintToken ?? newToken;
  const now = options.now ?? (() => new Date().toISOString());

  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'esa sesión no existe');

  const problem = malformed(body);
  if (problem) return fail(400, problem);

  const plan = planFrom(body as DispatchBody, { newId, mintToken });
  const catalogue = await loadCatalogue(db, id);
  const items = catalogue.map((row) => row.item);
  const parameters: PostingParameters = parametersOf(session);

  const counters: Counter[] = plan.counters.map((counter) => ({
    ...counter,
    estado: 'asignado',
    fetchedAt: null,
  }));
  const compartido = isSharedBody(body as DispatchBody);
  const sections: Section[] = plan.sections;
  const assignments: Assignment[] = plan.assignments;

  const blockers = compartido
    ? sharedDispatchBlockers({
        estado: session.estado as SessionEstado,
        counters,
        archivoIntacto: await fileIsIntact(db, session),
        parametrosVerificados: isVerifiedTriple(parameters),
      })
    : dispatchBlockers({
        estado: session.estado as SessionEstado,
        items,
        counters,
        sections,
        assignments,
        archivoIntacto: await fileIsIntact(db, session),
        parametrosVerificados: isVerifiedTriple(parameters),
      });
  if (blockers.length > 0) {
    return fail(409, 'la sesión todavía no se puede despachar', { blockers });
  }

  // Built before the write, not after: `counterPayload` refuses a partition
  // where an article falls in a section its counter does not hold, and finding
  // that out after the transaction would mean an open session with a tablet
  // that cannot be loaded. It is also the cheapest possible rehearsal of the
  // endpoint the counters are about to hit. A shared dispatch rehearses the
  // same synthesized scope `GET /api/c/:token` will serve.
  const payloads = counters.map((counter) => {
    const scope = compartido ? sharedScope(counter.id, items) : { sections, assignments };
    return counterPayload({
      session: {
        id: session.id,
        bodega: session.bodega,
        fechaCorte: session.fechaCorte,
        nombre: session.nombre,
        mostrarMarcaRegistrado: session.mostrarMarcaRegistrado,
      },
      counter,
      sections: scope.sections,
      assignments: scope.assignments,
      items,
    });
  });

  const results = await db.transaction(dispatchStatements(id, plan, now()));
  // The final statement is `update … where estado = 'borrador' returning id`.
  // No row means somebody else opened this session between the read above and
  // the write — two admins on two laptops — and the transaction has already
  // rolled back, so nothing was minted.
  const opened = results[results.length - 1];
  if (!opened || opened.length === 0) {
    return fail(409, 'alguien más despachó esta sesión mientras preparabas el reparto');
  }

  return ok({
    estado: 'abierto',
    dispatchedAt: now(),
    counters: counters.map((counter, index) => ({
      id: counter.id,
      nombre: counter.nombre,
      token: counter.token,
      secciones: payloads[index].secciones.map((section) => ({
        nombre: section.nombre,
        articulos: section.items.length,
      })),
      articulos: payloads[index].secciones.reduce((total, s) => total + s.items.length, 0),
    })),
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = param(req, 'id');
  if (!id) return send(res, fail(400, 'falta el id de la sesión'));
  if (req.method !== 'POST') return send(res, fail(405, 'POST'));
  try {
    return send(res, await dispatchSession(dbFromEnv(), id, req.body));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
