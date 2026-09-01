/**
 * `/api/sessions/:id/acciones` — the admin's own append-only log, and the four
 * things that write to it (P2.3.5).
 *
 * **One endpoint, not four.** «Luis se fue enfermo», «metamos a Carla», «María
 * nunca llegó» and «Ana que ayude con abarrotes» are one operation —
 * reassigning articles between counters while a session is open, plus sometimes
 * creating or retiring a counter. Four flows would be four partial answers that
 * disagree; what they share is everything that matters here: the row lock, the
 * `usuario` and `motivo` that make an action attributable, the chain append, and
 * the rule that no state moves unless the record of why moved with it.
 *
 * Every write is guarded inside its transaction, and the guard is not belt and
 * braces over the checks above it. `dispatchStatements` established the shape
 * and the reason (P2.2's transaction bug): Neon's HTTP protocol has no session
 * to hold an interactive transaction open across, so the decision is taken
 * outside it, and **an unmatched `update` raises nothing** — a guard on the last
 * statement would guard nothing, because the earlier ones would already have
 * committed.
 *
 * The two open policy calls in the brief are settled here and are worth naming
 * because both are visible in this file:
 *
 *   - **A retired counter's token still accepts pushes** and refuses a fresh
 *     assignment fetch (`api/c/[token]/index.ts`). Revoking it outright is the
 *     one action guaranteed to strand whatever is still on their tablet, and
 *     that tablet is holding the only copy of somebody's morning.
 *   - **Reassignment is allowed in `revision`**, because review is exactly when
 *     a gap is found and somebody is sent back. The consequence is deliberate:
 *     a session can move backwards from «everyone finished», and «todos
 *     terminaron» is not final until the seal.
 */
import {
  actionGenesisHash,
  annullable,
  chainActionHash,
  handoverRisk,
  planReassignment,
  reassignBlockers,
  REASSIGNABLE,
  seqRanges,
  verifyActionChain,
  waiverBlockers,
  type ActionPayload,
  type AgregarContadorPayload,
  type AnularWaiverPayload,
  type Assignment,
  type ChainableAction,
  type Move,
  type NewCounter,
  type ReasignarPayload,
  type RetirarContadorPayload,
  type Section,
  type SellarSinRegistrosPayload,
  type SessionActionKind,
  type SessionActionRecord,
  type SessionEstado,
  type StoredAction,
  type WaiverPayload,
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
  actionStatements,
  loadAssignments,
  loadCatalogueIds,
  loadCounterChain,
  loadCounters,
  loadSections,
  loadSessionActions,
  loadSessionRow,
  reassignStatements,
  retireStatements,
  type ActionWire,
  type SessionActionRow,
} from '../../_store.js';

/** What the browser sends. Discriminated on `kind`, like the chain it writes to. */
export type ActionBody =
  | {
      kind: 'reasignar';
      usuario: string;
      motivo: string;
      /** `sessions.assignments_version` the plan was built against (§7). */
      version: number;
      moves: Move[];
      /** Counters minted in the same transaction. §3: they cannot arrive empty-handed. */
      nuevos?: NewCounter[];
    }
  | { kind: 'retirar_contador'; usuario: string; motivo: string; counterId: string }
  | { kind: 'sellar_sin_registros'; usuario: string; motivo: string; counterId: string }
  /**
   * P2.4 §4 — the admin's resolution for rows nobody counted.
   *
   * No quantity in the body and none in the payload. The waived value is
   * `existencia` from `catalog_rows`, read at the moment somebody asks; a copy
   * in the action would be a second figure that can disagree with the first.
   */
  | { kind: 'waiver'; usuario: string; motivo: string; idarticulo: number[] }
  | { kind: 'anular_waiver'; usuario: string; motivo: string; waiverId: string };

export interface ActionOptions {
  now?: () => string;
  newId?: () => string;
  mintToken?: () => string;
  /** How long since a counter's last push counts as «not recently seen» (§4b). */
  staleAfterMs?: number;
}

/** Sessions whose partition may still be changed. `REASSIGNABLE` as an array, for SQL. */
const ESTADOS = [...REASSIGNABLE];

