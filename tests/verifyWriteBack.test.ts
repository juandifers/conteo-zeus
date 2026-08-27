/**
 * The write-back check (src/app/verifyWriteBack.ts).
 *
 * Every test here is a way the file could carry the wrong numbers against the
 * right-looking articles. The one that matters most is `rebuilt from the domain
 * Item` — that is not a hypothetical, it is the obvious refactor for anyone who
 * opens `writeTxt` without reading its header, and it is the failure this whole
 * function exists to make impossible to ship.
 */
import { describe, expect, it } from 'vitest';
import {
  PostingVerificationError,
  exportAdjustment,
  parseZeusBytes,
  verifyWriteBack,
} from '../src/app';
import { encodeCp850, formatExcelGeneral, parseTxt, writeTxt, ZEUS_COLUMNS } from '../src/zeus';
import type { ZeusFile, ZeusItem } from '../src/zeus';
import { SAMPLE_XLS, readSample } from './helpers';

const file = parseZeusBytes(readSample(SAMPLE_XLS));

/** A count for every row, so `uncountedPolicy: 'reject'` has nothing to reject. */
function everyRow(pick: (item: ZeusItem, index: number) => number): Map<number, number> {
  return new Map(file.items.map((item, index) => [item.idarticulo, pick(item, index)]));
}

const counts = everyRow((item, index) => (index % 3 === 0 ? item.existencia : index + 0.5));

/** Re-emit a set of rows as the bytes a .txt is. */
function bytesOf(rows: string[][]): Uint8Array {
  return encodeCp850(rows.map((row) => `${row.join('\t')}\r\n`).join(''));
}

/** The rows of a good export, ready to be broken one field at a time. */
function goodRows(
  options?: Parameters<typeof writeTxt>[2],
  map: Map<number, number> = counts,
): string[][] {
  return parseTxt(writeTxt(file, map, options)).items.map((item) => item.rawRow.slice());
}

const column = Object.fromEntries(ZEUS_COLUMNS.map((name, i) => [name, i])) as Record<
  (typeof ZEUS_COLUMNS)[number],
  number
>;

describe('a file that kept its promise', () => {
  it('passes on a real export of bodega 01, in toma mode', () => {
    expect(() => verifyWriteBack(file, writeTxt(file, counts), counts)).not.toThrow();
  });

  it('passes in conteo1 mode, where the write set is three columns wide', () => {
    const options = { countTargetColumn: 'conteo1' } as const;
    expect(() =>
      verifyWriteBack(file, writeTxt(file, counts, options), counts, options),
    ).not.toThrow();
  });

  it('passes under each uncounted policy, on a partial count', () => {
    const partial = new Map([[file.items[0].idarticulo, 3]]);
    for (const uncountedPolicy of ['existencia', 'zero'] as const) {
      const bytes = writeTxt(file, partial, { uncountedPolicy });
      expect(() => verifyWriteBack(file, bytes, partial, { uncountedPolicy })).not.toThrow();
    }
  });

  it('is reached by the real posting path', () => {
    // Not a mock: `exportAdjustment` calls it, so the guarantee is on the
    // tablet rather than in this file.
    expect(exportAdjustment.toString()).toContain('verifyWriteBack');
  });
});

