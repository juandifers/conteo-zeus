/**
 * Search ranking, against the real catalogue.
 *
 * Matching is the easy half. Three letters return a dozen rows here, so what
 * is being tested is the order they come back in and the line drawn between a
 * word match and a match that merely happens to be inside another word.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  groupByCodigo,
  normalise,
  resolveEnter,
  searchItems,
  tokenize,
} from '../../src/ui/search';
import { ID, sampleSession } from './harness';

const session = sampleSession();
const index = buildIndex(session.items);
const groups = groupByCodigo(session.items);

const ids = (query: string) => searchItems(index, query).map((hit) => hit.item.idarticulo);
const rank = (query: string, idarticulo: number) => ids(query).indexOf(idarticulo);

describe('normalisation', () => {
  it('folds accents and ñ, and uppercases', () => {
    expect(normalise('AJÍ CHIPOTLE')).toBe('AJI CHIPOTLE');
    expect(normalise('ñame')).toBe('NAME');
    expect(normalise('Piña Colada')).toBe('PINA COLADA');
  });

  it('splits a query on whitespace and drops the gaps', () => {
    expect(tokenize('  pan   500 ')).toEqual(['PAN', '500']);
    expect(tokenize('   ')).toEqual([]);
    expect(searchItems(index, '')).toEqual([]);
  });
});

describe('ranking', () => {
  it('returns all 14 rows containing "pan"', () => {
    expect(ids('pan')).toHaveLength(14);
  });

  it('puts PANCETA SV above EMPANADA DE MAIZ CARNE', () => {
    // The pair the two tiers exist for: EMPANADA genuinely contains "pan", and
    // somebody looking for bread must not have to read past it.
    expect(rank('pan', ID.pancetaKilo)).toBeLessThan(rank('pan', ID.empanada));
  });

  it('separates word matches from mid-word matches', () => {
    const hits = searchItems(index, 'pan');
    const partial = hits.filter((hit) => hit.tier === 'partial');
    expect(partial.map((hit) => hit.item.nombre)).toEqual(['EMPANADA DE MAIZ CARNE']);
    // Every partial hit sits after every prefix hit, which is what lets the
    // screen draw one divider rather than interleave two styles of row.
    const lastPrefix = hits.findLastIndex((hit) => hit.tier === 'prefix');
    const firstPartial = hits.findIndex((hit) => hit.tier === 'partial');
    expect(lastPrefix).toBeLessThan(firstPartial);
  });

  it('ranks a name match above the same word later in the row', () => {
    // PAN TAJADO starts with it; HARINA PAN AMARILLA has it seven characters in.
    expect(rank('pan', ID.panTajado)).toBeLessThan(rank('pan', 42));
  });

  it('ANDs multiple tokens across nombre, presentacion and codigo', () => {
    // "pan 500" is two fields at once: the name and the packaging.
    expect(ids('pan 500')).toEqual([ID.panTajado, 2236]);
  });

  it('finds ÑAME when nobody types the tilde', () => {
    expect(ids('name')).toEqual([ID.name]);
  });

  it('finds AJÍ CHIPOTLE AMAZON when nobody types the accent', () => {
    expect(ids('aji')).toContain(ID.ajiChipotle);
    // …and puts TAJIN, which merely contains the letters, below the divider.
    const tajin = searchItems(index, 'aji').find((hit) => hit.item.nombre.startsWith('TAJIN'));
    expect(tajin?.tier).toBe('partial');
  });

  it('is stable: the same query twice gives the same order', () => {
    expect(ids('pan')).toEqual(ids('pan'));
  });
});

describe('Enter — the keyboard-wedge hook', () => {
  it('takes an exact codigo over the ranking', () => {
    // 0106001 covers four presentations of PESCADO TILAPIA ROJA. The text
    // ranking puts "DE 200 A 250 GRS" first, alphabetically. Enter must not
    // route a scan to a balance chosen by the alphabet: it opens the group on
    // its first row in file order, which is shelf order (DOMAIN.md §6).
    expect(ids('0106001')[0]).toBe(ID.tilapia200);

    const target = resolveEnter(index, groups, '0106001');
    expect(target?.via).toBe('codigo');
    expect(target?.items).toHaveLength(4);
    expect(target?.active.idarticulo).toBe(ID.tilapia600);
    expect(target?.active.idarticulo).not.toBe(ids('0106001')[0]);
  });

  it('selects the item outright when the codigo has one presentation', () => {
    const target = resolveEnter(index, groups, '0111020');
    expect(target?.via).toBe('codigo');
    expect(target?.items).toHaveLength(1);
    expect(target?.active.idarticulo).toBe(ID.melon);
  });

  it('restores a leading zero a wedge stripped', () => {
    expect(resolveEnter(index, groups, '111020')?.active.idarticulo).toBe(ID.melon);
  });

  it('falls back to the top result when the query is not a codigo', () => {
    const target = resolveEnter(index, groups, 'pan 500');
    expect(target?.via).toBe('ranking');
    expect(target?.active.idarticulo).toBe(ID.panTajado);
  });

  it('is null when nothing matches', () => {
    expect(resolveEnter(index, groups, 'zzz')).toBeNull();
  });
});
