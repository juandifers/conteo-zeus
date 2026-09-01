/**
 * The golden files — `samples/golden/`, described by its `PROVENANCE.md`.
 *
 * Two fixtures with two different kinds of authority, and the tests keep them
 * apart because reading one as the other is the mistake that matters:
 *
 * - `zeus-verified/` was uploaded into Zeus and posted the right balances. It
 *   locks **correctness**, and it is two rows long.
 * - `generated/` was produced by this repository over the real 298-row
 *   catalogue. It locks **reproducibility** — that P2 emits what P1 emitted —
 *   and proves nothing about what Zeus does with the bytes.
 *
 * G1 is the freeze. When it fails, the default assumption is that the change is
 * wrong, not that the golden file is stale.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  decodeCp850,
  encodeCp850,
  parseTxt,
  parseXls,
  writeTxt,
  ZEUS_COLUMNS,
  ZEUS_FIELD_COUNT,
  type ZeusFile,
} from '../src/zeus';
// `COL` is deliberately not on the adapter's public surface — a consumer that
// knew a column index would be encoding the format outside src/zeus/. A test
// asserting §3's field caps is the one caller with a reason to reach for it.
import { COL } from '../src/zeus/types';
import { firstDifference, readSample, SAMPLE_XLS } from './helpers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'samples', 'golden');

/**
 * The verified triple (ZEUS_FORMAT.md §7.1), written out once and shared.
 *
 * Evidence for a *combination* does not decompose into evidence for each
 * parameter separately, so nothing here varies one of them and calls the result
 * golden. A test that wanted `'conteo1'` or `'zero'` would be testing an
 * untested branch, and would have to say so in its own name.
 */
const VERIFIED = {
  countTargetColumn: 'toma',
  uncountedPolicy: 'existencia',
  differenceColumn: 'computed',
} as const;

/**
 * Load a `counts.json`.
 *
 * The fixture holds **strings** and they are parsed exactly here, once. A JSON
 * float would have gone through an IEEE754 double before the test ever ran,
 * which is the class of error the fixture exists to catch (ZEUS_FORMAT.md §3).
 */
function loadCounts(path: string): Map<number, number> {
  const raw: Record<string, string> = JSON.parse(readFileSync(path, 'utf8'));
  const counts = new Map<number, number>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(
        `${path}: quantity for idarticulo ${key} is ${typeof value}, not a string. ` +
          'Quantities in this fixture are decimal strings parsed once at load — a ' +
          'JSON float would defeat the point of the test (ZEUS_FORMAT.md §3).',
      );
    }
    const idarticulo = Number(key);
    const qty = Number(value);
    if (!Number.isInteger(idarticulo) || !Number.isFinite(qty)) {
      throw new Error(`${path}: unusable entry ${JSON.stringify([key, value])}`);
    }
    counts.set(idarticulo, qty);
  }
  return counts;
}

const GENERATED = {
  xls: SAMPLE_XLS,
  counts: join(GOLDEN, 'generated', 'counts.json'),
  expected: join(GOLDEN, 'generated', 'expected.txt'),
};

const VERIFIED_FILES = {
  xls: join(GOLDEN, 'zeus-verified', 'LISTADO PRUEBA PPNS.xls'),
  counts: join(GOLDEN, 'zeus-verified', 'counts.json'),
  expected: join(GOLDEN, 'zeus-verified', 'LISTADO PRUEBA PPNS - conteo 2026-08-28 #1.txt'),
};

/**
 * `firstDifference` with the field *name* attached.
 *
 * A diff of two 30 KB CP850 blobs is not a usable failure message, and neither
 * is a bare field index: the whole question when G1 fails is which column moved.
 */
function report(actual: Uint8Array, expected: Uint8Array): string | null {
  const diff = firstDifference(actual, expected);
  if (diff === null) return null;
  const field = /field index (\d+)/.exec(diff);
  const named =
    field && ZEUS_COLUMNS[Number(field[1])]
      ? `\n  field ${field[1]} is \`${ZEUS_COLUMNS[Number(field[1])]}\``
      : '';
  return (
    `${diff}${named}\n` +
    '  The golden file is the expectation. Read this as "the change is wrong"\n' +
    '  before reading it as "the golden file is stale" — samples/golden/PROVENANCE.md.'
  );
}

