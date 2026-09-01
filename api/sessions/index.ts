/**
 * `GET /api/sessions` — what exists.
 * `POST /api/sessions` — a bodega, a file, and nothing counted yet.
 *
 * The upload path is the one place in P2 where a mistake is unrecoverable in
 * the ordinary sense: a count taken against a sheared catalogue posts
 * quantities to the wrong articles, and there is no un-uploading it. So the
 * file is checked twice — once in the browser before a session exists, and
 * again here before anything is committed — with **one** implementation of the
 * check (`src/app/ingest.ts`), because two would drift and the drift would look
 * exactly like the bug.
 *
 * The client is a PWA with a precaching service worker. The build that uploads
 * a file may be weeks old and sitting in a tablet nobody has reloaded, which is
 * why "the client already checked" is not an argument here.
 */
import {
  catalogueDifferences,
  CatalogueError,
  ingestZeusBytes,
  toWire,
  VERIFIED_PARAMETERS,
  type CatalogueRowWire,
  type PostingParameters,
} from '../../src/app';
import { deriveFamilies, familyPrefix } from '../../src/domain';
import { dbFromEnv, NoDatabaseError, type Db } from '../_db';
import {
  created,
  fail,
  messageOf,
  ok,
  send,
  type ApiRequest,
  type ApiResponse,
  type ApiResult,
} from '../_http';
import { fromBase64, insertSessionStatements, listSessionRows } from '../_store';

/** What a browser posts. Every quantity is a string; see `CatalogueRowWire`. */
export interface CreateSessionBody {
  /** The file, base64. Stored verbatim — `verifyWriteBack` re-parses it at export. */
  sourceBytesBase64: string;
  /** What the file arrived as. The default filename for the adjustment later. */
  sourceName?: string;
  /** The client's own parse, so the two can be compared rather than trusted. */
  rows: CatalogueRowWire[];
  nombre?: string;
  parameters?: Partial<PostingParameters>;
  mostrarMarcaRegistrado?: boolean;
}

const ALLOWED: Record<keyof PostingParameters, readonly string[]> = {
  countTargetColumn: ['toma', 'conteo1'],
  uncountedPolicy: ['existencia', 'zero', 'reject'],
  differenceColumn: ['computed', 'zero'],
};

/**
 * The posting parameters for a new session, defaulted to the verified triple.
 *
 * Values are checked against what `writeTxt` actually implements. There is no
 * check constraint behind this, and a session carrying `uncounted_policy =
 * 'existenca'` would be a session that fails at export weeks later, on the one
 * evening somebody is trying to close a month.
 */
export function parametersFrom(input: Partial<PostingParameters> | undefined): PostingParameters {
  const merged = { ...VERIFIED_PARAMETERS, ...(input ?? {}) };
  for (const key of Object.keys(ALLOWED) as (keyof PostingParameters)[]) {
    if (!ALLOWED[key].includes(merged[key])) {
      throw new Error(`${key} «${merged[key]}» no existe; los valores son ${ALLOWED[key].join(', ')}`);
    }
  }
  return merged;
}

export interface CreateOptions {
  /** Injected so a test does not have to guess a uuid. */
  newId?: () => string;
}

export async function createSession(
  db: Db,
  body: unknown,
  options: CreateOptions = {},
): Promise<ApiResult> {
  const newId = options.newId ?? (() => crypto.randomUUID());

  if (typeof body !== 'object' || body === null) {
    return fail(400, 'el cuerpo de la petición no es un objeto');
  }
  const input = body as Partial<CreateSessionBody>;
  if (typeof input.sourceBytesBase64 !== 'string' || input.sourceBytesBase64.length === 0) {
    return fail(400, 'falta el archivo (sourceBytesBase64)');
  }
  if (!Array.isArray(input.rows)) {
    return fail(400, 'faltan las filas leídas por el navegador (rows)');
  }

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(input.sourceBytesBase64);
  } catch (cause) {
    return fail(400, `el archivo no llegó en base64: ${messageOf(cause)}`);
  }

  let parameters: PostingParameters;
  try {
    parameters = parametersFrom(input.parameters);
  } catch (cause) {
    return fail(400, messageOf(cause));
  }

  // The §4.1 check, on the server's own parse of the bytes it is about to
  // store. `CatalogueError` carries the faults as data, so the screen can show
  // which invariant failed and on which rows rather than a sentence.
  let ingested;
  try {
    ingested = ingestZeusBytes(bytes, { id: newId() });
  } catch (cause) {
    if (cause instanceof CatalogueError) {
      return fail(422, cause.message, { faults: cause.faults });
    }
    return fail(422, messageOf(cause));
  }

  // The client parsed the same bytes. If the two disagree, the deployed build
  // is the one that will still be running when this count is posted, so the
  // upload is refused and the admin is told to reload rather than quietly
  // getting the server's reading of a file their screen showed differently.
  const differences = catalogueDifferences(ingested.rows, input.rows);
  if (differences.length > 0) {
    return fail(
      409,
      'el navegador y el servidor leyeron el archivo distinto. Recarga la página ' +
        '(la versión instalada está vieja) y vuelve a subirlo.',
      { differences },
    );
  }

  const rows = ingested.rows.map(toWire);

  // `familia` is stored only when the derivation produced a proposal at all.
  // A prefix column filled in for a catalogue whose codes are not 7 characters
  // would be a grouping nobody proposed and nobody can read.
  const families = deriveFamilies(ingested.session.items);
  const familia = families === null ? () => null : (row: CatalogueRowWire) => familyPrefix(row.codigo);

  await db.transaction(
    insertSessionStatements(
      {
        id: ingested.session.id,
        bodega: ingested.session.bodega,
        fechaCorte: ingested.session.fechaCorte,
        nombre: typeof input.nombre === 'string' && input.nombre.trim() !== '' ? input.nombre.trim() : null,
        sourceName: typeof input.sourceName === 'string' ? input.sourceName : null,
        sourceHash: ingested.session.sourceHash,
        sourceBytes: bytes,
        countTargetColumn: parameters.countTargetColumn,
        uncountedPolicy: parameters.uncountedPolicy,
        differenceColumn: parameters.differenceColumn,
        mostrarMarcaRegistrado: input.mostrarMarcaRegistrado ?? true,
      },
      rows,
      familia,
    ),
  );

  return created({
    id: ingested.session.id,
    bodega: ingested.session.bodega,
    fechaCorte: ingested.session.fechaCorte,
    sourceHash: ingested.session.sourceHash,
    itemCount: rows.length,
    estado: 'borrador',
    familias: families === null ? null : families.length,
  });
}

export async function listSessions(db: Db): Promise<ApiResult> {
  return ok({ sessions: await listSessionRows(db) });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const db = dbFromEnv();
    if (req.method === 'POST') return send(res, await createSession(db, req.body));
    if (req.method === undefined || req.method === 'GET') return send(res, await listSessions(db));
    return send(res, fail(405, 'GET o POST'));
  } catch (cause) {
    if (cause instanceof NoDatabaseError) return send(res, fail(503, cause.message));
    return send(res, fail(500, messageOf(cause)));
  }
}
