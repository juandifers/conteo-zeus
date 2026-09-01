/**
 * The three routes of the close, behind one function.
 *
 * `sellar`, `exportar` and `bundle` are still three URLs — `vercel.json`
 * rewrites them here with an `_op`, and nothing the admin screen calls changed.
 * What changed is the count: Vercel's Hobby plan allows twelve serverless
 * functions per deployment and P2.5 asked for thirteen, so the deployment
 * failed to build and production went on serving the last successful one, which
 * predated the whole backend. Merging was the alternative to a monthly bill.
 *
 * These three were the right group to merge, and not only because they arrived
 * together. They are one sequence — `revisión ──sellar──▶ sellado ──generar──▶
 * cerrado` — over one row, and the ordering between them is the design (P2.5).
 * A reader who has to know all three to reason about any one of them is better
 * served by finding them on one page.
 *
 * The decisions are not here. `sealSession`, `exportSession`, `downloadExport`
 * and `sessionBundle` are unchanged in `_sellar.ts`, `_exportar.ts` and
 * `_bundle.ts` — the `_` prefix is what keeps Vercel from counting a module as
 * an endpoint — and they are what `tests/backend/sellar.pg.test.ts` calls. This
 * file chooses one of them and maps a method to a status code.
 */
import { dbFromEnv, NoDatabaseError } from '../../_db.js';
import {
  fail,
  messageOf,
  param,
  send,
  type ApiRequest,
  type ApiResponse,
} from '../../_http.js';
import { sessionBundle } from './_bundle.js';
import { downloadExport, exportSession } from './_exportar.js';
import { sealSession } from './_sellar.js';

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const op = param(req, '_op');
  const id = param(req, 'id');
  const method = req.method ?? 'GET';
  try {
    const db = dbFromEnv();

    if (op === 'sellar') {
      if (method !== 'POST') return send(res, fail(405, 'POST'));
      return send(res, await sealSession(db, id, req.body));
    }

    if (op === 'exportar') {
      // GET serves the stored bytes; POST is the one generation. P2.5 §2b: the
      // file is written once and downloaded as often as needed, and a download
      // is never a regeneration — so the method is the whole difference between
      // reading a fact and creating one.
      if (method === 'GET') return send(res, await downloadExport(db, id));
      if (method !== 'POST') return send(res, fail(405, 'GET, POST'));
      return send(res, await exportSession(db, id));
    }

    if (op === 'bundle') {
      if (method !== 'GET') return send(res, fail(405, 'GET'));
      return send(res, await sessionBundle(db, id));
    }

    // `/api/sessions/:id/cierre` is reachable directly, and means nothing.
    return send(res, fail(404, 'No existe esa ruta.'));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
