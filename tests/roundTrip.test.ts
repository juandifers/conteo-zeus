import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { parseTxt } from '../src/zeus/parseTxt';
import { writeTxt } from '../src/zeus/writeTxt';
import { reencode } from '../src/zeus/reencode';
import { formatNumber, formatExcelGeneral } from '../src/zeus/formatNumber';
import { ZEUS_COLUMNS } from '../src/zeus/types';
import { SAMPLE_TXT, SAMPLE_XLS, readSample, firstDifference } from './helpers';

const source = readSample(SAMPLE_TXT);
const file = parseTxt(source);

/** Which fields changed, and in how many rows. */
function changedFields(emitted: Uint8Array): Map<string, number> {
  const back = parseTxt(emitted);
  expect(back.items.length).toBe(file.items.length);
  const changed = new Map<string, number>();
  for (let i = 0; i < file.items.length; i++) {
    expect(back.items[i].idarticulo).toBe(file.items[i].idarticulo);
    for (let c = 0; c < ZEUS_COLUMNS.length; c++) {
      if (file.items[i].rawRow[c] !== back.items[i].rawRow[c]) {
        changed.set(ZEUS_COLUMNS[c], (changed.get(ZEUS_COLUMNS[c]) ?? 0) + 1);
      }
    }
  }
  return changed;
}

describe('T1 — parse fidelity (§8)', () => {
  it('reencode(parseTxt(bytes)) reproduces the source byte for byte', () => {
    const emitted = reencode(parseTxt(source));
    const diff = firstDifference(emitted, source);
    expect(diff, diff ?? undefined).toBeNull();
    expect(emitted.length).toBe(source.length);
  });

  it('round-trips the CRLF terminator and the CP850 bytes exactly', () => {
    const emitted = reencode(file);
    expect(emitted[emitted.length - 2]).toBe(0x0d);
    expect(emitted[emitted.length - 1]).toBe(0x0a);
    // The three non-ASCII bytes of §3 survive as single bytes.
    for (const byte of [0xa5, 0xd6, 0xe0]) expect(emitted.includes(byte)).toBe(true);
    expect(emitted.includes(0xc3)).toBe(false); // no UTF-8 lead bytes
  });

  it('is not a posting path: it takes no counts and applies no policy (§8)', () => {
    expect(reencode).toHaveLength(1); // (file) only
    // Verbatim re-emission of a zero-defaulted .txt — exactly what writeTxt
    // refuses to do. 206 of these rows are uncounted zeros.
    expect(parseTxt(reencode(file)).items.filter((i) => i.toma === 0)).toHaveLength(206);
  });

  it('rejects a malformed rawRow rather than emitting a short row', () => {
    const broken = { ...file, items: [{ ...file.items[0], rawRow: file.items[0].rawRow.slice(0, 23) }] };
    expect(() => reencode(broken)).toThrowError(/rawRow holds 23 fields, expected 24/);
  });

  it('parses the file the spec describes: 298 rows, 24 fields, bodega 01, corte 2025/04/30', () => {
    expect(file.items).toHaveLength(298);
    expect(file.bodega).toBe('01');
    expect(file.fecha).toBe('2025/04/30');
    expect(file.source).toBe('txt');
    expect(file.items.every((i) => i.rawRow.length === 24)).toBe(true);
    expect(new Set(file.items.map((i) => i.idarticulo)).size).toBe(298);
    expect(new Set(file.items.map((i) => i.codigo)).size).toBe(232);
  });

  it('keeps zero-padded codigo and bodega as strings (§3)', () => {
    expect(file.items.every((i) => i.codigo.length === 7)).toBe(true);
    expect(file.items.every((i) => i.bodega === '01')).toBe(true);
    expect(file.items[0].codigo).toBe('0108001');
  });
});

describe('T6 — bounded divergence (§8, regression)', () => {
  it('counts taken from the source toma diverge ONLY in diferencia, on 255 rows', () => {
    // Not a defect: §7.2 requires the computed variance, but the sample carries
    // diferencia = 0 in all 298 rows while toma ≠ existencia in 255 of them.
    // The source file is internally inconsistent; the writer corrects it.
    const counts = new Map(file.items.map((item) => [item.idarticulo, item.toma]));
    const emitted = writeTxt(file, counts);
    expect(changedFields(emitted)).toEqual(new Map([['diferencia', 255]]));

    const diff = firstDifference(emitted, source);
    expect(diff).toContain('byte offset 46');
    expect(diff).toContain('row 1, field index 5');
    // Row 1: existencia 10, toma 0 -> the honest variance is -10, not 0.
    expect(parseTxt(emitted).items[0].diferencia).toBe(-10);
    expect(file.items[0].diferencia).toBe(0);
  });

  it("'existencia' with no counts confines divergence to toma, on the same 255 rows", () => {
    const emitted = writeTxt(file, new Map(), { uncountedPolicy: 'existencia' });
    expect(changedFields(emitted)).toEqual(new Map([['toma', 255]]));

    // The divergence set itself, not merely its existence: exactly the rows
    // where the source disagrees with itself.
    const back = parseTxt(emitted);
    const diverged = file.items.filter((item, i) => item.toma !== back.items[i].toma);
    expect(diverged.every((item) => item.toma !== item.existencia)).toBe(true);
    expect(diverged).toHaveLength(255);
  });
});

