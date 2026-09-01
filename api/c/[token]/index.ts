/**
 * `GET /api/c/:token` — everything one counter's tablet needs, and nothing else.
 *
 * `[token]/index.ts` rather than `[token].ts` because the token now has routes
 * under it — `events` and `resume` (P2.2) — and a file and a directory of the
 * same name at one level is a routing ambiguity nobody should have to remember
 * the resolution of.
 *
 * This is the endpoint DOMAIN.md §2.1 is about. In P1 blindness was a property
 * of what the screens drew, asserted by reading the source
 * (`tests/blindCount.test.ts`). From here on it is a property of what the
 * server sends, which is the stronger guarantee: a screen can be changed by
 * anybody, and a figure that never left the database cannot be rendered by
 * accident.
 *
 * The response is built by `counterPayload` from an explicit allowlist — a
 * denylist fails open the first time somebody adds a column, and this is a
 * mistake that has to fail closed.
 *
 * **The tablet is loaded on office wifi and then leaves.** There is no signal
 * in the bodega, so one successful fetch has to be enough: everything below is
 * resident on the device from that moment, and the dispatch screen shows which
 * counters have fetched precisely because a tablet that walks in unloaded is a
 * person who walks back out.
 */
import {
  counterPayload,
  registeredArticles,
  type Assignment,
  type Section,
} from '../../../src/domain/index.js';
import { isTokenShaped } from '../../../src/lib/token.js';
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
  findByToken,
  loadAssignments,
  loadCatalogue,
  loadItemEvents,
  loadSections,
  loadSessionRow,
  recordFetch,
} from '../../_store.js';

/** Sessions a counter may pull. A draft has no counters, so it cannot be reached. */
const OPEN_TO_COUNTERS = new Set(['abierto', 'revision']);

export interface CounterFetchOptions {
  now?: () => string;
  /**
   * Skip the `fetched_at` write. Off by default and used by nothing but a test
   * — a fetch that is not recorded is a tablet the dispatch screen believes is
   * still empty.
   */
  record?: boolean;
}

export async function counterFetch(
  db: Db,
  token: string | null,
  options: CounterFetchOptions = {},
): Promise<ApiResult> {
  const now = options.now ?? (() => new Date().toISOString());

  // Shape first, so a malformed token never reaches the database. The message
  // is the same one a valid-but-unknown token gets: telling the difference
  // apart is telling somebody their guess had the right form.
  if (!token || !isTokenShaped(token)) return fail(404, 'ese enlace no existe');

  const found = await findByToken(db, token);
  if (!found) return fail(404, 'ese enlace no existe');

  const session = await loadSessionRow(db, found.sessionId);
  if (!session) return fail(404, 'ese enlace no existe');
  if (!OPEN_TO_COUNTERS.has(session.estado)) {
    return fail(409, `esta sesión está en «${session.estado}» y no se puede contar`, {
      estado: session.estado,
    });
  }

  // A retired counter may still **push** and may still resume — their tablet may
  // be holding the only copy of a morning, and revoking the token is the one
  // action guaranteed to strand it (P2.3.5 §10). What they may not do is pull a
  // fresh assignment: they have been taken out of the count, their articles are
  // somebody else's now, and a payload here would either be empty or, worse,
  // send them back to shelves Pedro is standing at.
  if (found.counter.estado === 'retirado') {
    return fail(
      409,
      'Ya no estás en este conteo. Lo que alcanzaste a registrar sigue guardado en ' +
        'la tableta y se sube solo cuando haya señal — no borres nada y avisa al ' +
        'administrador.',
      { code: 'COUNTER_RETIRED', estado: found.counter.estado },
    );
  }

  const catalogue = await loadCatalogue(db, session.id);
  const sections: Section[] = await loadSections(db, session.id);
  const assignments: Assignment[] = await loadAssignments(db, session.id);

  // What anybody has already registered among **this counter's** articles
  // (P2.3.5 §6b). Ids, and nothing else: the same information the neutral
  // checkmark carries, which is presence and never magnitude.
  //
  // Folded with `registeredArticles` — the same function the tablet uses —
  // because deciding what «registered» means in SQL would be a second definition
  // of the fold, and the two would disagree the first time a scoped retraction
  // landed. The events are read for the counter's own articles only, so the cost
  // is proportional to the assignment rather than to the session.
  const mine = assignments
    .filter((assignment) => assignment.counterId === found.counter.id)
    .map((assignment) => assignment.idarticulo);
  const registered = registeredArticles(await loadItemEvents(db, session.id, mine));

  const payload = counterPayload({
    session: {
      id: session.id,
      bodega: session.bodega,
      fechaCorte: session.fechaCorte,
      nombre: session.nombre,
      mostrarMarcaRegistrado: session.mostrarMarcaRegistrado,
    },
    counter: {
      id: found.counter.id,
      nombre: found.counter.nombre,
      token: found.counter.token,
      estado: found.counter.estado as 'asignado',
      fetchedAt: found.counter.fetchedAt,
    },
    sections,
    assignments,
    items: catalogue.map((row) => row.item),
    registered,
  });

  // After the payload is built, so a fetch that could not be served is not
  // recorded as one that was. Before the response is written, because the
  // alternative — recording afterwards — needs a hook this handler does not
  // have and would lose the write on any error in between.
  if (options.record !== false) await recordFetch(db, found.counter.id, now());

  return ok(payload);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== undefined && req.method !== 'GET') return send(res, fail(405, 'GET'));
  try {
    return send(res, await counterFetch(dbFromEnv(), param(req, 'token')));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
