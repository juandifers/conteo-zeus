/**
 * Did this posting operation preserve what it promised?
 *
 * `writeTxt` builds every row from `item.rawRow.slice()` and overwrites only
 * the columns it must, which is the reason this app cannot shear a file the
 * way the hotel's Excel process did. But that is a property of one function's
 * body, and the day somebody adds `zona` to the item data, rebuilds a row from
 * the domain `Item`, or sorts the output for readability, the property is gone
 * — silently, in a file that still looks like a Zeus export, surfacing in the
 * ledger weeks later.
 *
 * So the invariant is checked rather than described. The emitted bytes are
 * parsed back and compared against the source they came from, and a mismatch
 * throws.
 *
 * **This lives in src/app/ and not in src/zeus/.** `writeTxt` is a serialiser;
 * a serialiser that parses its own output to see whether it worked is marking
 * its own homework, and the two would share whatever assumption was wrong.
 * "Did this posting operation preserve what it promised" is a question about
 * an *operation* — a file, a count map, a policy — and operations are what
 * this layer is.
 *
 * It runs on the tablet, in the real posting path, once per count. It is not a
 * test assertion that happens to be compiled in: the refactor it exists to
 * catch is one nobody would think to re-run the test suite for, and the only
 * moment worth catching it is the moment before the bytes reach somebody's
 * downloads folder.
 */
import { parseTxt, ZEUS_COLUMNS, type ZeusFile, type ZeusItem } from '../zeus';

/** Column indices, by name, from the adapter's own list. */
const COLUMN = Object.fromEntries(
  ZEUS_COLUMNS.map((name, index) => [name, index]),
) as Record<(typeof ZEUS_COLUMNS)[number], number>;

/** How many mismatches the message spells out before summarising. */
const MAX_REPORTED = 8;

export interface VerifyWriteBackOptions {
  /** The column the count was written to. Decides the write set — see below. */
  countTargetColumn?: 'toma' | 'conteo1';
  /** What the writer was told an uncounted row means. */
  uncountedPolicy?: 'existencia' | 'zero' | 'reject';
}

/**
 * The app contradicted itself, and the file must not be uploaded.
 *
 * Deliberately not a `CatalogueError`, which says the *input* was bad and is
 * answered by re-importing the bodega. This one says the output does not match
 * the input it was built from: nothing the person in front of the screen did
 * caused it and nothing they can do will fix it. Nothing catches this and
 * falls back to writing the file anyway.
 */
export class PostingVerificationError extends Error {
  /** Every mismatch found, untruncated. The message caps its list. */
  readonly mismatches: string[];

  constructor(mismatches: string[]) {
    super(
      'No subas nada a Zeus. El archivo que esta aplicación acaba de construir no ' +
        'coincide con el archivo del que salió, así que no se puede afirmar que ' +
        'lleve los conteos que se tomaron sobre los artículos sobre los que se ' +
        'tomaron. No se descargó nada, y el conteo sigue guardado. Es un defecto ' +
        'de la aplicación, no del archivo que importaste ni de nada que hayas ' +
        'hecho: avisa a sistemas antes de volver a intentarlo. ' +
        `${mismatches.length} discrepancia(s): ${describe(mismatches)}`,
    );
    this.name = 'PostingVerificationError';
    this.mismatches = mismatches;
  }
}

function describe(mismatches: string[]): string {
  const shown = mismatches.slice(0, MAX_REPORTED).join('; ');
  const rest = mismatches.length - MAX_REPORTED;
  return rest > 0 ? `${shown}; … (+${rest} más)` : shown;
}

/**
 * Which columns this operation was allowed to change.
 *
 * Getting this wrong makes the whole check useless in one mode and noisy in
 * the other, so it is derived from the options actually passed rather than
 * from a constant:
 *
 * - `'toma'` — the count goes to `toma` and the variance to `diferencia`.
 *   `conteo1` is Zeus's own prior count and must come out byte-identical.
 * - `'conteo1'` — the count goes to `conteo1`, and ZEUS_FORMAT.md §9 also
 *   resolves `toma` and `diferencia` on *every* row in that mode, so all three
 *   are written.
 */
function writeSet(target: 'toma' | 'conteo1'): Set<number> {
  const columns =
    target === 'conteo1'
      ? [COLUMN.toma, COLUMN.diferencia, COLUMN.conteo1]
      : [COLUMN.toma, COLUMN.diferencia];
  return new Set(columns);
}

/** The number this row actually carries in the column the count was aimed at. */
function emittedCount(item: ZeusItem, target: 'toma' | 'conteo1'): number {
  return target === 'conteo1' ? item.conteo1 : item.toma;
}

/**
 * Check the bytes against the file and the counts they claim to represent.
 *
 * Throws `PostingVerificationError` listing everything it found; returns
 * silently otherwise. Five properties, and each one is a different way the
 * claim "this file carries the counts that were taken, against the articles
 * they were taken on" could be false:
 *
 * 1. Same number of rows. A file with 297 of 298 articles posts a bodega that
 *    does not exist.
 * 2. Same articles in the same order. Zeus keys on `idarticulo`
 *    (ZEUS_FORMAT.md §4), so a re-keyed or re-sorted file is the shearing
 *    failure exactly.
 * 3. Every column outside the write set byte-identical. This is the one that
 *    catches a row rebuilt from the domain `Item` — the domain kept six fields
 *    of twenty-four, so `costo`, `lote`, `serial` and the rest would come back
 *    reformatted or empty.
 * 4. Every supplied count present, in the target column, as a number. Compared
 *    numerically and not as a string, so a change in how numbers are rendered
 *    is not mistaken for a wrong count — and, in the other direction, a
 *    formatter that silently rounded a count *is* reported, because a rounded
 *    count is a different count.
 * 5. Every uncounted row matching the policy that was declared for it — and,
 *    in `'conteo1'` mode, every row carrying §9's neutral `toma`/`diferencia`
 *    pair, since those two columns are written there and property 3 therefore
 *    lets them past.
 *
 * `catalogueFaults` is deliberately **not** re-run on the emitted bytes.
 * Property 3 already proves the name and code columns are byte-identical to a
 * source that passed the catalogue check at import, so re-checking would be a
 * second name for the same guarantee and a second place to keep it right.
 */