describe('the refactor this exists to catch', () => {
  /**
   * Somebody rebuilds the row from the domain `Item` instead of `rawRow`.
   *
   * The domain deliberately keeps six of the twenty-four fields, so this
   * produces a file that parses, has 298 rows in the right order with the
   * right names and the right counts — and has lost `costo`, `lote`,
   * `clasificacion`, `serial`, the group columns and `costo2`. It is exactly
   * the shape of the shearing that made this app necessary, and nothing on
   * screen would have shown it.
   */
  it('rejects a row built from the domain Item rather than from rawRow', () => {
    const rebuilt = file.items.map((item) => {
      const row = new Array(ZEUS_COLUMNS.length).fill('');
      // The six fields src/domain/ actually holds, plus the ones the writer
      // owns. Everything else is what a domain Item does not know.
      row[column.codigo] = item.codigo;
      row[column.nombre] = item.nombre;
      row[column.presentacion] = item.presentacion;
      row[column.existencia] = formatExcelGeneral(item.existencia);
      row[column.idarticulo] = String(item.idarticulo);
      row[column.bodega] = item.bodega;
      row[column.fecha] = item.fecha;
      row[column.conteo1] = formatExcelGeneral(item.conteo1);
      row[column.toma] = formatExcelGeneral(counts.get(item.idarticulo)!);
      row[column.diferencia] = formatExcelGeneral(0);
      // The numeric fields still have to parse, or this would fail as a
      // malformed file rather than as a sheared one — a weaker finding.
      for (const name of ['costo', 'idconcepto', 'conteo2', 'conteo3', 'costo2'] as const) {
        row[column[name]] = '0';
      }
      return row;
    });

    const error = catchVerification(bytesOf(rebuilt));
    expect(error.message).toMatch(/^No subas nada a Zeus\./);
    // Every row, and the columns the domain threw away.
    expect(error.mismatches.length).toBeGreaterThan(298);
    const named = new Set(
      error.mismatches
        .map((line) => /columna (\w+):/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );
    expect(named).toContain('costo');
    expect(named).toContain('costo2');
    expect(named).toContain('lote');
    expect(named).toContain('clasificacion');
    // And not the ones the writer is allowed to touch.
    expect(named).not.toContain('toma');
    expect(named).not.toContain('diferencia');
  });

  /**
   * `ubicacion` is empty in Zeus today and ZEUS_FORMAT.md §2 records a plan to
   * populate it. `zona` is explicitly out of scope as item data — and this is
   * what stops it arriving there by accident.
   */
  it('rejects a zona written into the ubicacion column', () => {
    const rows = goodRows();
    for (const row of rows) row[column.ubicacion] = 'CAVA';
    const error = catchVerification(bytesOf(rows));
    expect(error.mismatches).toHaveLength(298);
    expect(error.mismatches[0]).toContain('columna ubicacion');
  });
});

describe('rows, order and keys', () => {
  it('rejects a file with a row missing', () => {
    const error = catchVerification(bytesOf(goodRows().slice(0, -1)));
    expect(error.mismatches).toEqual(['el archivo generado tiene 297 filas y el original 298']);
  });

  it('rejects a file sorted for readability', () => {
    const rows = goodRows().slice().sort((a, b) => a[column.nombre].localeCompare(b[column.nombre]));
    const error = catchVerification(bytesOf(rows));
    expect(error.mismatches.some((line) => /idarticulo \d+ donde el original tiene/.test(line))).toBe(
      true,
    );
  });

  it('says nothing else about a row whose article is wrong', () => {
    // One re-keyed row must not produce twenty-two column findings on top: the
    // columns are being compared against an article the row is not.
    const rows = goodRows();
    rows[5][column.idarticulo] = String(file.items[6].idarticulo);
    const error = catchVerification(bytesOf(rows));
    expect(error.mismatches).toHaveLength(1);
    expect(error.mismatches[0]).toMatch(/^fila 6: idarticulo/);
  });
});

describe('the numbers themselves', () => {
  it('rejects a count that did not land in the target column', () => {
    const rows = goodRows();
    rows[0][column.toma] = formatExcelGeneral(counts.get(file.items[0].idarticulo)! + 1);
    const error = catchVerification(bytesOf(rows));
    expect(error.mismatches).toHaveLength(1);
    expect(error.mismatches[0]).toMatch(/toma salió en .* y el conteo era/);
  });

  it('does not mind how a number is rendered, only what it is', () => {
    // `12` and `12.0` are the same count and a formatting change is not a
    // posting defect. Compared as numbers precisely so this is not a finding.
    const one = new Map(file.items.map((item) => [item.idarticulo, 12]));
    const rows = parseTxt(writeTxt(file, one)).items.map((item) => item.rawRow.slice());
    for (const row of rows) {
      row[column.toma] = '12.0';
      row[column.diferencia] = row[column.diferencia].replace(/^(-?\d+)$/, '$1.0');
    }
    expect(() => verifyWriteBack(file, bytesOf(rows), one)).not.toThrow();
  });

  it('rejects a count written to conteo1 while the options said toma', () => {
    // The mode mix-up: the count lands somewhere Zeus may not read, and the
    // column that decides the posting keeps the source value.
    const rows = goodRows();
    for (const [index, row] of rows.entries()) {
      row[column.conteo1] = row[column.toma];
      row[column.toma] = file.items[index].rawRow[column.toma];
    }
    const error = catchVerification(bytesOf(rows));
    // Both halves are reported: conteo1 moved, and toma no longer carries the count.
    expect(error.mismatches.some((line) => line.includes('columna conteo1'))).toBe(true);
    expect(error.mismatches.some((line) => line.includes('toma salió en'))).toBe(true);
  });

  it('holds conteo1 byte-identical in toma mode', () => {
    const rows = goodRows();
    rows[0][column.conteo1] = '999';
    const error = catchVerification(bytesOf(rows));
    expect(error.mismatches).toEqual([
      expect.stringContaining('columna conteo1'),
    ]);
  });

  it('lets conteo1 move in conteo1 mode, and holds toma to the neutral pair', () => {
    const options = { countTargetColumn: 'conteo1' } as const;
    const rows = goodRows(options);
    // conteo1 may move — it is the target. `toma` may not: §9 pins it to the
    // neutral pair on every row, and this is the only thing checking that.
    rows[0][column.conteo1] = formatExcelGeneral(counts.get(file.items[0].idarticulo)!);
    rows[0][column.toma] = '999';
    const error = catchVerification(bytesOf(rows), counts, options);
    expect(error.mismatches).toEqual([
      expect.stringContaining('en modo conteo1, toma salió en 999'),
    ]);
  });
});

describe('the uncounted rows', () => {
  const partial = new Map([[file.items[0].idarticulo, 3]]);

  it("rejects a row the 'existencia' policy left at something else", () => {
    const rows = goodRows({ uncountedPolicy: 'existencia' }, partial);
    rows[1][column.toma] = '0';
    const error = catchVerification(bytesOf(rows), partial, { uncountedPolicy: 'existencia' });
    expect(error.mismatches[0]).toMatch(/la política 'existencia' exige/);
  });

  it("rejects a row the 'zero' policy left at existencia", () => {
    const rows = goodRows({ uncountedPolicy: 'zero' }, partial);
    rows[1][column.toma] = rows[1][column.existencia];
    const error = catchVerification(bytesOf(rows), partial, { uncountedPolicy: 'zero' });
    expect(error.mismatches[0]).toMatch(/la política 'zero' exige 0/);
  });
});

describe('bytes that are not a file', () => {
  it('rejects output it cannot read back, rather than assuming it is fine', () => {
    const error = catchVerification(encodeCp850('no soy un archivo de Zeus\r\n'));
    expect(error.mismatches[0]).toMatch(/no se pueden volver a leer/);
  });
});

/** Run the check, require it to fail, and hand back the error. */
function catchVerification(
  bytes: Uint8Array,
  map: ReadonlyMap<number, number> = counts,
  options?: Parameters<typeof verifyWriteBack>[3],
): PostingVerificationError {
  let thrown: unknown;
  try {
    verifyWriteBack(file as ZeusFile, bytes, map, options);
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown, 'expected the write-back check to reject these bytes').toBeInstanceOf(
    PostingVerificationError,
  );
  return thrown as PostingVerificationError;
}
