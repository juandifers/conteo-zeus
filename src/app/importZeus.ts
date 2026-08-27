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
 * A way this file contradicts itself (ZEUS_FORMAT.md §4.1).
 *
 * Nothing in a Zeus row cross-checks its own name against its own key, so a
 * single file cannot be *verified* — only found inconsistent. What makes that
 * possible at all is that a catalogue repeats: 44 of bodega 01's 232 `codigo`s
 * carry more than one row, and names repeat across presentations. Those
 * repetitions are the only redundancy the format has, and every check below is
 * one of them.
 */
export interface CatalogueFault {
  kind: 'nombre-por-codigo' | 'codigo-por-nombre' | 'fila-repetida' | 'columna-ordenada';
  /**
   * What the rows disagree about: the `codigo`, the `nombre`, or
   * `codigo presentacion`. For `columna-ordenada` it is the column's name.
   */
  key: string;
  /**
   * What they say instead — names, codes, or the `idarticulo`s that collide.
   * For `columna-ordenada`, the first and last value in the column, which is
   * the evidence: `«|MIEL MAPLE SYRUP»` to `«ZUMO DE LIMON»`.
   */
  values: string[];
}

/** Trailing spaces and a double space are not a different product. */
function normal(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function conflicts(
  items: readonly Item[],
  kind: CatalogueFault['kind'],
  keyOf: (item: Item) => string,
  valueOf: (item: Item) => string,
): CatalogueFault[] {
  const seen = new Map<string, Set<string>>();
  for (const item of items) {
    const key = keyOf(item);
    const values = seen.get(key) ?? new Set<string>();
    values.add(valueOf(item));
    seen.set(key, values);
  }
  return [...seen]
    .filter(([, values]) => values.size > 1)
    .map(([key, values]) => ({ kind, key, values: [...values].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * How far out of alphabetical order a column is, as a fraction of the adjacent
 * pairs there are to be out of order.
 *
 * A real catalogue's names, read down the rows Zeus emitted, are shuffled:
 * bodega 01's `.xls` sits at 48.5% — 144 of its 297 pairs — which is what a
 * column nobody has touched looks like. Exported to `.txt` and handled, the
 * same 298 rows read 0%.
 */
export function inversionRate(values: readonly string[]): number {
  if (values.length < 2) return 0;
  let inversions = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1].localeCompare(values[i], 'es') > 0) inversions++;
  }
  return inversions / (values.length - 1);
}

/** Under this, a column is sorted. The samples are at 0% and 48.5%. */
const SORTED = 0.05;

/**
 * Below this many rows, an accident is no longer impossible enough to refuse
 * an import over. 11 pairs and a 5% allowance means *zero* inversions, which a
 * genuine catalogue reaches by luck once in 12! — about one in 479 million —
 * but a bodega with eight articles is a real thing and blocking one over a
 * coincidence is worse than the check is worth.
 */
const ENOUGH_ROWS = 12;

/**
 * The names are alphabetical and the rows are not.
 *
 * The second signal, and the one that survives where the first has nothing to
 * read. Zeus writes its rows in ascending `idarticulo`, an order that has
 * nothing to do with the alphabet — so a file still in that order whose
 * `nombre` column runs A to Z has had that column put in order by somebody,
 * separately, after the export. Every name is then one or more rows away from
 * the `codigo`, `costo` and `idarticulo` that stayed put.
 *
 * The `idarticulo` test is what keeps a legitimate sort out of it: somebody who
 * sorts by name in Excel with the whole sheet selected moves the rows, names
 * and keys together, and the file is fine. That one comes out with `nombre`
 * ordered and `idarticulo` shuffled, and this returns `null`.
 *
 * What it cannot tell apart is a bodega whose articles were genuinely created
 * in alphabetical order, where `idarticulo` ascending really is `nombre`
 * ascending. Bodega 01 is not one — 48.5% says so — but a bodega set up in one
 * sitting from an alphabetised list would be, and this would refuse it
 * (ZEUS_FORMAT.md §4.1).
 */
function sortedColumn(items: readonly Item[]): CatalogueFault | null {
  if (items.length < ENOUGH_ROWS) return null;
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1].idarticulo >= items[i].idarticulo) return null;
  }
  const names = items.map((item) => normal(item.nombre));
  if (inversionRate(names) >= SORTED) return null;
  return {
    kind: 'columna-ordenada',
    key: 'nombre',
    values: [names[0], names[names.length - 1]],
  };
}

/**
 * Every way this set of items gives itself away.
 *
 * Two signals, both of which the bodega 01 `.xls` passes and both of which the
 * `.txt` beside it — same bodega, same corte — fails.
 *
 * **The file contradicts itself.** Three invariants over the redundancy a
 * catalogue happens to carry:
 *
 *   `codigo` -> one `nombre`     one code is one product, whatever its
 *                                presentations. 43 of 44 multi-row codes fail.
 *   `nombre` -> one `codigo`     the mirror, and the one that still fires when
 *                                every code happens to be unique. 44 fail.
 *   `(codigo, presentacion)`     two rows for the same code and the same
 *                                presentation are two balances for one thing.
 *                                6 fail.
 *
 * **A column is in an order the file is not.** `nombre` alphabetical while the
 * rows are still in `idarticulo` order: 0% against the `.xls`'s 48.5%.
 *
 * The two do not overlap. The first reads repetition and says nothing about a
 * catalogue that has none — 232 unique codes and 232 unique names would satisfy
 * all three invariants while being nonsense. The second reads order and does
 * not care whether anything repeats. Between them they cover the failure that
 * matters: a displacement large enough to matter moves rows relative to each
 * other, and it is hard to do that without either breaking a repetition or
 * leaving a column suspiciously tidy.
 *
 * What neither can do is confirm that `idarticulo` 1960 really is the product
 * named beside it. There is no second opinion inside one file. The real one is
 * a previous session for the same bodega, which the database has from the
 * second import onward.
 */
