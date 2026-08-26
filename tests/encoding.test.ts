import { describe, it, expect } from 'vitest';
import { decodeCp850, encodeCp850 } from '../src/zeus/cp850';
import { parseTxt } from '../src/zeus/parseTxt';
import { parseXls } from '../src/zeus/parseXls';
import { writeTxt } from '../src/zeus/writeTxt';
import { SAMPLE_TXT, SAMPLE_XLS, readSample } from './helpers';

describe('T4 — encoding survival (§8)', () => {
  const NAMES = ['ARROZ PARBOLIZADO DOÑA PEPA', 'AJÍ CHIPOTLE AMAZON', 'JAMÓN SELECCIONADO'];

  it('survives decode -> parse -> write -> encode -> decode unchanged', () => {
    const bytes = readSample(SAMPLE_TXT);
    const file = parseTxt(bytes); // decode + parse
    const out = writeTxt(file, new Map([[82, 5]]), { uncountedPolicy: 'existencia' }); // write + encode
    const back = parseTxt(out); // decode again

    for (const name of NAMES) {
      const before = file.items.filter((i) => i.nombre === name);
      const after = back.items.filter((i) => i.nombre === name);
      expect(before.length, `${name} must be present in the sample`).toBeGreaterThan(0);
      expect(after.map((i) => i.idarticulo)).toEqual(before.map((i) => i.idarticulo));
    }
    expect(back.items.map((i) => i.nombre)).toEqual(file.items.map((i) => i.nombre));
    expect(back.items.map((i) => i.presentacion)).toEqual(file.items.map((i) => i.presentacion));
  });

  it('encodes the accented characters as the single CP850 bytes Zeus expects', () => {
    const bytes = readSample(SAMPLE_TXT);
    const file = parseTxt(bytes);
    const out = writeTxt(file, new Map(), { uncountedPolicy: 'existencia' });
    // Ñ = 0xA5, Í = 0xD6, Ó = 0xE0 — one byte each, not UTF-8 two-byte pairs.
    for (const [char, byte] of [
      ['Ñ', 0xa5],
      ['Í', 0xd6],
      ['Ó', 0xe0],
    ] as const) {
      expect(Array.from(encodeCp850(char))).toEqual([byte]);
      expect(out.includes(byte)).toBe(true);
    }
    // No UTF-8 lead bytes leaked into the output.
    expect(out.includes(0xc3)).toBe(false);
  });

  it('the accented names come through the .xls identically', () => {
    const xls = parseXls(readSample(SAMPLE_XLS));
    for (const name of NAMES) {
      expect(xls.items.some((i) => i.nombre === name), name).toBe(true);
    }
    // Names round-trip through the CP850 codec, so an .xls -> .txt export is safe.
    for (const item of xls.items) {
      expect(decodeCp850(encodeCp850(item.nombre))).toBe(item.nombre);
      expect(decodeCp850(encodeCp850(item.presentacion))).toBe(item.presentacion);
    }
  });

  it('an .xls -> .txt export is a valid Zeus file', () => {
    const xls = parseXls(readSample(SAMPLE_XLS));
    const out = writeTxt(xls, new Map([[41, 21]]), { uncountedPolicy: 'existencia' });
    const back = parseTxt(out);
    expect(back.items).toHaveLength(298);
    expect(back.items[0].nombre).toBe('PECHUGA DE POLLO');
    expect(back.items[0].toma).toBe(21);
    expect(back.items[0].diferencia).toBe(0.2); // not 0.20000000000000107
    expect(back.bodega).toBe('01');
    expect(back.fecha).toBe('2025/04/30');
  });
});
