/**
 * What a Zeus export says about itself that a hand-edited one cannot.
 *
 * `catalogueFaults` (importZeus.ts) reads the *names*: a code with two names, a
 * name under two codes, a `nombre` column in alphabetical order while the rows
 * are not. It is blind to the numbers. The pre-pilot failure-mode pass sorted
 * `existencia` alone in Excel — «continuar con la selección actual», the same
 * gesture that produced the sheared file in ZEUS_FORMAT.md §5 — and the import
 * was accepted: 286 of 298 book figures now sat beside the wrong article, and a
 * waived row posted another article's quantity (HUEVOS A, 10 080 → 0).
 *
 * A genuine export carries redundancy that such an edit breaks, measured on
 * both real files this project has (bodega 01, 298 rows; bodega 22, 2 rows):
 *
 *   `toma = existencia`   on every row — Zeus pre-fills the count column
 *   `costo ≈ costo2`      on every row, to 2e-8 relative — one cost, twice
 *   quantity columns      unordered in Zeus's row order (≈47 % of adjacent
 *                         pairs fall, ≈46 % rise, the rest tie)
 *
 * Three checks, each reading one of those:
 *
 *   1. A column **reordered on its own**: `toma` is a permutation of
 *      `existencia` (or `costo` of `costo2`) but not row for row. That is a
 *      sort of one column, exactly, and nothing else produces it.
 *   2. `costo` a permutation of `costo2`, the same way — `costo` sorted alone.
 *      A plain disagreement is *not* refused: with one real multi-row file,
 *      an edit and a Zeus habit nobody has seen yet look the same.
 *   3. A quantity column **in order** over the whole file. A sort of
 *      existencia together with toma leaves (1) satisfied, and only its order
 *      gives it away. A whole-sheet sort by quantity lands here too, and is
 *      refused with it: the rule is «upload what Zeus exported», and a re-export
 *      costs a minute.
 *
 * Plus one that is not about tampering: a tab or line break inside any field.
 * The `.txt` is tab-delimited with CRLF rows, so such a row cannot be written
 * back — and the writer finds out only after the seal, leaving a finished count
 * that can never produce its file. Refused here, naming the article.
 *
 * Thresholds are deliberately loose (5 % of rows, never fewer than two): a
 * column sort breaks almost every row, and a quirk of Zeus's that nobody has
 * seen yet should not block a bodega over one line.
 */
import type { ZeusFile, ZeusItem } from '../zeus/index.js';

/** Refused before a session exists. The message is the whole remedy. */
export class ArchivoAlteradoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivoAlteradoError';
  }
}

const REEXPORT =
  ' Vuelve a exportar la bodega desde Zeus y súbela tal como sale, sin abrirla ni ' +
  'ordenarla en Excel.';

/** Below this many rows an order is not evidence of anything. */
const ENOUGH_ROWS = 12;
/** Rows that must disagree before a disagreement is a finding: 5 %, at least two. */
const threshold = (rows: number) => Math.max(2, Math.ceil(rows * 0.05));

function closeCost(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-4 * Math.max(Math.abs(a), Math.abs(b)), 0.01);
}

function sameMultiset(
  a: readonly number[],
  b: readonly number[],
  equal: (x: number, y: number) => boolean,
): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((value, i) => equal(value, y[i]));
}

/** Ascending, descending, or neither — ignoring ties, and only with enough evidence. */
function orderOf(values: readonly number[]): 'ascendente' | 'descendente' | null {
  let rises = 0;
  let falls = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) rises++;
    else if (values[i] < values[i - 1]) falls++;
  }
  const moves = rises + falls;
  if (moves < ENOUGH_ROWS - 1) return null;
  if (falls / moves < 0.05) return 'ascendente';
  if (rises / moves < 0.05) return 'descendente';
  return null;
}

function example(items: readonly ZeusItem[], index: number): string {
  const item = items[index];
  return `«${item.nombre}» (idarticulo ${item.idarticulo})`;
}

/** The first reason this file is not what Zeus exported, in Spanish, or `null`. */
export function alteredFileReason(file: ZeusFile): string | null {
  const items = file.items;

  // A tab or line break inside a field: unwritable, whatever else is true.
  for (const item of items) {
    const at = item.rawRow.findIndex((value) => /[\t\r\n]/.test(value));
    if (at >= 0) {
      return (
        `El artículo ${example([item], 0)} tiene una tabulación o un salto de línea ` +
        'dentro de una celda. Zeus no puede recibir esa fila de vuelta, y el conteo ' +
        'no podría generar su archivo al final. Corrige el nombre en Zeus y vuelve a ' +
        'exportar la bodega.'
      );
    }
  }

  if (items.length < 2) return null;
  const limit = threshold(items.length);

  // 1. One column reordered on its own.
  const existencia = items.map((item) => item.existencia);
  const toma = items.map((item) => item.toma);
  const tomaOff = items.filter((item) => item.toma !== item.existencia).length;
  if (tomaOff >= limit && sameMultiset(existencia, toma, (a, b) => a === b)) {
    const first = items.findIndex((item) => item.toma !== item.existencia);
    return (
      `Las columnas «existencia» y «toma» tienen las mismas cifras pero en otro orden ` +
      `en ${tomaOff} de ${items.length} filas (por ejemplo ${example(items, first)}): ` +
      'una de las dos fue ordenada por separado, y las cantidades ya no corresponden a ' +
      'sus artículos.' +
      REEXPORT
    );
  }

  // 2. `costo` reordered on its own. Only the permutation is refused: a plain
  // disagreement between the two is an edit *or* a Zeus habit nobody has seen
  // yet (costo2 left at 0 on some rows, say), one real multi-row file is not
  // enough to tell those apart, and a refusal here has no override on cutoff
  // day.
  const costOff = items.filter((item) => !closeCost(item.costo, item.costo2)).length;
  if (
    costOff >= limit &&
    sameMultiset(
      items.map((item) => item.costo),
      items.map((item) => item.costo2),
      closeCost,
    )
  ) {
    const first = items.findIndex((item) => !closeCost(item.costo, item.costo2));
    return (
      `Las columnas «costo» y «costo2» tienen las mismas cifras pero en otro orden ` +
      `en ${costOff} de ${items.length} filas (por ejemplo ${example(items, first)}): ` +
      'una de las dos fue ordenada por separado.' +
      REEXPORT
    );
  }

  // 3. A quantity column in order over the whole file.
  if (items.length >= ENOUGH_ROWS) {
    for (const [column, values] of [
      ['existencia', existencia],
      ['costo', items.map((item) => item.costo)],
    ] as const) {
      const order = orderOf(values);
      if (order) {
        return (
          `La columna «${column}» está en orden ${order} de principio a fin. Zeus no ` +
          'exporta así: el archivo fue ordenado en una hoja de cálculo, y si se ordenó ' +
          'solo esa columna las cifras ya no corresponden a sus artículos.' +
          REEXPORT
        );
      }
    }
  }

  return null;
}
