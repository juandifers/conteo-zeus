/**
 * `POST /api/sessions/:id/exportar` — generate the file, once.
 * `GET  /api/sessions/:id/exportar` — serve the bytes that were generated.
 *
 * ## It has to run here
 *
 * If the client regenerated the file, the bytes the admin downloads could differ
 * from the bytes the server hashed, and `file_hash` would attest to a file
 * nobody has. Not hypothetically: the client is a PWA whose cached build can be
 * weeks old, and the two would disagree the first time a rounding rule changed.
 * The server writes the bytes, hashes what it wrote, stores it, and from then on
 * serves exactly that — never a regeneration.
 *
 * ## Through `src/app/`
 *
 * `api/` may reach `src/domain/`, `src/app/` and `src/lib/`, and never
 * `src/zeus/` (`tests/boundaries.test.ts`). That is not bookkeeping here: it is
 * why there is one implementation of what a CP850 tab-separated row is, and why
 * the write-back check runs over the same parser the import ran over.
 *
 * ## The pipeline, and where it aborts
 *
 *     eventos congelados + acciones congeladas
 *         ├─ fold
 *         ├─ waiversToEvents contra lo que quedó 'untouched'   (P2.4 §4b)
 *         ▼
 *     counts map ──▶ writeTxt ──▶ verifyWriteBack ──▶ bytes ──▶ export_bytes
 *                                       │                       fileHash
 *                                  ABORTA aquí
 *
 * `verifyWriteBack` throws and nothing catches it. It re-parses the emitted
 * bytes against the source they came from — same rows, same order, every column
 * outside the write set byte-identical — and it is the check that catches the
 * P1 defect class, the sheared file that would have posted wrong balances to
 * nearly every row. A failure means the file is wrong. There is no version of
 * «export it anyway» that is correct, and the session stays `sellado` so the
 * only thing lost is a button press.
 */
import {
  adjustmentFilename,
  parseZeusBytes,
  sourceHashOf,
  writeAdjustment,
  type PostingParameters,
} from '../../../src/app/index.js';
import {
  eventFromRow,
  resolveSession,
  waiversToEvents,
  resolveAll,
  type CountEvent,
  type Item,
  type SessionActionRecord,
} from '../../../src/domain/index.js';
import { toBase64 } from '../../../src/lib/base64.js';
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
  exportStatements,
  loadCatalogue,
  loadExportBytes,
  loadSessionActions,
  loadSessionEvents,
  loadSessionRow,
  loadSourceBytes,
  type SessionRow,
} from '../../_store.js';
import { parametersOf } from './index.js';
import { rowToRecord } from './acciones.js';

/** What a download answers with. Base64 because `send` writes JSON and only JSON. */
export interface ExportFile {
  filename: string;
  fileHash: string;
  /**
   * The stored bytes, base64.
   *
   * Not an `application/octet-stream` body: `ApiResponse` has three members and
   * `json` is one of them, deliberately (`api/_http.ts` — no framework types in
   * front of every handler). Base64 is exact, `src/lib/base64.ts` exists on both
   * sides already, and it is how `source_bytes` crossed in the other direction
   * when the session was created. The browser rebuilds the `Blob` from the byte
   * array, never from a string — the file is CP850, and a string would put every
   * `Ñ` through the platform's UTF-8 encoder.
   */
  base64: string;
  bytes: number;
  exportedAt: string | null;
}

function filenameFor(session: SessionRow, fileHash: string): string {
  return adjustmentFilename(session.bodega, session.fechaCorte, fileHash);
}

/**
 * The counts the file will carry, from the frozen log.
 *
 * Three states and three answers (DOMAIN.md §7):
 *
 * - `counted` — the resolved quantity. A count of zero is a real count and
 *   posts as one; ZEUS_FORMAT.md §7.4 makes it a stock deletion, which is why
 *   the acta itemises every one of them.
 * - `unchanged` — `existencia`. Somebody attested to this row, whether a counter
 *   pressed «sin cambio» or an admin signed a waiver over it.
 * - `untouched` — **omitted from the map**, and resolved by `uncountedPolicy`.
 *
 * The waiver projection is §4b exactly: evaluated against the fold of *counter
 * events alone*, so a waiver lands only where nothing can contradict it and the
 * answer cannot depend on when a tablet reached wifi.
 */
