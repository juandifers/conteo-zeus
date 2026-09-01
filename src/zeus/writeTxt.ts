/**
 * Zeus .txt posting path — ZEUS_FORMAT.md §3, §7.1, §7.2, §9.
 *
 * Every row starts from the item's `rawRow`, so fields the writer has no
 * business touching are re-emitted verbatim and cannot be reformatted by
 * accident. `toma` is the one exception: it is never emitted implicitly (§9).
 *
 * **This function has no identity mode.** There is no option, and no
 * combination of defaults, that re-emits a file without every row first being
 * resolved — either by a supplied count or by an explicitly named
 * `uncountedPolicy`. The library default throws. Verbatim re-emission lives in
 * `reencode`, which takes no counts and is not a posting path (§8).
 */
import { encodeCp850 } from './cp850.js';
import { subtractDecimal } from '../lib/decimal.js';
import { formatExcelGeneral, formatNumber } from './formatNumber.js';
import { COL, ZEUS_FIELD_COUNT, type ZeusFile } from './types.js';

/** How many idarticulos an uncounted-items error lists before summarising. */
const MAX_REPORTED_UNCOUNTED = 20;

export interface WriteTxtOptions {
  /**
   * Which column receives the physical count.
   *
   * §7.1: evidence favours `toma`, but it is not proven that Zeus reads `toma`
   * rather than `conteo1` on import, so this stays a parameter.
   *
   * "Leave `toma` untouched" in §7.1 means *do not write the count there* — it
   * does not mean re-emit the source value. In `'conteo1'` mode §9 resolves
   * `toma` and `diferencia` on every row, counted or not, to the neutral
   * no-change pair (`toma = existencia`, `diferencia = 0`). Otherwise posting a
   * zero-defaulted `.txt` in this mode would re-emit its uncounted zeros in the
   * column §7.1 says Zeus most likely reads.
   */
  countTargetColumn?: 'toma' | 'conteo1';

  /**
   * What an item with no count means.
   *
   * §9, the highest-risk unknown in the format. The two source formats carry
   * opposite defaults for an uncounted row: the `.xls` pre-fills `toma` with
   * `existencia` (untouched = no change), while the sample `.txt` sits at
   * `toma = 0` in 206 of 298 rows (untouched = zero out the inventory). So
   * there is no safe implicit answer and the caller must choose one.
   *
   * - `'reject'` (default) — throw, listing the uncounted idarticulos.
   * - `'existencia'` — `toma = existencia`, `diferencia = 0`: explicit no-change.
   * - `'zero'` — `toma = 0`. Exists only so that choosing it requires typing it.
   */
  uncountedPolicy?: 'existencia' | 'zero' | 'reject';

  /**
   * What goes in the `diferencia` column on rows this writer computes.
   *
   * §7.2 is unresolved: `diferencia` is `0` in all 298 sample rows while
   * `toma ≠ existencia` in 255 of them, so Zeus probably computes it on import
   * — but there is no sample of a file that was successfully uploaded carrying
   * a real variance. Default `'computed'` on the payoff matrix: required if
   * Zeus reads the field, harmless if it does not. `'zero'` mirrors what the
   * hotel's own files carry; flip to it first if Zeus rejects our file or
   * accepts one that does not move the numbers.
   */
  differenceColumn?: 'computed' | 'zero';

  /**
   * How newly written numbers are rendered.
   *
   * Defaults by source (§3): an `.xls` source is rendered through Excel's
   * `General` 11-character cap, because that is what the Excel export applies;
   * a `.txt` source is already truncated and round-trips as-is. Override
   * explicitly to force one or the other.
   */
  numberFormat?: 'shortest' | 'excelGeneral';
}

/**
 * Thrown by the `'reject'` policy. Carries the ids as data, not only in the
 * message: the message caps its list at `MAX_REPORTED_UNCOUNTED` for
 * readability, and a caller that has to *act* on the uncounted set — put it on
 * screen, walk back to the shelf — needs all of them.
 */
export class UncountedItemsError extends Error {
  /** Every uncounted idarticulo, in file order. Not truncated. */
  readonly idarticulos: number[];
  /** How many items the file holds in total. */
  readonly total: number;

  constructor(idarticulos: number[], total: number) {
    super(describeUncounted(idarticulos, total));
    this.name = 'UncountedItemsError';
    this.idarticulos = idarticulos;
    this.total = total;
  }
}

