/**
 * `writeAdjustment` — the sealed session's file, and the check that aborts it
 * (P2.5 §2b).
 *
 * Two things worth asserting here rather than through the endpoint.
 *
 * **The abort is an abort.** `verifyWriteBack` re-parses the emitted bytes
 * against the source they came from and throws; nothing catches it, and no
 * bytes come back. It is the check that catches the P1 defect class — the
 * sheared file that would have posted wrong balances to nearly every row — and
 * there is no version of «export it anyway» that is correct.
 *
 * **`uncountedPolicy: 'existencia'` is deliberate here and `'reject'` is
 * deliberate in `exportAdjustment`.** The two functions differ in exactly that
 * one place, and the difference is the whole of P2 versus P1: a bodega where
 * 1 800 rows were never reached still has to produce 1 800 lines, because Zeus's
 * format has no way to say «we did not look» (ZEUS_FORMAT.md §9). What makes
 * that defensible is not this function; it is the acta's §8.
 */
import { describe, expect, it } from 'vitest';

import { adjustmentFilename, PostingVerificationError, writeAdjustment } from '../src/app';
import { parseTxt, parseXls, reencode } from '../src/zeus';
import { sha256Hex } from '../src/lib/hash';
import { readSample, SAMPLE_XLS } from './helpers';

const VERIFIED = {
  countTargetColumn: 'toma',
  uncountedPolicy: 'existencia',
  differenceColumn: 'computed',
} as const;

const XLS = parseXls(readSample(SAMPLE_XLS));
const TXT = parseTxt(reencode(XLS));

describe('writeAdjustment', () => {
  it('writes every row, counted or not, and reports which is which', () => {
    const counts = new Map([[TXT.items[0].idarticulo, 3]]);
    const written = writeAdjustment(TXT, counts, VERIFIED);

    expect(written.filas).toBe(TXT.items.length);
    expect(written.resueltas).toBe(1);
    expect(written.porPolitica).toBe(TXT.items.length - 1);
    expect(written.fileHash).toBe(sha256Hex(written.bytes));

    const back = parseTxt(written.bytes);
    expect(back.items[0].toma).toBe(3);
    // The G2 branch, in code: everything nobody reached carries the book figure
    // and a zero variance. Only Zeus can confirm what that *means* on import —
    // ZEUS_FORMAT.md §7 records that, and PRIMERA-CORRIDA.md is how it gets
    // observed.
    for (const [index, item] of back.items.entries()) {
      if (index === 0) continue;
      expect(item.toma).toBe(TXT.items[index].existencia);
      expect(item.diferencia).toBe(0);
    }
  });

  it('aborts, with no bytes, when the emitted file does not carry the count it was given', () => {
    // Forced through a quantity Excel's `General` cannot render in eleven
    // characters. The `.xls` source selects that renderer (ZEUS_FORMAT.md §3),
    // the written `toma` comes back rounded, and property 4 of the write-back
    // check fires: **a rounded count is a different count.**
    const counts = new Map([[XLS.items[0].idarticulo, 1234.56789012345]]);
    let thrown: unknown;
    try {
      writeAdjustment(XLS, counts, VERIFIED);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(PostingVerificationError);
    const error = thrown as PostingVerificationError;
    expect(error.mismatches.length).toBeGreaterThan(0);
    expect(error.mismatches[0]).toMatch(/toma salió en/);
    // The sentence the person in front of the screen reads, and it starts by
    // telling them not to upload anything.
    expect(error.message).toMatch(/^No subas nada a Zeus/);
  });

  it('re-emits every column it has no business touching, byte for byte', () => {
    // The property `verifyWriteBack` exists to keep true, asserted from outside
    // it as well: `writeAdjustment` runs the check, so a file that came back at
    // all is a file whose other 22 columns are unchanged.
    const written = writeAdjustment(TXT, new Map([[TXT.items[0].idarticulo, 3]]), VERIFIED);
    const back = parseTxt(written.bytes);
    for (const [index, item] of back.items.entries()) {
      const before = TXT.items[index].rawRow;
      for (let column = 0; column < before.length; column++) {
        if (column === 4 || column === 5) continue; // toma, diferencia
        expect(item.rawRow[column]).toBe(before[column]);
      }
    }
  });
});

describe('adjustmentFilename', () => {
  it('carries the bodega, the cutoff and the first eight of the digest', () => {
    // Zeus probably does not care. The person with four .txt files in a
    // Downloads folder at five o'clock does, and the prefix is what makes
    // «which one did I upload» a question with an answer.
    expect(adjustmentFilename('22', '2026/08/28', 'a1b2c3d4e5f6')).toBe(
      'AJUSTE_22_2026-08-28_a1b2c3d4.txt',
    );
  });

  it('never puts a path separator in a filename', () => {
    expect(adjustmentFilename('22', '2026/08/28', 'ff'.repeat(32))).not.toContain('/');
  });
});
