/**
 * `GET /api/c/:token/resume` — where this counter's chain stands on the server.
 *
 * The one thing a **replacement tablet** needs. A tablet dies mid-shift, the
 * counter picks up the spare, scans the same QR: the spare holds none of the
 * chain, and a device that assumed it was at the beginning would start again at
 * seq 1 and fork immediately. P2.2 §3a is explicit that a second device is
 * accepted and flagged rather than rejected — this is what makes accepting it
 * mean something.
 *
 * **This is not a widening of P2.1 §4c's allowlist and must never become one.**
 * The catalogue endpoint next door (`index.ts`) serves an allowlist of five
 * fields and no quantity of any kind; that is the guarantee DOMAIN.md §2.1 rests
 * on and it is unchanged by this task. What is here is chain position and
 * counter state — a sequence number, a hash, an enum — none of which is a Zeus
 * figure or a running total, and none of which could be turned into one. It is
 * a separate route precisely so that the leak test next door keeps asserting
 * exactly what it asserted before, over exactly the same object.
 */
import { deriveCounterEstado, genesisHash } from '../../../src/domain';
import { isTokenShaped } from '../../../src/lib/token';
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
import { findByToken, lastClientAt, loadCounterChain, loadSessionRow } from '../../_store';

export interface ResumePoint {
  sessionId: string;
  counterId: string;
  /** The session's own state, so a device can tell "sealed" from "unreachable". */
  sessionEstado: string;
  /** The highest `seq` the server holds; `0` when it holds none. */
  storedMaxSeq: number;
  /** The chain head at `storedMaxSeq`, or the genesis hash when there is nothing. */
  headHash: string;
  counterEstado: string;
  /**
   * The latest `at` this counter's devices have stamped, or `null`.
   *
   * A replacement tablet seeds its clock watermark from this. The fold orders by
   * `at` first (DOMAIN.md §3), so a spare whose clock runs behind the tablet it
   * replaced would otherwise stamp events that sort *before* the ones they
   * follow — and for one counter's own article that is the difference between a
   * waiver withdrawing a count and the count overriding the waiver.
   */
  lastClientAt: string | null;
  /** Normalised UTC, so the device can measure its own skew (§3c). */
  serverAt: string;
}

export async function counterResume(
  db: Db,
  token: string | null,
  options: { now?: () => string } = {},
): Promise<ApiResult> {
  const serverAt = (options.now ?? (() => new Date().toISOString()))();

  if (!token || !isTokenShaped(token)) return fail(404, 'ese enlace no existe');
  const found = await findByToken(db, token);
  if (!found) return fail(404, 'ese enlace no existe');
  const session = await loadSessionRow(db, found.sessionId);
  if (!session) return fail(404, 'ese enlace no existe');

  const stored = await loadCounterChain(db, found.counter.id);
  const storedMaxSeq = stored.reduce((max, row) => Math.max(max, row.seq), 0);
  const headHash =
    storedMaxSeq === 0
      ? genesisHash(session.id, found.counter.id)
      : stored.find((row) => row.seq === storedMaxSeq)!.hash;

  return ok({
    sessionId: session.id,
    counterId: found.counter.id,
    sessionEstado: session.estado,
    storedMaxSeq,
    headHash,
    counterEstado: deriveCounterEstado(session.id, found.counter.id, stored).estado,
    lastClientAt: await lastClientAt(db, found.counter.id),
    serverAt,
  } satisfies ResumePoint);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== undefined && req.method !== 'GET') return send(res, fail(405, 'GET'));
  try {
    return send(res, await counterResume(dbFromEnv(), param(req, 'token')));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
