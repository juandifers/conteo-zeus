/**
 * `POST /api/sessions/:id/sellar` — the point after which nothing can be
 * appended (P2.5 §1).
 *
 * ## Seal before generate, and the ordering is the design
 *
 * The instinct is «download the file, then close the session». It cannot be
 * defended: if input remains possible between generation and closing, the file
 * handed to Zeus corresponds to no recorded state — somebody's tablet drains at
 * 17:04 and the `.txt` in the accountant's downloads folder is a snapshot of
 * 17:03 that nothing in the database describes.
 *
 *     revisión ──sellar──▶ sellado ──generar──▶ cerrado
 *                  │                    │
 *           congela AMBAS cadenas   el .txt es función determinista
 *           calcula sessionHash     de un conjunto ya congelado
 *
 * `sellado` freezes **both** chains. Counter pushes already refuse there
 * (`api/c/[token]/events.ts`, `409 SESSION_SEALED`), and so does every admin
 * action: `postAction` gates on `REASSIGNABLE` before it looks at `kind`, so a
 * waiver signed after the seal is refused for the same reason a reassignment is.
 * That matters more than it looks — a waiver after the seal would change what
 * the file should say about a row the hash already covers.
 *
 * ## There is no force flag
 *
 * The gate is `sessionReadyToSeal`'s **blocking** tier and nothing weaker. The
 * advisory tier — 1 800 untouched rows, four explicit zeros, an overlap — is a
 * checklist, not a gate: an admin who has looked at those and decided is making
 * the decision this system exists to let them make.
 *
 * The one way past a blocking reason is `sellar_sin_registros` (§1a), which is
 * an action on the chain with a name and a reason on it. Not a flag on this
 * request, and not an admin setting a counter's state by hand: the entire value
 * of the gate is that it cannot be satisfied by assertion.
 */
import {
  genesisHash,
  sealOverrides,
  sessionHash,
  sessionReadyToSeal,
  type CounterEstado,
  type CounterSyncState,
  type SealOverride,
  type SessionActionRecord,
  type SessionEstado,
} from '../../../src/domain/index.js';
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
import { loadCounterSync, loadSessionActions, loadSessionRow, sealStatements } from '../../_store.js';
import { chainPoint, link, planSealWithout, rowToRecord } from './acciones.js';

/** Sessions that may still be sealed. The two states that are not yet frozen. */
const SEALABLE: SessionEstado[] = ['abierto', 'revision'];

export interface SealBody {
  /**
   * The override, when one is needed (§1a).
   *
   * Recorded **and** sealed in one transaction, the action first, so that the
   * record of whose work was skipped is inside the chain the hash covers.
   * Written afterwards it would sit outside the digest that is supposed to
   * attest to it, which is the same as not being attested to at all.
   */
  sinRegistros?: { counterId: string; usuario: string; motivo: string };
}

export interface SealOptions {
  now?: () => string;
  newId?: () => string;
}

function malformed(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object') return 'el cuerpo de la petición no es un objeto';
  const input = body as SealBody;
  if (input.sinRegistros === undefined) return null;
  const override = input.sinRegistros;
  if (typeof override !== 'object' || override === null) {
    return 'sinRegistros no es un objeto';
  }
  if (typeof override.counterId !== 'string' || override.counterId === '') {
    return 'falta el contador cuyos registros faltan';
  }
  if (typeof override.usuario !== 'string' || override.usuario.trim() === '') {
    return 'falta el nombre de quien firma que ese tramo no va a llegar';
  }
  if (typeof override.motivo !== 'string' || override.motivo.trim() === '') {
    return 'falta el motivo: sellar sin los registros de alguien se explica, no se marca';
  }
  return null;
}

