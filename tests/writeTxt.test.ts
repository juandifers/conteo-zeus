import { describe, it, expect } from 'vitest';
import { parseTxt } from '../src/zeus/parseTxt';
import { parseXls } from '../src/zeus/parseXls';
import { writeTxt } from '../src/zeus/writeTxt';
import { reencode } from '../src/zeus/reencode';
import { ZEUS_COLUMNS, type ZeusFile } from '../src/zeus/types';
import { SAMPLE_TXT, SAMPLE_XLS, readSample } from './helpers';

const txtFile = parseTxt(readSample(SAMPLE_TXT));
const xlsFile = parseXls(readSample(SAMPLE_XLS));

/** Field-level diff between a source file and an emitted one, as T3 requires. */
function fieldDiff(before: ZeusFile, emitted: Uint8Array) {
  const after = parseTxt(emitted);
  expect(after.items.length).toBe(before.items.length);
  const changes: { idarticulo: number; field: string; from: string; to: string }[] = [];
  for (let i = 0; i < before.items.length; i++) {
    expect(after.items[i].idarticulo).toBe(before.items[i].idarticulo);
    for (let c = 0; c < ZEUS_COLUMNS.length; c++) {
      if (before.items[i].rawRow[c] !== after.items[i].rawRow[c]) {
        changes.push({
          idarticulo: before.items[i].idarticulo,
          field: ZEUS_COLUMNS[c],
          from: before.items[i].rawRow[c],
          to: after.items[i].rawRow[c],
        });
      }
    }
  }
  return changes;
}

describe('T3 — count application (§8)', () => {
  // Run against the .xls: §9 says it pre-fills toma with existencia in all 298
  // rows, so 'existencia' for the uncounted rows is a genuine no-op and "differs
  // nowhere else" is testable. The .txt cannot satisfy T3 — 206 of its rows sit
  // at toma = 0, so any uncounted policy necessarily rewrites them.
  const counts = new Map<number, number>([
    [41, 30], // existencia 20.8 -> up
    [42, 12.5], // fractional
    [44, xlsFile.items.find((i) => i.idarticulo === 44)!.existencia], // no variance
  ]);
  const emitted = writeTxt(xlsFile, counts, { uncountedPolicy: 'existencia' });
  const changes = fieldDiff(xlsFile, emitted);

  it('changes exactly toma and diferencia, and only on counted rows', () => {
    expect([...new Set(changes.map((c) => c.field))].sort()).toEqual(['diferencia', 'toma']);
    expect([...new Set(changes.map((c) => c.idarticulo))].sort((a, b) => a - b)).toEqual([41, 42]);
    // idarticulo 44 was counted at exactly its existencia, so nothing changed.
  });

  it('writes the count into toma and the computed variance into diferencia', () => {
    const byId = new Map(parseTxt(emitted).items.map((i) => [i.idarticulo, i]));
    expect(byId.get(41)!.toma).toBe(30);
    expect(byId.get(41)!.diferencia).toBe(9.2); // 30 - 20.8, decimal (§3)
    expect(byId.get(42)!.toma).toBe(12.5);
    expect(byId.get(42)!.diferencia).toBe(12.5 - 67);
    expect(byId.get(44)!.diferencia).toBe(0);
  });

  it('leaves every uncounted row byte-identical when the source pre-fills toma', () => {
    const before = new TextDecoder('latin1').decode(writeTxt(xlsFile, new Map(), { uncountedPolicy: 'existencia' })).split('\r\n');
    const after = new TextDecoder('latin1').decode(emitted).split('\r\n');
    for (let i = 0; i < xlsFile.items.length; i++) {
      if (!counts.has(xlsFile.items[i].idarticulo)) expect(after[i], `row ${i + 1}`).toBe(before[i]);
    }
  });

  it('still ends every row with CRLF, including the last', () => {
    expect(emitted[emitted.length - 2]).toBe(0x0d);
    expect(emitted[emitted.length - 1]).toBe(0x0a);
  });
});