export function rowToRecord(row: SessionActionRow): SessionActionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    kind: row.kind as SessionActionKind,
    payload: row.payload as ActionPayload,
    usuario: row.usuario,
    at: row.clientAt,
    serverAt: row.serverAt,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

function asStored(record: SessionActionRecord): StoredAction {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    kind: record.kind,
    payload: record.payload,
    usuario: record.usuario,
    at: record.at,
    prevHash: record.prevHash,
    hash: record.hash,
  };
}

/**
 * `GET` — the log, and whether it verifies.
 *
 * The verdict travels with the rows rather than being something a caller
 * remembers to ask for. A chain nobody checks is a chain that is not doing
 * anything, and this is the read P2.4's review screen and P2.5's acta are both
 * built on.
 */
export async function listActions(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const acciones = (await loadSessionActions(db, id)).map(rowToRecord);
  return ok({
    acciones,
    cadena: verifyActionChain(id, acciones.map(asStored)),
    assignmentsVersion: session.assignmentsVersion,
  });
}

/** Shape checks, before anything is minted or hashed. */
function malformed(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'el cuerpo de la petición no es un objeto';
  const input = body as Partial<ActionBody>;
  if (typeof input.usuario !== 'string' || input.usuario.trim() === '') {
    // Not a formality. An admin action with nobody on it is exactly what this
    // chain exists to prevent, and `canonicalAction` refuses to hash one.
    return 'falta el nombre de quien decide';
  }
  if (typeof input.motivo !== 'string' || input.motivo.trim() === '') {
    return 'falta el motivo: la razón por la que un artículo cambió de manos no se ' +
      'reconstruye después mirando dos tablas de asignaciones';
  }
  switch (input.kind) {
    case 'reasignar': {
      if (!Number.isSafeInteger(input.version)) return 'falta la versión del reparto';
      if (!Array.isArray(input.moves)) return 'falta la lista de movimientos';
      for (const move of input.moves) {
        if (!Number.isInteger(move?.idarticulo)) return 'un movimiento no trae idarticulo';
        if (typeof move.from !== 'string' || typeof move.to !== 'string') {
          return 'un movimiento no dice de quién a quién';
        }
      }
      for (const counter of input.nuevos ?? []) {
        if (typeof counter?.nombre !== 'string' || counter.nombre.trim() === '') {
          return 'cada contador nuevo necesita un nombre';
        }
        if (typeof counter.ref !== 'string' || counter.ref === '') {
          return 'cada contador nuevo necesita una referencia para los movimientos';
        }
      }
      return null;
    }
    case 'retirar_contador':
    case 'sellar_sin_registros':
      return typeof input.counterId === 'string' && input.counterId !== ''
        ? null
        : 'falta el contador';
    case 'waiver': {
      if (!Array.isArray(input.idarticulo)) return 'falta la lista de artículos';
      for (const idarticulo of input.idarticulo) {
        // Safe integers only, and not merely because `canonicalJson` refuses
        // anything else: a waiver names primary keys, and a primary key that
        // arrived as `4471.0` is a key nothing will match.
        if (!Number.isSafeInteger(idarticulo)) return 'un artículo no es un idarticulo';
      }
      return null;
    }
    case 'anular_waiver':
      return typeof input.waiverId === 'string' && input.waiverId !== ''
        ? null
        : 'falta la exoneración que se anula';
    default:
      return `«${String((input as { kind?: unknown }).kind)}» no es una acción`;
  }
}

/**
 * Where the action chain is, and the link that would come next.
 *
 * Exported because P2.5 appends to the same chain from `sellar.ts`: a
 * `sellar_sin_registros` signed with the seal has to land on the head this
 * function reports, and a second implementation of «where is the chain» is how
 * two writers end up disagreeing about seq 7.
 */
export async function chainPoint(db: Db, sessionId: string) {
  const stored = (await loadSessionActions(db, sessionId)).map(rowToRecord);
  const last = stored[stored.length - 1];
  return {
    stored,
    expectedSeq: last?.seq ?? 0,
    head: last?.hash ?? actionGenesisHash(sessionId),
  };
}

