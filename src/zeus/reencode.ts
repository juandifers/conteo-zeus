/**
 * Verbatim re-emission of a parsed Zeus file — ZEUS_FORMAT.md §8.
 *
 * Parse fidelity and posting are separate operations. This module is the
 * former: it re-emits exactly what was parsed, applying no counts and no
 * uncounted policy, so that a round trip can be proved byte-exact (T1).
 *
 * **This is not a posting path.** It deliberately does not take counts and
 * must never be used to produce a file for upload to Zeus: it re-emits `toma`
 * straight from `rawRow`, which is precisely the pass-through §9 forbids —
 * safe against an `.xls` (where `toma` is pre-filled with `existencia`) and
 * catastrophic against a zero-defaulted `.txt` (206 of 298 rows at `toma = 0`).
 * Posting goes through `writeTxt`, which has no identity mode and requires
 * every row to be explicitly resolved.
 */
import { encodeCp850 } from './cp850';
import { ZEUS_FIELD_COUNT, type ZeusFile } from './types';

/**
 * Re-emit a parsed file byte-for-byte as it was read.
 *
 * Round-trips any file `parseTxt` accepts. Also usable on a `parseXls` result,
 * where it yields the `.txt` rendering of the workbook — still not a posting
 * path, because the counts in it are whatever the spreadsheet already held.
 */
export function reencode(file: ZeusFile): Uint8Array {
  const lines = file.items.map((item, index) => {
    if (item.rawRow.length !== ZEUS_FIELD_COUNT) {
      throw new Error(
        `row ${index + 1} (idarticulo ${item.idarticulo}): rawRow holds ` +
          `${item.rawRow.length} fields, expected ${ZEUS_FIELD_COUNT}`,
      );
    }
    return item.rawRow.join('\t');
  });

  // CRLF after every row, including the last (§3).
  return encodeCp850(lines.map((line) => `${line}\r\n`).join(''));
}
