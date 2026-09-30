/**
 * The numbers in a Zeus export check each other (src/app/fileChecks.ts).
 *
 * Every case here was *accepted* before, and posted wrong: found by the
 * pre-pilot failure-mode pass, which ran 108 edited variants of the two real
 * exports through the real importer. The genuine files must still import —
 * that is the first test, and the one that matters most.
 */
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { ArchivoAlteradoError, CatalogueError, importZeusBytes, parseZeusBytes } from '../src/app';
import { SAMPLE_XLS, readSample } from './helpers';
import { join } from 'node:path';

const VERIFIED_XLS = join(
  __dirname,
  '..',
  'samples',
  'golden',
  'zeus-verified',
  'LISTADO PRUEBA PPNS.xls',
);

/** The real bodega 01 export as a grid: header row, then 298 rows. */
function grid(): unknown[][] {
  const book = XLSX.read(readSample(SAMPLE_XLS), { type: 'array' });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) as unknown[][];
}

function bytesOf(rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Datos');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xls' }) as ArrayBuffer);
}

function column(rows: unknown[][], name: string): number {
  const at = (rows[0] as string[]).findIndex((h) => String(h).trim().toLowerCase() === name);
  if (at < 0) throw new Error(`no column ${name}`);
  return at;
}

/** Sort one column's values in place, leaving every other column where it was. */
function sortColumnAlone(rows: unknown[][], name: string, direction: 1 | -1 = 1): unknown[][] {
  const at = column(rows, name);
  const values = rows.slice(1).map((row) => row[at] as number).sort((a, b) => (a - b) * direction);
  return [rows[0], ...rows.slice(1).map((row, i) => row.map((cell, j) => (j === at ? values[i] : cell)))];
}

const refusal = (bytes: Uint8Array): string => {
  try {
    importZeusBytes(bytes);
  } catch (cause) {
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }
  return 'ACCEPTED';
};

describe('the genuine exports', () => {
  it('still import, both of them, and re-saved by a spreadsheet program', () => {
    expect(() => importZeusBytes(readSample(SAMPLE_XLS))).not.toThrow();
    expect(() => importZeusBytes(readSample(VERIFIED_XLS))).not.toThrow();
    expect(refusal(bytesOf(grid()))).toBe('ACCEPTED');
  });

  it('carry the redundancy the checks read, on every row', () => {
    for (const path of [SAMPLE_XLS, VERIFIED_XLS]) {
      const file = parseZeusBytes(readSample(path));
      for (const item of file.items) {
        expect(item.toma).toBe(item.existencia);
        expect(Math.abs(item.costo - item.costo2)).toBeLessThan(1e-4 * Math.max(1, item.costo2));
      }
    }
  });
});

describe('a column sorted on its own', () => {
  it('refuses «existencia» sorted alone — the file that posted HUEVOS A 10 080 as 0', () => {
    const message = refusal(bytesOf(sortColumnAlone(grid(), 'existencia')));
    expect(message).toMatch(/^ArchivoAlteradoError/);
    expect(message).toMatch(/«existencia» y «toma» tienen las mismas cifras pero en otro orden/);
    expect(message).toMatch(/sin abrirla ni ordenarla/);
  });

  it('refuses existencia and toma sorted together, which the pair cannot see', () => {
    const sorted = sortColumnAlone(sortColumnAlone(grid(), 'existencia', -1), 'toma', -1);
    expect(refusal(bytesOf(sorted))).toMatch(/«existencia» está en orden descendente/);
  });

  it('refuses «costo» sorted alone', () => {
    expect(refusal(bytesOf(sortColumnAlone(grid(), 'costo')))).toMatch(
      /«costo» y «costo2» tienen las mismas cifras pero en otro orden/,
    );
  });

  it('refuses names sorted Z to A as well as A to Z', () => {
    // A catalogue with no repeated codes or names, so only the order can tell.
    const rows = grid();
    const nombre = column(rows, 'nombre');
    const codigo = column(rows, 'codigo');
    const seenNames = new Set<string>();
    const seenCodes = new Set<string>();
    const unique = [rows[0]];
    for (const row of rows.slice(1)) {
      const n = String(row[nombre]);
      const c = String(row[codigo]);
      if (seenNames.has(n) || seenCodes.has(c)) continue;
      seenNames.add(n);
      seenCodes.add(c);
      unique.push(row);
    }
    const names = unique.slice(1).map((row) => String(row[nombre])).sort((a, b) => b.localeCompare(a, 'es'));
    const sheared = [unique[0], ...unique.slice(1).map((row, i) => row.map((cell, j) => (j === nombre ? names[i] : cell)))];
    const message = refusal(bytesOf(sheared));
    expect(message).toMatch(/^CatalogueError/);
    expect(message).toMatch(/columna de nombres va en orden alfabético/);
  });
});

describe('a row Zeus could never take back', () => {
  it('refuses a tab or line break inside a name at import, not after the seal', () => {
    for (const bad of ['PECHUGA\tDE POLLO', 'PECHUGA\nDE POLLO', 'PECHUGA\r\nDE POLLO']) {
      const rows = grid();
      rows[1][column(rows, 'nombre')] = bad;
      const message = refusal(bytesOf(rows));
      expect(message).toMatch(/tabulación o un salto de línea/);
      expect(message).toMatch(/idarticulo \d+/);
    }
  });
});

it('keeps the name-check message for a file the name checks already refuse', () => {
  // Order matters: the §4.1 message names the shear precisely, and a file both
  // checks would refuse keeps it.
  const rows = grid();
  const nombre = column(rows, 'nombre');
  const names = rows.slice(1).map((row) => String(row[nombre])).sort((a, b) => a.localeCompare(b, 'es'));
  const sheared = [rows[0], ...rows.slice(1).map((row, i) => row.map((cell, j) => (j === nombre ? names[i] : cell)))];
  expect(() => importZeusBytes(bytesOf(sheared))).toThrow(CatalogueError);
  expect(ArchivoAlteradoError).toBeDefined();
});

describe('what the admin reads when a file is refused', () => {
  it('says in Spanish what to upload instead, keeping the adapter’s words as detail', () => {
    const csv = new TextEncoder().encode('codigo,nombre,existencia\r\n0103005,PANCETA,97.5\r\n');
    const message = refusal(csv);
    expect(message).toMatch(/^ZeusLecturaError: Este archivo no es un \.xls/);
    expect(message).toMatch(/Sube el \.xls que exporta Zeus/);
    expect(message).toMatch(/Detalle técnico: /);

    const rows = grid();
    rows.splice(0, 0, ['LISTADO DE TOMA FÍSICA — BODEGA 01']);
    expect(refusal(bytesOf(rows))).toMatch(/filas de título encima/);

    const commas = grid();
    commas[1][column(commas, 'existencia')] = '20,8';
    expect(refusal(bytesOf(commas))).toMatch(/La fila \d+ tiene en «existencia» un valor que Zeus no escribe así/);
  });

  it('names the article when a character cannot go back to Zeus', () => {
    const rows = grid();
    rows[1][column(rows, 'nombre')] = 'PECHUGA DE POLLO “PREMIUM”';
    const message = refusal(bytesOf(rows));
    expect(message).toMatch(/idarticulo \d+\) tiene en el nombre el carácter «“»/);
    expect(message).not.toMatch(/Cannot encode/);
  });
});