describe('G1 — byte equality (the freeze)', () => {
  it('reproduces the file Zeus accepted, byte for byte', () => {
    const file = parseXls(readSample(VERIFIED_FILES.xls));
    const expected = readSample(VERIFIED_FILES.expected);
    const emitted = writeTxt(file, loadCounts(VERIFIED_FILES.counts), VERIFIED);

    // Stated rather than left implicit: this is the assertion whose failure
    // means the app no longer writes what an ERP once posted correctly.
    expect(report(emitted, expected)).toBeNull();
  });

  it('reproduces the generated 298-row file, byte for byte', () => {
    const file = parseXls(readSample(GENERATED.xls));
    const expected = readSample(GENERATED.expected);
    const emitted = writeTxt(file, loadCounts(GENERATED.counts), VERIFIED);

    expect(report(emitted, expected)).toBeNull();
  });

  it('freezes CRLF and the trailing newline, which a byte compare could not name', () => {
    // Byte equality already covers this. It is asserted separately because
    // "the last line has no CRLF" is a one-byte difference at the very end of
    // a 32 KB file, and the diff message for it reads as a length mismatch.
    for (const path of [GENERATED.expected, VERIFIED_FILES.expected]) {
      const bytes = readSample(path);
      expect([...bytes.slice(-2)]).toEqual([0x0d, 0x0a]);
      const lf = [...bytes].filter((b) => b === 0x0a).length;
      const crlf = [...bytes].filter((b, i) => b === 0x0a && bytes[i - 1] === 0x0d).length;
      expect(crlf).toBe(lf);
    }
  });
});

describe('G2 — the unforgeable zero (§7.4)', () => {
  /**
   * A zero in the count column is a stock deletion, so it may arrive from
   * exactly two places: an explicit `0` count, or `existencia` already being
   * `0` under `uncountedPolicy: 'existencia'`. Remove the first and the second
   * must account for **every** zero in the file — not most of them.
   */
  it('emits a zero only where existencia is zero, when no count is zero', () => {
    const file = parseXls(readSample(GENERATED.xls));
    const counts = loadCounts(GENERATED.counts);
    for (const [idarticulo, qty] of counts) if (qty === 0) counts.delete(idarticulo);
    expect([...counts.values()].every((qty) => qty !== 0)).toBe(true);

    const back = parseTxt(writeTxt(file, counts, VERIFIED));
    const zeroed = back.items.filter((item) => item.toma === 0).map((item) => item.idarticulo);
    const emptyBalance = file.items
      .filter((item) => item.existencia === 0)
      .map((item) => item.idarticulo);

    // Set equality, not a subset and not a count. A single extra id here is a
    // row whose stock this file would delete and nobody asked it to.
    expect(new Set(zeroed)).toEqual(new Set(emptyBalance));
    expect(zeroed.length).toBe(31); // ZEUS_FORMAT.md §9: the fresh-produce rows.
  });

  it('carries exactly one zero beyond the empty balances, and it was counted', () => {
    // The other half of the property: an explicit zero must survive. A writer
    // that suppressed zeros would pass the test above and lose a real count.
    const file = parseXls(readSample(GENERATED.xls));
    const counts = loadCounts(GENERATED.counts);
    const back = parseTxt(writeTxt(file, counts, VERIFIED));

    const zeroed = new Set(back.items.filter((i) => i.toma === 0).map((i) => i.idarticulo));
    const emptyBalance = new Set(
      file.items.filter((i) => i.existencia === 0).map((i) => i.idarticulo),
    );
    const explicit = [...zeroed].filter((id) => !emptyBalance.has(id));

    expect(explicit).toEqual([1926]); // AJÍ CHIPOTLE AMAZON, existencia 4, found empty.
    expect(counts.get(1926)).toBe(0);
  });

  it('holds on the verified file too, which contains no zero at all', () => {
    const file = parseXls(readSample(VERIFIED_FILES.xls));
    const back = parseTxt(readSample(VERIFIED_FILES.expected));
    expect(file.items.every((item) => item.existencia !== 0)).toBe(true);
    expect(back.items.every((item) => item.toma !== 0)).toBe(true);
  });
});