function describeUncounted(ids: number[], total: number): string {
  const shown = ids.slice(0, MAX_REPORTED_UNCOUNTED).join(', ');
  const rest = ids.length - MAX_REPORTED_UNCOUNTED;
  const list = rest > 0 ? `${shown}, … (+${rest} more)` : shown;
  return (
    `${ids.length} of ${total} items have no count, so writing this file would ` +
    `emit an implicit toma for them (§9). Uncounted idarticulo: ${list}. ` +
    `Supply a count for every item, or pass uncountedPolicy: 'existencia' ` +
    `(explicit no-change) or 'zero'.`
  );
}

/**
 * Emit a Zeus .txt.
 *
 * @param file    the parsed source file
 * @param counts  physical counts keyed by `idarticulo` — the primary key (§4).
 *                Items absent from the map are handled by `uncountedPolicy`;
 *                they are never passed through verbatim (§9).
 */
export function writeTxt(
  file: ZeusFile,
  counts: Map<number, number> = new Map(),
  options: WriteTxtOptions = {},
): Uint8Array {
  const {
    countTargetColumn = 'toma',
    uncountedPolicy = 'reject',
    differenceColumn = 'computed',
  } = options;
  const numberFormat =
    options.numberFormat ?? (file.source === 'xls' ? 'excelGeneral' : 'shortest');
  const format = numberFormat === 'excelGeneral' ? formatExcelGeneral : formatNumber;

  const seen = new Set<number>();
  for (const [index, item] of file.items.entries()) {
    if (item.rawRow.length !== ZEUS_FIELD_COUNT) {
      throw new Error(
        `row ${index + 1} (idarticulo ${item.idarticulo}): rawRow holds ` +
          `${item.rawRow.length} fields, expected ${ZEUS_FIELD_COUNT}`,
      );
    }
    if (seen.has(item.idarticulo)) {
      throw new Error(
        `idarticulo ${item.idarticulo} appears more than once; it must be unique (§4)`,
      );
    }
    seen.add(item.idarticulo);
  }
  for (const idarticulo of counts.keys()) {
    if (!seen.has(idarticulo)) {
      throw new Error(`count supplied for idarticulo ${idarticulo}, which is not in this file`);
    }
  }

  const uncounted = file.items.filter((item) => !counts.has(item.idarticulo));
  if (uncountedPolicy === 'reject' && uncounted.length > 0) {
    throw new UncountedItemsError(
      uncounted.map((item) => item.idarticulo),
      file.items.length,
    );
  }

  const lines = file.items.map((item) => {
    const fields = item.rawRow.slice();
    const count = counts.get(item.idarticulo);

    if (countTargetColumn === 'conteo1') {
      // §9: toma and diferencia are resolved on EVERY row in this mode, counted
      // or not, and are never passed through from the source. The count goes to
      // conteo1; toma carries the neutral no-change pair so that a zero-defaulted
      // source cannot leak its uncounted zeros into the column §7.1 favours.
      // (diferencia is 0 under either §7.2 setting here, since toma == existencia.)
      if (count !== undefined) fields[COL.conteo1] = format(count);
      fields[COL.toma] = format(item.existencia);
      fields[COL.diferencia] = format(0);
    } else if (count !== undefined) {
      fields[COL.toma] = format(count);
      fields[COL.diferencia] = format(
        differenceColumn === 'computed' ? subtractDecimal(count, item.existencia) : 0,
      );
    } else if (uncountedPolicy === 'existencia') {
      // Explicit no-change (§9, T5) — what the .xls already encodes for a row
      // nobody touched. diferencia is 0 under either §7.2 setting.
      fields[COL.toma] = format(item.existencia);
      fields[COL.diferencia] = format(0);
    } else {
      // 'zero': counted as zero, so the whole book quantity is the variance
      // (§9) — unless §7.2 has been flipped to write a flat 0.
      fields[COL.toma] = format(0);
      fields[COL.diferencia] = format(
        differenceColumn === 'computed' ? subtractDecimal(0, item.existencia) : 0,
      );
    }

    return fields.join('\t');
  });

  // CRLF after every row, including the last (§3).
  return encodeCp850(lines.map((line) => `${line}\r\n`).join(''));
}