/** Hash one action onto a running head. The same `chain.ts` both sides import. */
export function link(action: ChainableAction, prevHash: string): ActionWire {
  return {
    id: action.id,
    seq: action.seq,
    kind: action.kind,
    payload: action.payload,
    usuario: action.usuario,
    clientAt: action.at,
    prevHash,
    hash: chainActionHash(prevHash, action),
  };
}

export async function postAction(
  db: Db,
  id: string | null,
  body: unknown,
  options: ActionOptions = {},
): Promise<ApiResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const mintToken = options.mintToken ?? newToken;

  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const problem = malformed(body);
  if (problem) return fail(400, problem);
  const input = body as ActionBody;

  if (!REASSIGNABLE.has(session.estado as SessionEstado)) {
    return fail(409, `esta sesión está en «${session.estado}» y su reparto ya no se cambia`, {
      code: 'SESSION_NOT_OPEN',
      estado: session.estado,
    });
  }

  switch (input.kind) {
    case 'reasignar':
      return reassign(db, session.id, session.estado as SessionEstado, session.assignmentsVersion, input, {
        now,
        newId,
        mintToken,
        staleAfterMs: options.staleAfterMs,
      });
    case 'retirar_contador':
      return retire(db, session.id, input, { now, newId });
    case 'sellar_sin_registros':
      return sealWithout(db, session.id, input, { now, newId });
    case 'waiver':
      return waive(db, session.id, input, { now, newId });
    case 'anular_waiver':
      return annulWaiver(db, session.id, input, { now, newId });
  }
}

/**
 * `waiver` — «nobody counted these and I accept that».
 *
 * An action and nothing else. It writes no `events` row and moves no state: what
 * it changes is what the **fold** sees, and it does that by being on the chain,
 * because `waiversToEvents` is a projection of the log. There is deliberately no
 * table of waived articles to fall out of step with it.
 *
 * The projection is also where §4b lives — a waiver is evaluated only against
 * articles that fold to `untouched` from counter events alone — so this handler
 * does **not** check whether an article has been counted. It must not: a tablet
 * that syncs an hour from now would make any answer given here wrong, and the
 * whole point of evaluating at fold time is that the outcome cannot depend on
 * when a device reached wifi. A waiver on a counted row is accepted, does
 * nothing, and is reported as superseded.
 */
async function waive(
  db: Db,
  sessionId: string,
  input: Extract<ActionBody, { kind: 'waiver' }>,
  options: Required<Pick<ActionOptions, 'now' | 'newId'>>,
): Promise<ApiResult> {
  const items = await loadCatalogueIds(db, sessionId);
  const payload: WaiverPayload = { idarticulo: input.idarticulo, motivo: input.motivo };
  const blockers = waiverBlockers({
    items: items.map((idarticulo) => ({ idarticulo })),
    payload,
  });
  if (blockers.length > 0) {
    return fail(409, 'esa exoneración no se puede firmar', { code: 'BAD_WAIVER', blockers });
  }

  const written = await appendAction(db, sessionId, 'waiver', payload, input.usuario, options);
  if (!written.ok) return written.result;
  return ok({
    actionId: written.action.id,
    filas: payload.idarticulo.length,
  });
}

/**
 * `anular_waiver` — withdrawing one, append-only.
 *
 * The same discipline as a scoped retraction: the original action is never
 * deleted and never mutated, and this one names it. An admin who waived 1 800
 * rows and thought better of it is a fact about the afternoon, not an
 * embarrassment to be tidied out of the log.
 */
async function annulWaiver(
  db: Db,
  sessionId: string,
  input: Extract<ActionBody, { kind: 'anular_waiver' }>,
  options: Required<Pick<ActionOptions, 'now' | 'newId'>>,
): Promise<ApiResult> {
  const stored = (await loadSessionActions(db, sessionId)).map(rowToRecord);
  const verdict = annullable(stored, input.waiverId);
  if (!verdict.ok) {
    const said = {
      'no-existe': 'esa exoneración no está en esta sesión',
      'no-es-waiver': 'esa acción no es una exoneración',
      'ya-anulado': 'esa exoneración ya estaba anulada',
    }[verdict.reason];
    return fail(409, said, { code: 'BAD_ANNUL', reason: verdict.reason });
  }

  const payload: AnularWaiverPayload = { waiverId: input.waiverId, motivo: input.motivo };
  const written = await appendAction(
    db,
    sessionId,
    'anular_waiver',
    payload,
    input.usuario,
    options,
  );
  if (!written.ok) return written.result;
  return ok({ actionId: written.action.id, waiverId: input.waiverId });
}

