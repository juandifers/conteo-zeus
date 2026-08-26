import { describe, it, expect } from 'vitest';
import { parseTxt } from '../src/zeus/parseTxt';
import { parseXls } from '../src/zeus/parseXls';
import { SAMPLE_TXT, SAMPLE_XLS, readSample } from './helpers';

const xls = parseXls(readSample(SAMPLE_XLS));
const txt = parseTxt(readSample(SAMPLE_TXT));

describe('T2 — Excel import fidelity (§8)', () => {
  it('produces 298 items', () => {
    expect(xls.items).toHaveLength(298);
    expect(xls.source).toBe('xls');
    expect(xls.bodega).toBe('01');
    expect(xls.fecha).toBe('2025/04/30');
  });

  it('matches the .txt row-for-row on the columns the §5 defect does not touch', () => {
    const fields = [
      'codigo',
      'idarticulo',
      'costo',
      'costo2',
      'conteo1',
      'conteo2',
      'conteo3',
      'bodega',
      'fecha',
      'idconcepto',
    ] as const;
    expect(xls.items.length).toBe(txt.items.length);
    for (let i = 0; i < xls.items.length; i++) {
      for (const field of fields) {
        expect(xls.items[i][field], `row ${i + 1} field ${field}`).toEqual(txt.items[i][field]);
      }
    }
  });

  it('takes nombre / presentacion / existencia / toma from the Excel (§5, §8)', () => {
    // §5: the .txt interleaves two row orderings; this block is the one sorted
    // alphabetically by nombre, so it belongs to different rows entirely.
    expect(xls.items[0].nombre).toBe('PECHUGA DE POLLO');
    expect(xls.items[0].presentacion).toBe('KILO');
    expect(xls.items[0].existencia).toBe(20.8);
    expect(xls.items[0].toma).toBe(20.8);
    expect(txt.items[0].nombre).not.toBe(xls.items[0].nombre);
    expect(txt.items[0].toma).not.toBe(xls.items[0].toma);
  });

  it('the .xls pre-fills toma with existencia in all 298 rows (§9)', () => {
    // This is why an untouched .xls row means "no change", while an untouched
    // .txt row can mean "counted as zero".
    expect(xls.items.every((item) => item.toma === item.existencia)).toBe(true);
    expect(xls.items.every((item) => item.diferencia === 0)).toBe(true);
    // The .txt carries the opposite default.
    expect(txt.items.filter((item) => item.toma === 0)).toHaveLength(206);
  });

  it('§5: nombre/presentacion/existencia are a permutation of the .xls triples', () => {
    const key = (i: { nombre: string; presentacion: string; existencia: number }) =>
      `${i.nombre}|${i.presentacion}|${i.existencia}`;
    const fromXls = new Set(xls.items.map(key));
    expect(txt.items.filter((i) => fromXls.has(key(i)))).toHaveLength(298);
  });

  it('§5: toma in the .txt exists nowhere in the .xls', () => {
    const multiset = (values: number[]) => values.slice().sort((a, b) => a - b).join(',');
    expect(multiset(txt.items.map((i) => i.toma))).not.toBe(multiset(xls.items.map((i) => i.toma)));
    expect(multiset(txt.items.map((i) => i.toma))).not.toBe(
      multiset(xls.items.map((i) => i.conteo1)),
    );
  });

  it('drops the 25th column (Observacion) — §2', () => {
    expect(xls.items.every((item) => item.rawRow.length === 24)).toBe(true);
    expect(Object.keys(xls.items[0])).not.toContain('Observacion');
  });

  it('keeps the zero-padding on codigo and bodega', () => {
    expect(xls.items.every((item) => item.codigo.length === 7)).toBe(true);
    expect(xls.items[0].codigo).toBe('0108001');
    expect(xls.items.every((item) => item.bodega === '01')).toBe(true);
    // Never parsed to a number and re-serialised.
    expect(xls.items.map((i) => i.codigo)).toContain('0103005');
  });

  it('reads the fecha serial back as YYYY/MM/DD', () => {
    expect(xls.items.every((item) => item.fecha === '2025/04/30')).toBe(true);
  });
});

describe('§4 invariant — nombre is stable per codigo', () => {
  const conflicts = (items: { codigo: string; nombre: string }[]) => {
    const byCode = new Map<string, Set<string>>();
    for (const { codigo, nombre } of items) {
      if (!byCode.has(codigo)) byCode.set(codigo, new Set());
      byCode.get(codigo)!.add(nombre);
    }
    return [...byCode.entries()].filter(([, names]) => names.size > 1);
  };

  it('zero codigo values have more than one distinct nombre in the .xls', () => {
    // This is the check that would have caught the §5 defect.
    const bad = conflicts(xls.items);
    expect(bad.map(([code]) => code)).toEqual([]);
    expect(new Set(xls.items.map((i) => i.codigo)).size).toBe(232);
  });

  it('the same check flags the scrambled .txt, as §5 predicts', () => {
    expect(conflicts(txt.items)).toHaveLength(43);
  });

  it('codigo is not unique but idarticulo is (§4)', () => {
    expect(new Set(xls.items.map((i) => i.idarticulo)).size).toBe(298);
    const presentations = xls.items.filter((i) => i.codigo === '0103005');
    expect(presentations.length).toBeGreaterThan(1);
    expect(new Set(presentations.map((i) => i.nombre)).size).toBe(1);
  });
});


describe('T7 — collation (§8, §5)', () => {
  const names = txt.items.map((i) => i.nombre);

  it("the .txt nombre column is ordered under localeCompare(…, 'es'), 0 of 298 out of place", () => {
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'es'));
    const outOfPlace = names.filter((name, i) => name !== sorted[i]);
    expect(outOfPlace).toHaveLength(0);
    expect(names).toEqual(sorted);
  });

  it('code-unit order disagrees on 295 of 298, which is the point (§5)', () => {
    // Matching Excel's collation and not code-unit order is the evidence that
    // the block was pasted from a separately-sorted Excel export rather than
    // produced programmatically.
    const codeUnit = [...names].sort();
    expect(names.filter((name, i) => name !== codeUnit[i])).toHaveLength(295);
  });

  it('the | anomaly leads the file under that collation and is read faithfully', () => {
    // Three rows, all three presentations of one product — §5 reads this as a
    // deliberate annotation, not a paste artifact. The parser does not strip it.
    const flagged = txt.items.filter((i) => i.nombre.startsWith('|'));
    expect(flagged).toHaveLength(3);
    expect(new Set(flagged.map((i) => i.nombre))).toEqual(new Set(['|MIEL MAPLE SYRUP']));
    expect(new Set(flagged.map((i) => i.presentacion)).size).toBe(3);
    expect(names.slice(0, 3).every((n) => n.startsWith('|'))).toBe(true);
    expect(names[names.length - 1]).toBe('ZUMO DE LIMON');
    // '|' (0x7C) sorts after 'Z' by code unit, which is why the naive check fails.
    expect('|'.charCodeAt(0)).toBeGreaterThan('Z'.charCodeAt(0));
  });
});