export function verifyWriteBack(
  source: ZeusFile,
  emitted: Uint8Array,
  counts: ReadonlyMap<number, number>,
  options: VerifyWriteBackOptions = {},
): void {
  const target = options.countTargetColumn ?? 'toma';
  const policy = options.uncountedPolicy ?? 'reject';
  const written = writeSet(target);
  const mismatches: string[] = [];

  let back: ZeusFile;
  try {
    back = parseTxt(emitted);
  } catch (cause) {
    // The writer emitted something this app cannot read back. Whatever else is
    // true, that file is not a Zeus export.
    throw new PostingVerificationError([
      `los bytes generados no se pueden volver a leer como un .txt de Zeus: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }

  // 1. Same number of rows. Reported and returned: without a row count the
  //    positional comparisons below would be comparing different articles and
  //    would bury this under 298 spurious findings.
  if (back.items.length !== source.items.length) {
    throw new PostingVerificationError([
      `el archivo generado tiene ${back.items.length} filas y el original ` +
        `${source.items.length}`,
    ]);
  }

  for (const [index, before] of source.items.entries()) {
    const after = back.items[index];
    const row = index + 1;

    // 2. Same article, same position.
    if (after.idarticulo !== before.idarticulo) {
      mismatches.push(
        `fila ${row}: idarticulo ${after.idarticulo} donde el original tiene ` +
          `${before.idarticulo}`,
      );
      // Everything below compares this row against an article it is not, so
      // there is nothing further worth saying about it.
      continue;
    }

    // 3. Everything outside the write set, byte for byte.
    for (let column = 0; column < ZEUS_COLUMNS.length; column++) {
      if (written.has(column)) continue;
      if (after.rawRow[column] === before.rawRow[column]) continue;
      mismatches.push(
        `fila ${row} (idarticulo ${before.idarticulo}) columna ` +
          `${ZEUS_COLUMNS[column]}: ${JSON.stringify(after.rawRow[column])} donde el ` +
          `original tiene ${JSON.stringify(before.rawRow[column])}`,
      );
    }

    // In `'conteo1'` mode the count is not the only thing written: §9 resolves
    // `toma` and `diferencia` to the neutral no-change pair on **every** row,
    // counted or not, so that a zero-defaulted source cannot leak its
    // uncounted zeros into the column §7.1 favours. Both columns are in the
    // write set and so escape property 3 — which would leave the two fields
    // Zeus most likely reads unchecked in this mode, and the check would be
    // asserting the harmless half of the operation.
    if (target === 'conteo1') {
      if (after.toma !== before.existencia) {
        mismatches.push(
          `fila ${row} (idarticulo ${before.idarticulo}): en modo conteo1, toma salió ` +
            `en ${after.toma} y §9 exige la existencia, ${before.existencia}`,
        );
      }
      if (after.diferencia !== 0) {
        mismatches.push(
          `fila ${row} (idarticulo ${before.idarticulo}): en modo conteo1, diferencia ` +
            `salió en ${after.diferencia} y §9 exige 0`,
        );
      }
    }

    const count = counts.get(before.idarticulo);
    if (count !== undefined) {
      // 4. The count the fold produced, in the column it was aimed at.
      const landed = emittedCount(after, target);
      if (landed !== count) {
        mismatches.push(
          `fila ${row} (idarticulo ${before.idarticulo}): ${target} salió en ${landed} ` +
            `y el conteo era ${count}`,
        );
      }
      continue;
    }

    // 5. No count for this row, so it carries whatever the declared policy
    //    said it should. `'reject'` cannot reach here — writeTxt has already
    //    thrown on the first uncounted row — but the branch is the definition
    //    of the promise, not a defensive guess, so it is stated.
    if (policy === 'reject') {
      mismatches.push(
        `fila ${row} (idarticulo ${before.idarticulo}): salió sin conteo, y la ` +
          'política era rechazar el archivo antes que emitir una fila sin contar',
      );
    } else if (policy === 'existencia') {
      if (after.toma !== before.existencia) {
        mismatches.push(
          `fila ${row} (idarticulo ${before.idarticulo}): sin conteo, toma salió en ` +
            `${after.toma} y la política 'existencia' exige ${before.existencia}`,
        );
      }
      if (after.diferencia !== 0) {
        mismatches.push(
          `fila ${row} (idarticulo ${before.idarticulo}): sin conteo, diferencia ` +
            `salió en ${after.diferencia} y la política 'existencia' exige 0`,
        );
      }
    } else if (after.toma !== 0) {
      mismatches.push(
        `fila ${row} (idarticulo ${before.idarticulo}): sin conteo, toma salió en ` +
          `${after.toma} y la política 'zero' exige 0`,
      );
    }
  }

  if (mismatches.length > 0) throw new PostingVerificationError(mismatches);
}