export async function sealSession(
  db: Db,
  id: string | null,
  body: unknown,
  options: SealOptions = {},
): Promise<ApiResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());

  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const problem = malformed(body);
  if (problem) return fail(400, problem);
  const input = (body ?? {}) as SealBody;

  if (!SEALABLE.includes(session.estado as SessionEstado)) {
    return fail(
      409,
      session.estado === 'sellado' || session.estado === 'cerrado'
        ? `esta sesión ya está en «${session.estado}»: el conteo está congelado.`
        : `esta sesión está en «${session.estado}» y todavía no se puede sellar.`,
      { code: 'NOT_SEALABLE', estado: session.estado },
    );
  }

  const rows = await loadCounterSync(db, id);
  const stored = (await loadSessionActions(db, id)).map(rowToRecord);

  // The override, planned before the gate is evaluated, because it is one of
  // the gate's inputs. `planSealWithout` is the same function the standalone
  // action uses, so the `faltan` range printed on the acta is computed once.
  let override: SealOverride | null = null;
  let pending: { payload: unknown; usuario: string; counterId: string } | null = null;
  if (input.sinRegistros) {
    const planned = await planSealWithout(
      db,
      id,
      input.sinRegistros.counterId,
      input.sinRegistros.motivo,
    );
    if (!planned.ok) return planned.result;
    override = { counterId: planned.payload.counterId, faltan: planned.payload.faltan };
    pending = {
      payload: planned.payload,
      usuario: input.sinRegistros.usuario,
      counterId: planned.payload.counterId,
    };
  }

  const whole = (row: { storedCount: number; storedMaxSeq: number }) =>
    row.storedCount === row.storedMaxSeq;
  const counters: CounterSyncState[] = rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    estado: row.estado as CounterEstado,
    forked: row.forked,
    fetchedAt: row.fetchedAt,
    finishReason: row.finishReason,
    chainComplete: whole(row),
  }));

  const overrides = [
    ...[...sealOverrides(stored as unknown as SessionActionRecord[]).entries()].map(
      ([counterId, payload]) => ({ counterId, faltan: payload.faltan }),
    ),
    ...(override ? [override] : []),
  ];

  const blockers = sessionReadyToSeal({ counters, overrides });
  if (blockers.length > 0) {
    return fail(409, 'este conteo todavía no se puede sellar', {
      code: 'NOT_READY',
      blockers,
    });
  }

  const at = now();
  const point = await chainPoint(db, id);
  const action = pending
    ? link(
        {
          id: newId(),
          sessionId: id,
          seq: point.expectedSeq + 1,
          kind: 'sellar_sin_registros',
          payload: pending.payload,
          usuario: pending.usuario,
          at,
        },
        point.head,
      )
    : undefined;

  const hash = sessionHash({
    sessionId: id,
    // Ties the seal to the catalogue the counts were taken against. Without it
    // the same events over a different file hash the same.
    sourceHash: session.sourceHash,
    counters: rows.map((row) => ({
      counterId: row.id,
      maxSeq: row.storedMaxSeq,
      // A counter who pushed nothing has a chain of length zero, and its head is
      // the genesis. Not the empty string: a hash input that says «no chain»
      // and one that says «a chain that starts here» must not collide.
      headHash: row.headHash ?? genesisHash(id, row.id),
    })),
    actionHead: action ? action.hash : point.head,
    actionMaxSeq: point.expectedSeq + (action ? 1 : 0),
  });

  const results = await db.transaction(
    sealStatements(id, {
      ...(action ? { action } : {}),
      expectedActionSeq: point.expectedSeq,
      ...(pending ? { counter: { id: pending.counterId, estado: 'retirado' } } : {}),
      estados: SEALABLE,
      sessionHash: hash,
    }),
  );

  // The update is guarded on the state, on `session_hash is null` and on the
  // chain being exactly where the hash was taken over. An empty result is any
  // of those having moved between the read and the write — another admin
  // sealing, or an action landing — and in every case the answer is the same:
  // nothing was written, reload and look again.
  const sealed = results[results.length - 1];
  if (!sealed || sealed.length === 0) {
    return fail(
      409,
      'alguien más selló o escribió en la cadena mientras se guardaba este sello. ' +
        'Vuelve a cargar la pantalla.',
      { code: 'CONCURRENT_SEAL' },
    );
  }

  return ok({
    estado: 'sellado',
    sealedAt: (sealed[0] as { sealedAt: string }).sealedAt,
    sessionHash: hash,
    sourceHash: session.sourceHash,
    contadores: rows.length,
    ...(override ? { sinRegistros: override } : {}),
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') return send(res, fail(405, 'POST'));
  try {
    return send(res, await sealSession(dbFromEnv(), param(req, 'id'), req.body));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
