/**
 * `GET /api/sessions/:id/events?since=<serverSeq>&limit=<n>` — the admin's pull.
 *
 * **Overlap and deduplicate; do not poll strictly forwards.** `server_seq` is a
 * `bigserial` and carries the standard cursor trap: the value is taken from the
 * sequence at insert and the row becomes visible at commit, and those two orders
 * are not the same — so under concurrent transactions a *lower* `server_seq` can
 * appear after a higher one, and a `where server_seq > cursor` poll can skip an
 * event permanently.
 *
 * The fix is not a watermark table and not an advisory lock; both put a
 * serialisation point in front of the write path to protect a read. Events are
 * immutable and keyed by a device-generated uuid, so the client polls from
 * `cursor - OVERLAP` and merges by `id`. Redelivery costs nothing. A skipped
 * event is a wrong total on a screen somebody signs.
 *
 * The overlap is applied **here**, so no caller can forget it: `since` is what
 * the client last saw and the query starts before it. A client that wants no
 * overlap has to ask for a cursor it never had.
 */
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
import { loadEventsSince, loadSessionRow, type AdminEventRow } from '../../_store.js';

/**
 * How far back of the client's cursor to re-read.
 *
 * Sized against the write path rather than guessed: a push commits at most
 * `MAX_BATCH` (200) events in one transaction, so a transaction that is in
 * flight while another commits can hide at most a batch's worth of sequence
 * values behind the visible head. Doubled, because two devices can be pushing at
 * once and the cost of being wrong in this direction is one extra page.
 */
const OVERLAP = 400;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export interface EventPage {
  events: AdminEventRow[];
  /**
   * Where to ask from next. The client passes it back as `since`; the overlap
   * is re-applied here, so the client never has to know about the trap.
   */
  nextCursor: string;
}

function positive(value: string | null, fallback: number, max: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export async function sessionEvents(
  db: Db,
  id: string | null,
  query: { since?: string | null; limit?: string | null } = {},
): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const since = query.since ?? '0';
  // BigInt, not Number: `server_seq` is a `bigint` and a cursor rounded through
  // a double is a cursor that stops advancing.
  let from: bigint;
  try {
    from = BigInt(since);
  } catch {
    return fail(400, `«${since}» no es un cursor`);
  }
  if (from < 0n) from = 0n;
  const start = from > BigInt(OVERLAP) ? from - BigInt(OVERLAP) : 0n;
  const limit = positive(query.limit ?? null, DEFAULT_LIMIT, MAX_LIMIT);

  const events = await loadEventsSince(db, id, start.toString(), limit);
  const highest = events.reduce(
    (max, row) => (BigInt(row.serverSeq) > max ? BigInt(row.serverSeq) : max),
    from,
  );

  return ok({ events, nextCursor: highest.toString() } satisfies EventPage);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== undefined && req.method !== 'GET') return send(res, fail(405, 'GET'));
  try {
    return send(
      res,
      await sessionEvents(dbFromEnv(), param(req, 'id'), {
        since: param(req, 'since'),
        limit: param(req, 'limit'),
      }),
    );
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
