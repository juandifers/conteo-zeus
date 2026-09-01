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
import {
  sealOverrides,
  sessionReadyToSeal,
  type CounterEstado,
  type CounterSyncState,
  type SessionActionRecord,
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
  loadCounterSync,
  loadEventsAfter,
  loadSessionActions,
  loadSessionRow,
} from '../../_store';

export interface SyncView {
  session: {
    id: string;
    estado: string;
    /** Empty means the count may be sealed. P2.5 gates on it; P2.4 shows it. */
    readyToSeal: ReturnType<typeof sessionReadyToSeal>;
    /** What the admin planned against. A reassignment sent with a stale one is a 409. */
    assignmentsVersion: number;
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
    /**
     * No hole in the stored chain: every `seq` from 1 to the highest is here.
     *
     * The gate a **retired** counter is held to (P2.3.5 §5a). Silent about a
     * tail nobody has heard of, which is the limit `sellar_sin_registros` exists
     * for — see `CounterSyncState`.
     */
    chainComplete: boolean;
  }[];
  /** The admin action chain, in order. What P2.4 renders and the acta prints. */
  acciones: SessionActionRecord[];
  /**
   * P2.5. Null until the seal; the digests the acta prints and the verifier
   * recomputes.
   */
  sello: {
    sealedAt: string;
    sessionHash: string;
    exportedAt: string | null;
    fileHash: string | null;
    sourceHash: string;
    /**
     * Events the server accepted after `sealedAt`. Always empty — see
     * `loadEventsAfter`, and see why it is read anyway.
     */
    tardios: { id: string; counterId: string; seq: number; serverAt: string }[];
  } | null;
}

export async function sessionSync(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const rows = await loadCounterSync(db, id);
  // `count(*) = max(seq)` is contiguity, exactly: `seq` starts at 1 and
  // `unique (counter_id, seq)` forbids a repeat, so there is no way to have as
  // many rows as the highest number and a hole as well.
  const whole = (row: { storedCount: number; storedMaxSeq: number }) =>
    row.storedCount === row.storedMaxSeq;

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
    chainComplete: whole(row),
  }));

  const state: CounterSyncState[] = rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    estado: row.estado as CounterEstado,
    forked: row.forked,
    fetchedAt: row.fetchedAt,
    finishReason: row.finishReason,
    chainComplete: whole(row),
  }));

  const acciones = (await loadSessionActions(db, id)) as unknown as SessionActionRecord[];

  // Only after the seal, and only then: this is one extra query, and the
  // endpoint it lives on is polled every few seconds while a bodega is being
  // counted. A sealed session is not being polled by anybody in a hurry.
  const sello: SyncView['sello'] =
    session.sealedAt === null || session.sessionHash === null
      ? null
      : {
          sealedAt: session.sealedAt,
          sessionHash: session.sessionHash,
          exportedAt: session.exportedAt,
          fileHash: session.fileHash,
          sourceHash: session.sourceHash,
          tardios: (await loadEventsAfter(db, id)).map((row) => ({
            id: row.id,
            counterId: row.counterId,
            seq: row.seq,
            serverAt: row.serverAt,
          })),
        };
  const overrides = [...sealOverrides(acciones).entries()].map(([counterId, payload]) => ({
    counterId,
    faltan: payload.faltan,
  }));

  return ok({
    session: {
      id: session.id,
      estado: session.estado,
      assignmentsVersion: session.assignmentsVersion,
      readyToSeal: sessionReadyToSeal({ counters: state, overrides }),
    },
    counters,
    acciones,
    sello,
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