export function countsFor(
  sessionId: string,
  items: readonly Item[],
  events: readonly CountEvent[],
  actions: readonly SessionActionRecord[],
): { counts: Map<number, number>; contados: number; exonerados: number; sinTocar: number } {
  const waivers = waiversToEvents(actions, resolveAll(events));
  // `Pick<Session, 'id' | 'items'>`: the widening P2.4 made so the review could
  // fold a wire-shaped session. The same one serves here — the server holds a
  // catalogue and a log, never a `Session` object.
  const resolutions = resolveSession({ id: sessionId, items }, [...events, ...waivers]);

  const counts = new Map<number, number>();
  let contados = 0;
  let exonerados = 0;
  let sinTocar = 0;
  for (const item of items) {
    const resolution = resolutions.get(item.idarticulo);
    switch (resolution?.state) {
      case 'counted':
        counts.set(item.idarticulo, resolution.qty!);
        contados++;
        break;
      case 'unchanged':
        counts.set(item.idarticulo, item.existencia);
        exonerados++;
        break;
      default:
        sinTocar++;
        break;
    }
  }
  return { counts, contados, exonerados, sinTocar };
}

/**
 * Generate the file, once.
 *
 * There is no injectable clock here on purpose: `exported_at` is stamped by the
 * database, in the same statement and off the same clock as `sealed_at`, so
 * that «which events arrived after the seal» is a comparison between two
 * readings of one clock rather than of two.
 */
export async function exportSession(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  if (session.estado !== 'sellado') {
    return fail(
      409,
      session.estado === 'cerrado'
        ? 'esta sesión ya generó su archivo. Descárgalo: son los mismos bytes, y ' +
            'volver a generarlo sería otro archivo con otro hash.'
        : `esta sesión está en «${session.estado}». Hay que sellarla antes de generar ` +
            'el archivo: si se puede seguir escribiendo, el archivo no corresponde a ' +
            'ningún estado registrado.',
      { code: 'NOT_SEALED', estado: session.estado },
    );
  }

  const bytes = await loadSourceBytes(db, id);
  if (!bytes) return fail(409, 'esta sesión no guardó el archivo de Zeus del que se importó');

  const file = parseZeusBytes(bytes);
  if (sourceHashOf(file) !== session.sourceHash) {
    // The seal binds `sourceHash`, so this cannot be a stale snapshot in the
    // ordinary sense — it is the stored bytes no longer parsing to the file the
    // count was taken against, which is a corrupt row and not a workflow error.
    return fail(
      409,
      'el archivo guardado con esta sesión ya no corresponde a su sourceHash. No se ' +
        'puede generar un ajuste contra un catálogo distinto del que se contó.',
      { code: 'SOURCE_MOVED' },
    );
  }

  const catalogue = await loadCatalogue(db, id);
  const events = (await loadSessionEvents(db, id)).map(eventFromRow);
  const actions = (await loadSessionActions(db, id)).map(rowToRecord);

  const items = catalogue.map((row) => row.item);
  const { counts, contados, exonerados, sinTocar } = countsFor(id, items, events, actions);

  const parameters: PostingParameters = parametersOf(session);
  // Throws on a mismatch, and nothing here catches it. `handler` turns it into a
  // 500 carrying `PostingVerificationError`'s sentence, which is written for the
  // person in front of the screen and says not to upload anything.
  const written = writeAdjustment(file, counts, parameters);

  const results = await db.transaction(
    exportStatements(id, { bytes: written.bytes, fileHash: written.fileHash }),
  );
  const closed = results[results.length - 1];
  if (!closed || closed.length === 0) {
    return fail(409, 'alguien más generó el archivo mientras se guardaba éste.', {
      code: 'CONCURRENT_EXPORT',
    });
  }

  return ok({
    estado: 'cerrado',
    exportedAt: (closed[0] as { exportedAt: string }).exportedAt,
    fileHash: written.fileHash,
    filename: filenameFor(session, written.fileHash),
    filas: written.filas,
    contados,
    exonerados,
    sinTocar,
    parameters,
  });
}

/** The stored bytes, as often as somebody needs them. Never a regeneration. */
export async function downloadExport(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');

  const bytes = await loadExportBytes(db, id);
  if (!bytes || !session.fileHash) {
    return fail(409, 'esta sesión todavía no generó su archivo', { code: 'NOT_EXPORTED' });
  }

  return ok({
    filename: filenameFor(session, session.fileHash),
    fileHash: session.fileHash,
    base64: toBase64(bytes),
    bytes: bytes.length,
    exportedAt: session.exportedAt,
  } satisfies ExportFile);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const id = param(req, 'id');
  try {
    const db = dbFromEnv();
    if (req.method === undefined || req.method === 'GET') {
      return send(res, await downloadExport(db, id));
    }
    if (req.method !== 'POST') return send(res, fail(405, 'GET, POST'));
    return send(res, await exportSession(db, id));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