describe('G3 — structural invariants, independent of any golden file', () => {
  /**
   * True of *any* output, so they are asserted over several files and count
   * maps rather than over the frozen bytes. A golden file cannot catch a
   * regression on a catalogue it does not contain.
   */
  const cases: Array<{ name: string; xls: string; counts: string }> = [
    { name: 'generated / 298 rows', xls: GENERATED.xls, counts: GENERATED.counts },
    { name: 'zeus-verified / 2 rows', xls: VERIFIED_FILES.xls, counts: VERIFIED_FILES.counts },
  ];

  function emissions(xls: string, counts: string): Array<{ source: ZeusFile; bytes: Uint8Array }> {
    const source = parseXls(readSample(xls));
    return [
      { source, bytes: writeTxt(source, loadCounts(counts), VERIFIED) },
      // The empty map is the pure-policy path: every row resolved by §9 and
      // not one of them by a count. Structure must not depend on that.
      { source, bytes: writeTxt(source, new Map(), VERIFIED) },
    ];
  }

  for (const { name, xls, counts } of cases) {
    describe(name, () => {
      it('emits 24 tab-separated fields on every row', () => {
        for (const { bytes } of emissions(xls, counts)) {
          const lines = decodeCp850(bytes).split('\r\n');
          expect(lines[lines.length - 1]).toBe(''); // the trailing CRLF
          for (const [index, line] of lines.slice(0, -1).entries()) {
            expect({ row: index + 1, fields: line.split('\t').length }).toEqual({
              row: index + 1,
              fields: ZEUS_FIELD_COUNT,
            });
          }
        }
      });

      it('is CP850-encodable throughout, and round-trips through the codec', () => {
        for (const { bytes } of emissions(xls, counts)) {
          const text = decodeCp850(bytes);
          // `encodeCp850` throws on a character with no CP850 representation
          // (§6) rather than substituting, so this is the assertion.
          expect([...encodeCp850(text)]).toEqual([...bytes]);
        }
      });

      it('ends every line with CRLF, including the last', () => {
        for (const { bytes } of emissions(xls, counts)) {
          expect([...bytes.slice(-2)]).toEqual([0x0d, 0x0a]);
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0x0a) expect(bytes[i - 1]).toBe(0x0d);
            if (bytes[i] === 0x0d) expect(bytes[i + 1]).toBe(0x0a);
          }
        }
      });

      it('keeps every field inside its §3 cap', () => {
        // `costo` goes through Excel's `General` format, which caps at 11
        // characters. `costo2` is explicitly not subject to it (§2).
        for (const { bytes } of emissions(xls, counts)) {
          for (const line of decodeCp850(bytes).split('\r\n').slice(0, -1)) {
            const fields = line.split('\t');
            expect(fields[COL.costo].length).toBeLessThanOrEqual(11);
            expect(fields[COL.bodega].length).toBeLessThanOrEqual(2);
          }
        }
      });

      it('emits one row per catalogue row, in the source order, keyed the same', () => {
        for (const { source, bytes } of emissions(xls, counts)) {
          const back = parseTxt(bytes);
          expect(back.items.length).toBe(source.items.length);
          expect(back.items.map((i) => i.idarticulo)).toEqual(
            source.items.map((i) => i.idarticulo),
          );
        }
      });

      it('preserves the source row order rather than imposing one', () => {
        // §4.1 records that Zeus writes its rows in ascending `idarticulo`,
        // and the hotel's bodega 01 export is. The bodega 22 export is **not**
        // — its two rows are 91069 then 15450 — so ascending order is a
        // property of a particular source, never of the writer, and asserting
        // it here would fail on a real Zeus file (§7.5).
        //
        // What is universal, and what the shearing failure would break, is that
        // the writer emits the rows it was given in the order it was given
        // them. That is already covered above; this states the sharper half:
        // re-sorting the output "for readability" must be caught even when the
        // result happens to be tidier than the input.
        for (const { source, bytes } of emissions(xls, counts)) {
          expect(parseTxt(bytes).items.map((i) => i.idarticulo)).toEqual(
            source.items.map((i) => i.idarticulo),
          );
        }
        const verified = parseXls(readSample(VERIFIED_FILES.xls));
        expect(verified.items.map((i) => i.idarticulo)).toEqual([91069, 15450]);
      });
    });
  }
});