/**
 * Append one action that changes nothing else, guarded.
 *
 * Shared by `waiver` and `anular_waiver` because they are the same write: a
 * single link on the chain, refused if somebody else appended that `seq` first.
 * `sellar_sin_registros` does not use it only because it carries a counter guard
 * of its own.
 */
async function appendAction(
  db: Db,
  sessionId: string,
  kind: SessionActionKind,
  payload: ActionPayload,
  usuario: string,
  options: Required<Pick<ActionOptions, 'now' | 'newId'>>,
): Promise<{ ok: true; action: ActionWire } | { ok: false; result: ApiResult }> {
  const point = await chainPoint(db, sessionId);
  const action = link(
    {
      id: options.newId(),
      sessionId,
      seq: point.expectedSeq + 1,
      kind,
      payload,
      usuario,
      at: options.now(),
    },
    point.head,
  );

  const results = await db.transaction(
    actionStatements(sessionId, {
      action,
      expectedActionSeq: point.expectedSeq,
      estados: ESTADOS,
    }),
  );
  const written = results[results.length - 1];
  if (!written || written.length === 0) {
    return {
      ok: false,
      result: fail(409, 'alguien más escribió al mismo tiempo; vuelve a intentarlo', {
        code: 'CONCURRENT_ACTION',
      }),
    };
  }
  return { ok: true, action };
}

async function reassign(
  db: Db,
  sessionId: string,
  estado: SessionEstado,
  storedVersion: number,
  input: Extract<ActionBody, { kind: 'reasignar' }>,
  options: Required<Pick<ActionOptions, 'now' | 'newId' | 'mintToken'>> &
    Pick<ActionOptions, 'staleAfterMs'>,
): Promise<ApiResult> {
  // The version is checked here so the admin gets a sentence, and again inside
  // the transaction so the answer is true under concurrency. Neither check is
  // redundant: this one cannot be trusted and that one cannot be read.
  if (input.version !== storedVersion) {
    return fail(
      409,
      'alguien más cambió el reparto mientras preparabas este cambio. Vuelve a ' +
        'cargar la pantalla y arma el movimiento otra vez.',
      { code: 'STALE_ASSIGNMENTS', assignmentsVersion: storedVersion },
    );
  }

  const [items, counters, sectionRows, assignmentRows] = await Promise.all([
    loadCatalogueIds(db, sessionId),
    loadCounters(db, sessionId),
    loadSections(db, sessionId),
    loadAssignments(db, sessionId),
  ]);
  const sections: Section[] = sectionRows;
  const assignments: Assignment[] = assignmentRows;

  const planInput = {
    estado,
    items: items.map((idarticulo) => ({ idarticulo })),
    counters,
    sections,
    assignments,
    moves: input.moves,
    nuevos: input.nuevos ?? [],
    motivo: input.motivo,
    newId: options.newId,
  };

  const blockers = reassignBlockers(planInput);
  if (blockers.length > 0) {
    return fail(409, 'ese movimiento no se puede hacer', { blockers });
  }

  const plan = planReassignment(planInput);
  const at = options.now();

  // §4b, recorded rather than merely displayed. A move away from a counter the
  // server has not heard from is a move that may be counted twice, and P2.4 has
  // to be able to say «this was reassigned mid-count» instead of reporting an
  // unexplained overlap.
  const sinSincronizar = handoverRisk({
    counters,
    moves: plan.moves,
    now: at,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });

  const point = await chainPoint(db, sessionId);
  const actions: ActionWire[] = [];
  let head = point.head;
  let seq = point.expectedSeq;

  for (const counter of plan.counters) {
    const payload: AgregarContadorPayload = {
      counterId: counter.id,
      nombre: counter.nombre,
      motivo: input.motivo,
    };
    const wire = link(
      { id: options.newId(), sessionId, seq: ++seq, kind: 'agregar_contador', payload, usuario: input.usuario, at },
      head,
    );
    actions.push(wire);
    head = wire.hash;
  }

  const reasignar: ReasignarPayload = {
    motivo: input.motivo,
    movimientos: plan.moves.map((move) => ({
      idarticulo: move.idarticulo,
      from: move.from,
      to: move.to,
      sectionId: move.sectionId,
    })),
    seccionesCreadas: plan.createSections,
    seccionesReapuntadas: plan.repointSections,
    sinSincronizar,
  };
  const tail = link(
    { id: options.newId(), sessionId, seq: ++seq, kind: 'reasignar', payload: reasignar, usuario: input.usuario, at },
    head,
  );
  actions.push(tail);

  const tokens = new Map(plan.counters.map((counter) => [counter.id, options.mintToken()]));
  const results = await db.transaction(
    reassignStatements(sessionId, {
      actions,
      expectedActionSeq: point.expectedSeq,
      version: input.version,
      estados: ESTADOS,
      counters: plan.counters.map((counter) => ({
        id: counter.id,
        nombre: counter.nombre,
        token: tokens.get(counter.id)!,
      })),
      createSections: plan.createSections,
      repointSections: plan.repointSections.map((section) => ({ id: section.id, to: section.to })),
      moves: plan.moves,
    }),
  );

  // The last statement is the version bump, guarded on the action having landed.
  // Empty means somebody else got there first and **nothing** was written — the
  // whole batch hangs off one predicate for exactly this reason.
  const bumped = results[results.length - 1];
  if (!bumped || bumped.length === 0) {
    return fail(
      409,
      'alguien más cambió el reparto mientras se guardaba este movimiento. ' +
        'Vuelve a cargar la pantalla.',
      { code: 'STALE_ASSIGNMENTS' },
    );
  }
  const moved = results[results.length - 2];

  return ok({
    assignmentsVersion: (bumped[0] as { assignmentsVersion: number }).assignmentsVersion,
    movidos: moved.length,
    seccionesCreadas: plan.createSections,
    seccionesReapuntadas: plan.repointSections,
    sinSincronizar,
    // The links for the printable sheet (P2.1). A counter added at eleven needs
    // the same QR and the same 22 characters as one dispatched at eight.
    nuevos: plan.counters.map((counter) => ({
      id: counter.id,
      nombre: counter.nombre,
      token: tokens.get(counter.id)!,
    })),
  });
}

