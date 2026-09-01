/**
 * `GET /api/sessions/:id/sync` — the admin's cheap poll.
 *
 * Cheap and polled, next to `/events` which is heavier and pulled only when this
 * one shows movement. That split is the whole design of the monitoring read: a
 * screen refreshing every few seconds must not drag a session's whole log across
 * the wire to find out that nothing happened.
 *
 * **Admin-facing and unrestricted in what it returns.** The allowlist discipline
 * of P2.1 §4c governs the *counter* endpoint and only that one; conflating the
 * two would either leak quantities to tablets or blind the person who has to
 * decide whether the count can be sealed. `tests/blindCount.test.ts` asserts the
 * counter's payload is unchanged by anything in this task.
 */
import { sessionReadyToSeal, type CounterEstado, type CounterSyncState } from '../../../src/domain';
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
import { loadCounterSync, loadSessionRow } from '../../_store';

export interface SyncView {
  session: {
    id: string;
    estado: string;
    /** Empty means the count may be sealed. P2.5 gates on it; P2.4 shows it. */
    readyToSeal: ReturnType<typeof sessionReadyToSeal>;
  };
  counters: {
    id: string;
    nombre: string;
    estado: string;
    storedMaxSeq: number;
    headHash: string | null;
    lastServerAt: string | null;
    /** Every device that has pushed for this counter, first appearance first. */
    deviceIds: string[];
    clockSkewMs: number | null;
    forked: boolean;
    finishReason: string | null;
    /** P2.1's `pendiente`: this counter's tablet has never pulled its assignment. */
    pendingFetch: boolean;
  }[];
}

export async function sessionSync(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const rows = await loadCounterSync(db, id);
  const counters: SyncView['counters'] = rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    estado: row.estado,
    storedMaxSeq: row.storedMaxSeq,
    headHash: row.headHash,
    lastServerAt: row.lastServerAt,
    deviceIds: row.deviceIds,
    clockSkewMs: row.clockSkewMs,
    forked: row.forked,
    finishReason: row.finishReason,
    pendingFetch: row.fetchedAt === null,
  }));

  const state: CounterSyncState[] = rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    estado: row.estado as CounterEstado,
    forked: row.forked,
    fetchedAt: row.fetchedAt,
    finishReason: row.finishReason,
  }));

  return ok({
    session: { id: session.id, estado: session.estado, readyToSeal: sessionReadyToSeal({ counters: state }) },
    counters,
  } satisfies SyncView);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== undefined && req.method !== 'GET') return send(res, fail(405, 'GET'));
  try {
    return send(res, await sessionSync(dbFromEnv(), param(req, 'id')));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
