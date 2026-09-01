/**
 * The ingest path, shared by the browser that uploads a file and the function
 * that receives it.
 *
 * **There is one implementation of the §4.1 check and this is the module that
 * holds it.** The client parses the `.xls` and refuses a sheared file before a
 * session exists; the server re-parses the same bytes and refuses it again
 * before committing. That is not redundancy for its own sake. The client is a
 * PWA with a precaching service worker, so the build that uploads a file may be
 * weeks old and cached in a tablet nobody has reloaded — and §4.1 exists
 * because a file that parses is not a file that means anything. That reasoning
 * does not stop applying at the network boundary.
 *
 * What must never happen is two checks. A server-side reimplementation would
 * drift, and the failure mode is the one §4.1 is about: a count posted against
 * articles it was not taken from, discovered by the hotel's accountant weeks
 * later. So `importZeusFile` runs on both sides, unchanged, and this file is
 * the seam that lets it.
 */
import { sha256Hex } from '../lib/hash.js';
import type { Item, Session } from '../domain/index.js';
import { reencode, type ZeusFile } from '../zeus/index.js';
import { importZeusFile, parseZeusBytes, type ImportOptions } from './importZeus.js';

/**
 * One catalogue row: the domain's view of it, and the source bytes it came from.
 *
 * The two travel together because they answer different questions and neither
 * substitutes for the other. `item` is what a screen renders and what the fold
 * is keyed on; `rawRow` is what `writeTxt` re-emits 22 columns from, and it has
 * to survive the round trip through Postgres untouched or the export shears the
 * file (ZEUS_FORMAT.md §5, §8).
 *
 * `rawRow` is `readonly string[]` and nothing outside `src/zeus/` indexes into
 * it. The server moves those strings; it does not read them.
 */
export interface CatalogueRow {
  item: Item;
  rawRow: readonly string[];
}

export interface IngestedFile {
  session: Session;
  rows: CatalogueRow[];
}

/**
 * Parse bytes, run every import guard, and pair each row with its source.
 *
 * Throws exactly what `importZeusFile` throws — `CatalogueError` for §4.1,
 * plain `Error` for an empty file, mixed bodegas, mixed cutoffs or a repeated
 * `idarticulo`. Nothing here catches them: the caller is either a screen that
 * shows the message or a function that returns it as a 422, and swallowing one
 * to "try anyway" is the whole failure this path exists to prevent.
 */
export function ingestZeusBytes(bytes: Uint8Array, options: ImportOptions = {}): IngestedFile {
  const file = parseZeusBytes(bytes);
  return ingestZeusFile(file, options);
}

export function ingestZeusFile(file: ZeusFile, options: ImportOptions = {}): IngestedFile {
  const session = importZeusFile(file, options);
  // `importZeusFile` maps `file.items` in order and refuses a repeated
  // idarticulo before returning, so index `i` is the same row in both arrays.
  // Asserted rather than assumed: if that ever stops being true, every row's
  // raw bytes are attached to the wrong article and the export writes the count
  // to the wrong shelf.
  const rows = session.items.map((item, index) => {
    const source = file.items[index];
    if (!source || source.idarticulo !== item.idarticulo) {
      throw new Error(
        `row ${index + 1}: parsed item ${item.idarticulo} does not line up with its source ` +
          `row (${source ? source.idarticulo : 'missing'})`,
      );
    }
    return { item, rawRow: source.rawRow };
  });
  return { session, rows };
}

/**
 * A catalogue row on the wire, as the browser sends it and the server checks it.
 *
 * Every number is a **string**. `existencia` and `costo` are decimal and
 * `String(n)` is the shortest form that round-trips to the same double
 * (ZEUS_FORMAT.md §3), so a string is the only rendering that survives JSON,
 * the driver and `numeric` without a float in the middle. `idarticulo` is a
 * count of nothing and stays a number.
 */
export interface CatalogueRowWire {
  idarticulo: number;
  codigo: string;
  nombre: string;
  presentacion: string;
  existencia: string;
  costo: string;
  ultimoConteo: string | null;
  rawRow: string[];
}

export function toWire(row: CatalogueRow): CatalogueRowWire {
  return {
    idarticulo: row.item.idarticulo,
    codigo: row.item.codigo,
    nombre: row.item.nombre,
    presentacion: row.item.presentacion,
    existencia: String(row.item.existencia),
    costo: String(row.item.costo),
    ultimoConteo: row.item.ultimoConteo === null ? null : String(row.item.ultimoConteo),
    rawRow: [...row.rawRow],
  };
}

/**
 * How the server's own parse differs from what the client sent, if at all.
 *
 * Returns a list of differences in the language of the thing that differs, and
 * an empty list when the two agree. The caller refuses the upload on anything
 * non-empty and tells the admin to reload — because when a cached build and a
 * deployed one disagree about a file, the deployed one is the one that will
 * still be running when the count is posted.
 *
 * Capped, because 298 rows of disagreement is a stuck build rather than 298
 * facts.
 */
export function catalogueDifferences(
  server: readonly CatalogueRow[],
  client: readonly CatalogueRowWire[],
  limit = 10,
): string[] {
  const differences: string[] = [];
  if (server.length !== client.length) {
    differences.push(`el servidor leyó ${server.length} filas y el navegador envió ${client.length}`);
  }

  const sent = new Map(client.map((row) => [row.idarticulo, row]));
  for (const row of server) {
    if (differences.length >= limit) break;
    const theirs = sent.get(row.item.idarticulo);
    if (!theirs) {
      differences.push(`el idarticulo ${row.item.idarticulo} no llegó`);
      continue;
    }
    const ours = toWire(row);
    for (const key of Object.keys(ours) as (keyof CatalogueRowWire)[]) {
      const a = JSON.stringify(ours[key]);
      const b = JSON.stringify(theirs[key]);
      if (a !== b) {
        differences.push(`idarticulo ${row.item.idarticulo}: ${key} ${b} != ${a}`);
        break;
      }
    }
  }

  for (const idarticulo of sent.keys()) {
    if (differences.length >= limit) break;
    if (!server.some((row) => row.item.idarticulo === idarticulo)) {
      differences.push(`el idarticulo ${idarticulo} llegó pero no está en el archivo`);
    }
  }

  return differences;
}

/** The hash a session is stamped with, over bytes rather than a parsed file. */
export function sourceHashOfBytes(bytes: Uint8Array): string {
  return sha256Hex(reencode(parseZeusBytes(bytes)));
}
