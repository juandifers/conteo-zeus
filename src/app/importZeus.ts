/**
 * Zeus -> domain.
 *
 * src/app/ is the only place the two vocabularies meet. src/domain/ does not
 * know what a `rawRow` is and src/zeus/ does not know what a session is; when
 * the file channel becomes ODBC, this file is rewritten and the domain is not.
 */
import {
  NOT_APPLICABLE,
  parseTxt,
  parseXls,
  reencode,
  type ZeusFile,
  type ZeusItem,
} from '../zeus';
import { sha256Hex } from '../lib/hash';
import type { Item, Session, SessionSource } from '../domain';

export interface ImportOptions {
  /** Session id. Defaults to a fresh uuid; injectable so tests are deterministic. */
  id?: string;
  /** ISO-8601 instant. Defaults to now. */
  createdAt?: string;
  /**
   * The file, kept with the session (`SessionSource`).
   *
   * Supplied by `importZeusBytes`, which has the bytes in its hand. Posting
   * needs them back — `sourceHash` can only be re-checked against bytes, and
   * the writer re-emits 22 columns from the source row — and needing them back
   * is not a good enough reason to ask somebody to find the file again on the
   * machine they happen to be posting from.
   */
  source?: SessionSource;
}

/**
 * Drop everything the domain has no use for, and rename what it keeps.
 *
 * `costo2` becomes `costo`: ZEUS_FORMAT.md §2's `costo` is the 11-character
 * Excel `General` rendering (§3), and the waived value DOMAIN.md §5 puts in
 * front of a supervisor should not carry Excel's truncation. Over bodega 01 the
 * two differ by about 0.01 COP in 140M, which is nothing — but it is nothing
 * for a reason, not by luck, and the full-precision column is free.
 *
 * `conteo1` becomes `ultimoConteo`: the domain needs the prior for DOMAIN.md
 * §5's exposure figure, but a column name is exactly the kind of knowledge the
 * boundary exists to stop. `-1` is Zeus's not-applicable sentinel
 * (ZEUS_FORMAT.md §3) and becomes `null`; a genuine `0` is kept, because
 * "counted, found nothing" is data. All 298 sample rows carry a positive
 * prior, so the sentinel branch is defensive rather than exercised.
 */
function toItem(item: ZeusItem): Item {
  return {
    idarticulo: item.idarticulo,
    codigo: item.codigo,
    nombre: item.nombre,
    presentacion: item.presentacion,
    existencia: item.existencia,
    ultimoConteo: item.conteo1 === NOT_APPLICABLE ? null : item.conteo1,
    costo: item.costo2,
  };
}

/**
 * Build a session from a parsed Zeus file.
 *
 * `sourceHash` is the SHA-256 of the file's **canonical `.txt` rendering**
 * (`reencode`), not of the bytes handed to the parser. For a `.txt` source
 * those are the same thing — that is what the byte-exact round trip means — and
 * for an `.xls` it is the same content in the one representation both sources
 * share. So a session imported from the `.xls` and one imported from the `.txt`
 * Zeus exported beside it carry the same hash, and `exportAdjustment` can check
 * that the file it is about to write over is the file the count was taken
 * against.
 */
export function importZeusFile(file: ZeusFile, options: ImportOptions = {}): Session {
  if (file.items.length === 0) {
    throw new Error('cannot import an empty file: there is nothing to count');
  }
  if (file.bodega === null) {
    throw new Error(
      'this file mixes bodegas, so it is not one count. Import one warehouse per session',
    );
  }
  if (file.fecha === null) {
    throw new Error(
      'this file mixes cutoff dates, so its balances are not a single snapshot',
    );
  }

  const seen = new Set<number>();
  const items: Item[] = [];
  for (const item of file.items) {
    if (seen.has(item.idarticulo)) {
      throw new Error(
        `idarticulo ${item.idarticulo} appears twice; it is the primary key ` +
          '(ZEUS_FORMAT.md §4)',
      );
    }
    seen.add(item.idarticulo);
    items.push(toItem(item));
  }

  return {
    id: options.id ?? crypto.randomUUID(),
    bodega: file.bodega,
    fechaCorte: file.fecha,
    sourceHash: sourceHashOf(file),
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.source ? { source: options.source } : {}),
    items: Object.freeze(items),
  };
}

/** The hash `importZeusFile` stamps on a session. Exported so export can re-check it. */
export function sourceHashOf(file: ZeusFile): string {
  return sha256Hex(reencode(file));
}

/**
 * The two byte signatures a Zeus export can arrive under.
 *
 * `D0 CF 11 E0` is the OLE2 compound-file header the ERP's `.xls` carries;
 * `PK\x03\x04` is the zip header of the `.xlsx` a future Zeus (or an
 * intermediate Excel save) would produce. Anything else is treated as the
 * CP850 `.txt`, which has no signature to test for.
 */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * Import raw bytes, whichever of the two representations they are.
 *
 * The UI hands over what a file picker gave it and never learns that a Zeus
 * file has a format at all: which parser runs is a decision about bytes, and
 * bytes are src/zeus/'s subject. Sniffed rather than taken from the file
 * extension, because a picker on Android reports whatever the sending app
 * felt like putting in the name.
 */
export function importZeusBytes(
  bytes: Uint8Array,
  name: string,
  options: ImportOptions = {},
): Session {
  return importZeusFile(parseZeusBytes(bytes), {
    ...options,
    source: options.source ?? { name, bytes },
  });
}

/**
 * Which of the two representations these bytes are, and the parsed file.
 *
 * Shared by import and by posting, because posting re-reads the same bytes out
 * of the session: two sniffs that could disagree would mean a file could
 * import as one format and export as another.
 */
export function parseZeusBytes(bytes: Uint8Array): ZeusFile {
  if (bytes.length === 0) {
    throw new Error('el archivo está vacío');
  }
  return startsWith(bytes, OLE2) || startsWith(bytes, ZIP) ? parseXls(bytes) : parseTxt(bytes);
}