async function retire(
  db: Db,
  sessionId: string,
  input: Extract<ActionBody, { kind: 'retirar_contador' }>,
  options: Required<Pick<ActionOptions, 'now' | 'newId'>>,
): Promise<ApiResult> {
  const counters = await loadCounters(db, sessionId);
  const counter = counters.find((row) => row.id === input.counterId);
  if (!counter) return fail(404, 'ese contador no está en esta sesión');
  if (counter.estado === 'retirado') {
    return fail(409, `${counter.nombre} ya estaba retirado`, { code: 'ALREADY_RETIRED' });
  }

  const assignments = await loadAssignments(db, sessionId);
  const holding = assignments.filter((assignment) => assignment.counterId === counter.id);
  if (holding.length > 0) {
    // Retirement is not a way to abandon coverage. Reassign first — sequencing
    // it this way keeps the coverage gate one rule rather than one with an
    // exception, and the articles are named so the screen can offer the move.
    return fail(
      409,
      `${counter.nombre} todavía tiene ${holding.length} artículos asignados. ` +
        'Reasígnalos antes de retirarlo: retirar no es una forma de dejar estantes sin dueño.',
      {
        code: 'STILL_HOLDING',
        idarticulos: holding.map((assignment) => assignment.idarticulo),
      },
    );
  }

  const at = options.now();
  const point = await chainPoint(db, sessionId);
  const payload: RetirarContadorPayload = {
    counterId: counter.id,
    nombre: counter.nombre,
    motivo: input.motivo,
  };
  const action = link(
    {
      id: options.newId(),
      sessionId,
      seq: point.expectedSeq + 1,
      kind: 'retirar_contador',
      payload,
      usuario: input.usuario,
      at,
    },
    point.head,
  );

  const results = await db.transaction(
    retireStatements(sessionId, {
      counterId: counter.id,
      action,
      expectedActionSeq: point.expectedSeq,
      estados: ESTADOS,
    }),
  );
  const retired = results[results.length - 1];
  if (!retired || retired.length === 0) {
    return fail(409, 'alguien más escribió al mismo tiempo; vuelve a intentarlo', {
      code: 'CONCURRENT_ACTION',
    });
  }

  return ok({ counterId: counter.id, nombre: counter.nombre, estado: 'retirado' });
}