export function catalogueFaults(items: readonly Item[]): CatalogueFault[] {
  const sorted = sortedColumn(items);
  return [
    ...conflicts(items, 'nombre-por-codigo', (i) => i.codigo, (i) => normal(i.nombre)),
    ...conflicts(items, 'codigo-por-nombre', (i) => normal(i.nombre), (i) => i.codigo),
    ...conflicts(
      items,
      'fila-repetida',
      (i) => `${i.codigo} ${normal(i.presentacion)}`,
      (i) => String(i.idarticulo),
    ),
    ...(sorted ? [sorted] : []),
  ];
}

/** `«a», «b» y «c»` — Spanish lists take no comma before the conjunction. */
function listOf(values: readonly string[]): string {
  const quoted = values.map((value) => `«${value}»`);
  if (quoted.length < 2) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} y ${quoted[quoted.length - 1]}`;
}

/**
 * What the person holding the file is told, and what to do about it.
 *
 * Two sentences before the remedy, because they are asked to distrust a file
 * they have no reason to distrust: what the file says about itself, and — if
 * the column gave it away — what a fresh export looks like instead. A bare
 * count of faults leaves somebody at six on cutoff day staring at a banner.
 */
export function describeFaults(faults: readonly CatalogueFault[]): string {
  const of = (kind: CatalogueFault['kind']) => faults.filter((f) => f.kind === kind);
  const names = of('nombre-por-codigo');
  const codes = of('codigo-por-nombre');
  const rows = of('fila-repetida');
  const sorted = of('columna-ordenada')[0];

  const parts: string[] = [];
  if (names.length > 0) parts.push(`${names.length} códigos llevan más de un nombre`);
  if (codes.length > 0) parts.push(`${codes.length} nombres aparecen bajo más de un código`);
  if (rows.length > 0) parts.push(`${rows.length} filas repiten código y presentación`);

  const sample = names[0] ?? codes[0];
  const contradicts =
    parts.length > 0
      ? `El archivo se contradice a sí mismo: ${parts.join(', ')}` +
        (sample ? ` — «${sample.key}» está como ${listOf(sample.values)}` : '') +
        '. '
      : '';
  const ordered = sorted
    ? `${parts.length > 0 ? 'Además la' : 'La'} columna de nombres va en orden alfabético de ` +
      `punta a punta, de «${sorted.values[0]}» a «${sorted.values[1]}», mientras las filas ` +
      'siguen en el orden en que Zeus las exporta. Un archivo recién exportado no sale así. '
    : '';

  return (
    contradicts +
    ordered +
    'Pasa cuando se ordenan unas columnas en Excel sin arrastrar el resto de la ' +
    'fila: el nombre y la existencia se mueven, el código y el costo se quedan. Un ' +
    'conteo tomado contra un archivo así se sube a los artículos equivocados. ' +
    'Vuelve a exportar la bodega desde Zeus sin ordenarla.'
  );
}

/** Thrown by `importZeusFile`; carries the whole list, not the summary. */
export class CatalogueError extends Error {
  readonly faults: readonly CatalogueFault[];
  constructor(faults: readonly CatalogueFault[]) {
    super(describeFaults(faults));
    this.name = 'CatalogueError';
    this.faults = faults;
  }
}

/**
 * The `ZeusItem` -> `Item` mapping, over a whole file.
 *
 * Exported because a test has to build a session the importer now refuses:
 * files like that were imported before the check existed, they are in the
 * database, and the screens still have to cope with them.
 */
export function toItems(file: ZeusFile): Item[] {
  return file.items.map(toItem);
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
  // These messages are read by whoever is holding the file, in a banner, at
  // six on cutoff day. They say what is wrong with the file and what to do
  // about it, in the language the rest of the app is written in.
  if (file.items.length === 0) {
    throw new Error('El archivo está vacío: no hay nada que contar.');
  }
  if (file.bodega === null) {
    throw new Error(
      'El archivo mezcla bodegas, así que no es un solo conteo. Exporta e importa ' +
        'una bodega por sesión.',
    );
  }
  if (file.fecha === null) {
    throw new Error(
      'El archivo mezcla fechas de corte, así que sus saldos no son una sola foto ' +
        'del inventario.',
    );
  }

  const seen = new Set<number>();
  const items: Item[] = [];
  for (const item of file.items) {
    if (seen.has(item.idarticulo)) {
      throw new Error(
        `El idarticulo ${item.idarticulo} aparece dos veces y es la llave primaria ` +
          'de este archivo (ZEUS_FORMAT.md §4). Vuelve a exportar la bodega desde Zeus.',
      );
    }
    seen.add(item.idarticulo);
    items.push(toItem(item));
  }

  // Last, because it is the expensive one and the cheap checks above name a
  // simpler problem when they fire. Refused rather than warned: a count taken
  // against a file whose names have come loose from its keys posts quantities
  // to the wrong articles, and there is no way to take that back once somebody
  // has uploaded it (ZEUS_FORMAT.md §4.1).
  const faults = catalogueFaults(items);
  if (faults.length > 0) throw new CatalogueError(faults);

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