describe('T1b — formatter fidelity (§8)', () => {
  it('formatNumber(Number(text)) === text for every numeric field of all 298 rows', () => {
    const numericColumns = [3, 4, 5, 6, 11, 14, 15, 16, 17, 23];
    let checked = 0;
    for (const item of file.items) {
      for (const col of numericColumns) {
        const text = item.rawRow[col];
        expect(formatNumber(Number(text)), `idarticulo ${item.idarticulo} ${ZEUS_COLUMNS[col]}`).toBe(
          text,
        );
        checked++;
      }
    }
    expect(checked).toBe(2980);
  });
});

describe('T1c — Excel General fidelity (§8)', () => {
  it('formatExcelGeneral(Number(xlsCosto)) === txtCosto for all 298 rows', () => {
    const sheet = XLSX.read(readFileSync(SAMPLE_XLS), { type: 'buffer' }).Sheets.Datos;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
    const xlsCosto = rows.slice(1).map((row) => row[6] as number);

    expect(xlsCosto).toHaveLength(298);
    let exact = 0;
    for (let i = 0; i < 298; i++) {
      const expected = file.items[i].rawRow[6];
      expect(formatExcelGeneral(xlsCosto[i]), `row ${i + 1}`).toBe(expected);
      if (formatNumber(xlsCosto[i]) === expected) exact++;
    }
    // 54 of the 298 are only reachable via the 11-character cap (§3).
    expect(298 - exact).toBe(54);
  });

  it('costo2 is not subject to the cap (§2)', () => {
    const long = file.items.filter((i) => i.rawRow[23].length > 11);
    expect(long.length).toBeGreaterThan(0);
    expect(long[0].rawRow[23]).toBe(formatNumber(long[0].costo2));
  });
});

describe('parseTxt validation', () => {
  const row = (fields: number): string[] =>
    Array.from({ length: fields }, (_, i) => (i === 11 ? '1' : '0'));
  const bytes = (text: string) => new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));

  it('fails loudly when a row does not have exactly 24 fields', () => {
    expect(() => parseTxt(bytes(`${row(23).join('\t')}\r\n`))).toThrowError(
      /row 1: expected 24 fields, found 23/,
    );
    expect(() => parseTxt(bytes(`${row(24).join('\t')}\r\n${row(25).join('\t')}\r\n`))).toThrowError(
      /row 2: expected 24 fields, found 25/,
    );
  });

  it('rejects LF-only line endings and a missing trailing newline', () => {
    expect(() => parseTxt(bytes(`${row(24).join('\t')}\n`))).toThrowError(/CRLF/);
    expect(() => parseTxt(bytes(row(24).join('\t')))).toThrowError(/must end with CRLF/);
  });

  it('names the offending row and field when a number is malformed', () => {
    const bad = row(24);
    bad[6] = '1,5';
    expect(() => parseTxt(bytes(`${bad.join('\t')}\r\n`))).toThrowError(
      /row 1 field costo: "1,5" is not a valid Zeus number/,
    );
  });
});

describe('the T1 diagnostic', () => {
  it('reports the first differing offset with row, field and context', () => {
    const corrupted = Uint8Array.from(source);
    const offset = source.indexOf(0x38, 60);
    corrupted[offset] = 0x39;
    const diff = firstDifference(corrupted, source);
    expect(diff).toContain(`byte offset ${offset}`);
    expect(diff).toMatch(/row 1, field index \d+/);
    expect(diff).toContain('expected:');
    expect(diff).toContain('actual:');
  });

  it('reports a length mismatch even when the common prefix matches', () => {
    const truncated = source.slice(0, source.length - 2);
    const diff = firstDifference(truncated, source);
    expect(diff).toContain('<eof>');
    expect(diff).toContain(`lengths: actual ${source.length - 2}, expected ${source.length}`);
  });

  it('renders tabs and CRLF visibly rather than as invisible whitespace', () => {
    const corrupted = Uint8Array.from(source);
    corrupted[0] = 0x39;
    expect(firstDifference(corrupted, source)!).toContain('\\t');
  });
});