/**
 * The `sellar_sin_registros` payload for one counter, or the refusal.
 *
 * Extracted because P2.5 signs the identical thing at the moment of the seal
 * (§1a) and it has to be identical: the acta prints `faltan` verbatim, and two
 * places computing «which seqs are missing» would eventually print two answers
 * about one person's morning.
 */
export async function planSealWithout(
  db: Db,
  sessionId: string,
  counterId: string,
  motivo: string,
): Promise<{ ok: true; payload: SellarSinRegistrosPayload } | { ok: false; result: ApiResult }> {
  const counters = await loadCounters(db, sessionId);
  const counter = counters.find((row) => row.id === counterId);
  if (!counter) return { ok: false, result: fail(404, 'ese contador no está en esta sesión') };
  if (counter.estado !== 'retirado') {
    // The only counter whose missing work can be sealed over is one somebody has
    // already decided is not coming back. Otherwise the answer is to wait.
    return {
      ok: false,
      result: fail(
        409,
        `${counter.nombre} no está retirado. Si ya no va a volver, retíralo primero; ` +
          'si va a volver, espera la tableta.',
        { code: 'NOT_RETIRED' },
      ),
    };
  }

  const stored = await loadCounterChain(db, counter.id);
  const held = new Set(stored.map((row) => row.seq));
  const max = stored.reduce((highest, row) => Math.max(highest, row.seq), 0);
  const missing: number[] = [];
  for (let seq = 1; seq <= max; seq++) if (!held.has(seq)) missing.push(seq);
  if (missing.length === 0) {
    // Nothing to sign over. Stated as a refusal rather than a silent success:
    // an override on a whole chain is a line on the acta that says a count is
    // missing work it is not missing.
    return {
      ok: false,
      result: fail(
        409,
        `la cadena de ${counter.nombre} no tiene huecos: no hay registros que sellar sin.`,
        { code: 'NOTHING_MISSING' },
      ),
    };
  }

  return {
    ok: true,
    payload: {
      counterId: counter.id,
      nombre: counter.nombre,
      motivo,
      faltan: seqRanges(missing),
      storedMaxSeq: max,
    },
  };
}

async function sealWithout(
  db: Db,
  sessionId: string,
  input: Extract<ActionBody, { kind: 'sellar_sin_registros' }>,
  options: Required<Pick<ActionOptions, 'now' | 'newId'>>,
): Promise<ApiResult> {
  const planned = await planSealWithout(db, sessionId, input.counterId, input.motivo);
  if (!planned.ok) return planned.result;
  const payload = planned.payload;

  const at = options.now();
  const point = await chainPoint(db, sessionId);
  const action = link(
    {
      id: options.newId(),
      sessionId,
      seq: point.expectedSeq + 1,
      kind: 'sellar_sin_registros',
      payload,
      usuario: input.usuario,
      at,
    },
    point.head,
  );

  const results = await db.transaction(
    actionStatements(sessionId, {
      action,
      expectedActionSeq: point.expectedSeq,
      estados: ESTADOS,
      // Signed against a counter who is actually retired, checked again under
      // the lock — the two reads above it are outside one.
      counter: { id: payload.counterId, estado: 'retirado' },
    }),
  );
  const written = results[results.length - 1];
  if (!written || written.length === 0) {
    return fail(409, 'alguien más escribió al mismo tiempo; vuelve a intentarlo', {
      code: 'CONCURRENT_ACTION',
    });
  }

  return ok({ counterId: payload.counterId, nombre: payload.nombre, faltan: payload.faltan });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = param(req, 'id');
  try {
    if (req.method === undefined || req.method === 'GET') {
      return send(res, await listActions(dbFromEnv(), id));
    }
    if (req.method !== 'POST') return send(res, fail(405, 'GET, POST'));
    return send(res, await postAction(dbFromEnv(), id, req.body));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