describe('T5 — uncounted policy (§8, §9)', () => {
  it("'reject' is the default and throws when any item lacks a count", () => {
    expect(() => writeTxt(txtFile)).toThrowError(/have no count/);
    expect(() => writeTxt(txtFile, new Map())).toThrowError(/§9/);
  });

  it('the error names the missing idarticulos, capped, with the full count', () => {
    let message = '';
    try {
      writeTxt(txtFile, new Map([[41, 1]]));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('297 of 298 items have no count');
    expect(message).toMatch(/Uncounted idarticulo: 42, 44,/);
    expect(message).toContain('(+277 more)'); // 297 listed - 20 shown
    expect(message).not.toContain('undefined');
    // Names the way out.
    expect(message).toContain("uncountedPolicy: 'existencia'");
    // The cap keeps the message readable.
    expect(message.length).toBeLessThan(600);
  });

  it('does not throw when every item is counted', () => {
    const all = new Map(txtFile.items.map((i) => [i.idarticulo, i.toma]));
    expect(() => writeTxt(txtFile, all)).not.toThrow();
  });

  it("'existencia' writes toma = existencia and diferencia = 0", () => {
    const out = parseTxt(writeTxt(txtFile, new Map(), { uncountedPolicy: 'existencia' }));
    expect(out.items.every((i, n) => i.toma === txtFile.items[n].existencia)).toBe(true);
    expect(out.items.every((i) => i.diferencia === 0)).toBe(true);
  });

  it("'zero' writes toma = 0 and the honest negative variance", () => {
    const out = parseTxt(writeTxt(txtFile, new Map(), { uncountedPolicy: 'zero' }));
    expect(out.items.every((i) => i.toma === 0)).toBe(true);
    expect(out.items.every((i, n) => i.diferencia === -txtFile.items[n].existencia)).toBe(true);
  });

  it('never emits toma implicitly: the three policies disagree on this file (§9)', () => {
    // The whole point of §9 — the same source yields three different toma
    // columns, so there is no safe default to fall back on.
    const asExistencia = parseTxt(writeTxt(txtFile, new Map(), { uncountedPolicy: 'existencia' }));
    const asZero = parseTxt(writeTxt(txtFile, new Map(), { uncountedPolicy: 'zero' }));
    const differing = asExistencia.items.filter((i, n) => i.toma !== asZero.items[n].toma);
    // They agree only where existencia is already 0 — 31 of the 298 rows.
    const nonZero = txtFile.items.filter((i) => i.existencia !== 0).length;
    expect(differing.length).toBe(nonZero);
    expect(nonZero).toBe(267);
  });

  it('the policy applies to uncounted rows only', () => {
    const out = parseTxt(writeTxt(txtFile, new Map([[41, 7]]), { uncountedPolicy: 'zero' }));
    expect(out.items.find((i) => i.idarticulo === 41)!.toma).toBe(7);
    expect(out.items.find((i) => i.idarticulo === 42)!.toma).toBe(0);
  });
});

describe('countTargetColumn (§7.1)', () => {
  const counts = new Map<number, number>([[41, 30]]);

  it("defaults to 'toma' and recomputes diferencia", () => {
    const changes = fieldDiff(xlsFile, writeTxt(xlsFile, counts, { uncountedPolicy: 'existencia' }));
    expect(new Set(changes.map((c) => c.field))).toEqual(new Set(['toma', 'diferencia']));
  });

  it('is a real mode, not a round-trip trick: counts land in conteo1 and only there', () => {
    // This mode used to stand in for T1. T1 now rides on reencode (§8), so what
    // matters here is only that the mode itself behaves.
    const emitted = writeTxt(
      xlsFile,
      new Map([
        [41, 5],
        [42, 6.5],
      ]),
      { countTargetColumn: 'conteo1', uncountedPolicy: 'existencia' },
    );
    const back = parseTxt(emitted);
    expect(back.items.find((i) => i.idarticulo === 41)!.conteo1).toBe(5);
    expect(back.items.find((i) => i.idarticulo === 42)!.conteo1).toBe(6.5);
    const changes = fieldDiff(xlsFile, emitted);
    expect(new Set(changes.map((c) => c.field))).toEqual(new Set(['conteo1']));
    expect(new Set(changes.map((c) => c.idarticulo))).toEqual(new Set([41, 42]));
  });

  it('§9 takes precedence over §7.1: uncounted rows are still governed by the policy', () => {
    // Otherwise the protection would be bypassable by switching target column.
    expect(() => writeTxt(xlsFile, new Map([[41, 5]]), { countTargetColumn: 'conteo1' })).toThrowError(
      /have no count/,
    );
    const out = parseTxt(
      writeTxt(txtFile, new Map([[41, 5]]), {
        countTargetColumn: 'conteo1',
        uncountedPolicy: 'existencia',
      }),
    );
    // Both rows — counted and uncounted alike — get the neutral no-change pair.
    for (const idarticulo of [41, 42]) {
      const row = out.items.find((i) => i.idarticulo === idarticulo)!;
      const before = txtFile.items.find((i) => i.idarticulo === idarticulo)!;
      expect(row.toma).toBe(before.existencia);
      expect(row.diferencia).toBe(0);
    }
    // §7.1 still holds in its scoped sense: the count did not go to toma.
    expect(out.items.find((i) => i.idarticulo === 41)!.conteo1).toBe(5);
    expect(out.items.find((i) => i.idarticulo === 41)!.toma).not.toBe(5);
  });

  it("writes conteo1 and does not put the count in toma (§7.1, scoped)", () => {
    const emitted = writeTxt(xlsFile, counts, {
      countTargetColumn: 'conteo1',
      uncountedPolicy: 'existencia',
    });
    const changes = fieldDiff(xlsFile, emitted);
    // Only conteo1 moves. §9 rewrites toma/diferencia here too, but the .xls
    // already holds toma == existencia and diferencia == 0, so that is a no-op
    // against this source — which is exactly why it is safe.
    expect(new Set(changes.map((c) => c.field))).toEqual(new Set(['conteo1']));
    expect(xlsFile.items.every((i) => i.toma === i.existencia && i.diferencia === 0)).toBe(true);

    const row = parseTxt(emitted).items.find((i) => i.idarticulo === 41)!;
    const before = xlsFile.items.find((i) => i.idarticulo === 41)!;
    expect(row.conteo1).toBe(30);
    expect(row.toma).toBe(before.existencia);
    expect(row.diferencia).toBe(0);
  });
});

describe('numberFormat defaults by source (§3)', () => {
  it("defaults to 'excelGeneral' for an .xls source", () => {
    // 1/3 has no 11-character form; the cap must bite.
    const out = parseTxt(writeTxt(xlsFile, new Map([[41, 1 / 3]]), { uncountedPolicy: 'existencia' }));
    expect(out.items.find((i) => i.idarticulo === 41)!.rawRow[4]).toBe('0.333333333');
  });

  it("defaults to 'shortest' for a .txt source", () => {
    const counts = new Map(txtFile.items.map((i) => [i.idarticulo, i.toma]));
    counts.set(41, 1 / 3);
    const out = parseTxt(writeTxt(txtFile, counts));
    expect(out.items.find((i) => i.idarticulo === 41)!.rawRow[4]).toBe('0.3333333333333333');
  });

  it('honours an explicit override in both directions', () => {
    const xlsShortest = parseTxt(
      writeTxt(xlsFile, new Map([[41, 1 / 3]]), {
        uncountedPolicy: 'existencia',
        numberFormat: 'shortest',
      }),
    );
    expect(xlsShortest.items.find((i) => i.idarticulo === 41)!.rawRow[4]).toBe('0.3333333333333333');

    const counts = new Map(txtFile.items.map((i) => [i.idarticulo, i.toma]));
    counts.set(41, 1 / 3);
    const txtGeneral = parseTxt(writeTxt(txtFile, counts, { numberFormat: 'excelGeneral' }));
    expect(txtGeneral.items.find((i) => i.idarticulo === 41)!.rawRow[4]).toBe('0.333333333');
  });
});

describe('writeTxt validation', () => {
  it('refuses a count for an idarticulo that is not in the file', () => {
    expect(() => writeTxt(txtFile, new Map([[999999, 1]]))).toThrowError(
      /count supplied for idarticulo 999999, which is not in this file/,
    );
  });

  it('refuses a row whose rawRow is the wrong width', () => {
    const broken: ZeusFile = {
      ...txtFile,
      items: [{ ...txtFile.items[0], rawRow: txtFile.items[0].rawRow.slice(0, 23) }],
    };
    expect(() => writeTxt(broken)).toThrowError(/rawRow holds 23 fields, expected 24/);
  });

  it('refuses duplicate idarticulo (§4)', () => {
    const dupe: ZeusFile = { ...txtFile, items: [txtFile.items[0], txtFile.items[0]] };
    expect(() => writeTxt(dupe)).toThrowError(/appears more than once/);
  });
});


describe('differenceColumn (§7.2)', () => {
  const counts = new Map<number, number>([[41, 30]]); // existencia 20.8

  it("defaults to 'computed'", () => {
    const out = parseTxt(writeTxt(xlsFile, counts, { uncountedPolicy: 'existencia' }));
    expect(out.items.find((i) => i.idarticulo === 41)!.diferencia).toBe(9.2);
  });

  it("'zero' writes a flat 0 on counted rows, leaving toma correct", () => {
    const out = parseTxt(
      writeTxt(xlsFile, counts, { uncountedPolicy: 'existencia', differenceColumn: 'zero' }),
    );
    const row = out.items.find((i) => i.idarticulo === 41)!;
    expect(row.toma).toBe(30);
    expect(row.diferencia).toBe(0);
    expect(row.rawRow[5]).toBe('0');
  });

  it("'zero' also flattens the uncounted 'zero' policy's variance", () => {
    const computed = parseTxt(writeTxt(txtFile, new Map(), { uncountedPolicy: 'zero' }));
    expect(computed.items.every((i, n) => i.diferencia === -txtFile.items[n].existencia)).toBe(true);

    const flat = parseTxt(
      writeTxt(txtFile, new Map(), { uncountedPolicy: 'zero', differenceColumn: 'zero' }),
    );
    expect(flat.items.every((i) => i.toma === 0)).toBe(true);
    expect(flat.items.every((i) => i.diferencia === 0)).toBe(true);
  });

  it("does not affect 'existencia', whose variance is 0 either way (§9)", () => {
    const a = writeTxt(txtFile, new Map(), { uncountedPolicy: 'existencia' });
    const b = writeTxt(txtFile, new Map(), {
      uncountedPolicy: 'existencia',
      differenceColumn: 'zero',
    });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('leaves diferencia untouched on the conteo1 path under either setting (§7.1)', () => {
    for (const differenceColumn of ['computed', 'zero'] as const) {
      const changes = fieldDiff(
        xlsFile,
        writeTxt(xlsFile, counts, {
          countTargetColumn: 'conteo1',
          uncountedPolicy: 'existencia',
          differenceColumn,
        }),
      );
      expect(new Set(changes.map((c) => c.field))).toEqual(new Set(['conteo1']));
    }
  });
});

describe('writeTxt has no identity path (§8, §9)', () => {
  it('the library default refuses to emit anything at all', () => {
    expect(() => writeTxt(txtFile)).toThrowError(/have no count/);
    expect(() => writeTxt(xlsFile)).toThrowError(/have no count/);
  });

  it('no option combination re-emits the zero-defaulted .txt verbatim', () => {
    // The dangerous source: 206 uncounted rows encoded as 0. If any option
    // pairing reproduced it byte-for-byte without the caller naming counts,
    // §9's protection would be reachable around.
    const verbatim = Array.from(reencode(txtFile));
    for (const uncountedPolicy of ['existencia', 'zero'] as const) {
      for (const differenceColumn of ['computed', 'zero'] as const) {
        for (const countTargetColumn of ['toma', 'conteo1'] as const) {
          const out = Array.from(
            writeTxt(txtFile, new Map(), { uncountedPolicy, differenceColumn, countTargetColumn }),
          );
          expect(
            out,
            `${uncountedPolicy}/${differenceColumn}/${countTargetColumn} reproduced the source`,
          ).not.toEqual(verbatim);
        }
      }
    }
  });

  it('every row is resolved by an explicit count or an explicitly named policy', () => {
    // Byte-identical output IS reachable — but only when the caller has
    // explicitly resolved all 298 rows and their input happens to coincide with
    // the source. That is an assertion, not a pass-through.
    const all = new Map(txtFile.items.map((i) => [i.idarticulo, i.toma]));
    const coincides = writeTxt(txtFile, all, { differenceColumn: 'zero' });
    expect(Array.from(coincides)).toEqual(Array.from(reencode(txtFile)));

    // Drop a single count and the same call refuses to produce a file.
    all.delete(41);
    expect(() => writeTxt(txtFile, all, { differenceColumn: 'zero' })).toThrowError(
      /1 of 298 items have no count/,
    );
  });

  it('byte-identical output is reachable only by explicitly resolving all 298 rows', () => {
    const verbatim = Array.from(reencode(txtFile));

    // (a) toma target, counts = source toma, §7.2 flipped to 'zero'.
    const viaToma = new Map(txtFile.items.map((i) => [i.idarticulo, i.toma]));
    expect(Array.from(writeTxt(txtFile, viaToma, { differenceColumn: 'zero' }))).toEqual(verbatim);

    // (b) The conteo1 route is now closed by §9: it rewrites toma on every row,
    // so it can no longer reproduce a zero-defaulted source at all.
    const viaConteo1 = new Map(txtFile.items.map((i) => [i.idarticulo, i.conteo1]));
    expect(
      Array.from(writeTxt(txtFile, viaConteo1, { countTargetColumn: 'conteo1' })),
    ).not.toEqual(verbatim);

    // The one remaining route required all 298 counts.
    const short = new Map(viaToma);
    short.delete(41);
    expect(() => writeTxt(txtFile, short, { differenceColumn: 'zero' })).toThrow();
  });

  it('conteo1 mode resolves toma on every row, so the zero-defaulted .txt cannot leak (§9)', () => {
    // Previously a residual gap: §7.1 was read as "re-emit the source toma",
    // which posted the .txt's 206 uncounted zeros in the column §7.1 says Zeus
    // most likely reads. §9 now resolves toma on every row in this mode.
    const counts = new Map(txtFile.items.map((i) => [i.idarticulo, i.conteo1]));
    const out = parseTxt(writeTxt(txtFile, counts, { countTargetColumn: 'conteo1' }));

    // Not one of the source's 206 zeros survives.
    expect(txtFile.items.filter((i) => i.toma === 0)).toHaveLength(206);
    expect(out.items.every((i, n) => i.toma === txtFile.items[n].existencia)).toBe(true);
    expect(out.items.every((i) => i.diferencia === 0)).toBe(true);
    // The counts still went where they were asked to go.
    expect(out.items.every((i, n) => i.conteo1 === txtFile.items[n].conteo1)).toBe(true);
  });

  it('holds for uncounted rows in conteo1 mode under either policy (§9 precedence)', () => {
    for (const uncountedPolicy of ['existencia', 'zero'] as const) {
      const out = parseTxt(
        writeTxt(txtFile, new Map([[41, 5]]), { countTargetColumn: 'conteo1', uncountedPolicy }),
      );
      expect(out.items.every((i, n) => i.toma === txtFile.items[n].existencia)).toBe(true);
      expect(out.items.every((i) => i.diferencia === 0)).toBe(true);
    }
  });

  it('never writes to Grupo1..5 (§2)', () => {
    const emitted = parseTxt(writeTxt(txtFile, new Map([[41, 9]]), { uncountedPolicy: 'zero' }));
    for (const item of emitted.items) {
      expect(item.rawRow.slice(18, 23)).toEqual(['', '', '', '', '']);
    }
  });
});


describe('no source toma is ever passed through (§9 sweep)', () => {
  // Structural check rather than a value check: poison the source toma column
  // with a sentinel no legitimate computation can produce, then sweep every
  // option pairing. A sentinel in the output means the writer copied rawRow.
  const SENTINEL = 987654321;
  const poisoned: ZeusFile = {
    ...txtFile,
    items: txtFile.items.map((item) => ({
      ...item,
      toma: SENTINEL,
      rawRow: item.rawRow.map((field, i) => (i === 4 ? String(SENTINEL) : field)),
    })),
  };

  const pairings = (['toma', 'conteo1'] as const).flatMap((countTargetColumn) =>
    (['existencia', 'zero'] as const).flatMap((uncountedPolicy) =>
      (['computed', 'zero'] as const).map((differenceColumn) => ({
        countTargetColumn,
        uncountedPolicy,
        differenceColumn,
      })),
    ),
  );

  it('sweeps all 8 option pairings with no counts', () => {
    expect(pairings).toHaveLength(8);
    for (const options of pairings) {
      const out = parseTxt(writeTxt(poisoned, new Map(), options));
      expect(out.items.some((i) => i.toma === SENTINEL), JSON.stringify(options)).toBe(false);
      expect(out.items.every((i) => i.rawRow[4] !== String(SENTINEL))).toBe(true);
    }
  });

  it('sweeps all 8 pairings with a partial count map, the mixed case', () => {
    const partial = new Map(poisoned.items.slice(0, 100).map((i) => [i.idarticulo, 3.5]));
    for (const options of pairings) {
      const out = parseTxt(writeTxt(poisoned, partial, options));
      expect(out.items.some((i) => i.toma === SENTINEL), JSON.stringify(options)).toBe(false);
    }
  });

  it('sweeps all 8 pairings with every row counted', () => {
    const all = new Map(poisoned.items.map((i) => [i.idarticulo, 3.5]));
    for (const options of pairings) {
      const out = parseTxt(writeTxt(poisoned, all, options));
      expect(out.items.some((i) => i.toma === SENTINEL), JSON.stringify(options)).toBe(false);
    }
  });

  it("'reject' emits nothing at all, poisoned or not", () => {
    for (const countTargetColumn of ['toma', 'conteo1'] as const) {
      expect(() => writeTxt(poisoned, new Map(), { countTargetColumn })).toThrowError(
        /have no count/,
      );
    }
  });

  it('reencode DOES pass it through — which is why it is not a posting path (§8)', () => {
    // The contrast that gives the sweep its meaning.
    expect(parseTxt(reencode(poisoned)).items.every((i) => i.toma === SENTINEL)).toBe(true);
  });
});
