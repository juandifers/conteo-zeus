/**
 * Catalogue integrity at import — ZEUS_FORMAT.md §4.1.
 *
 * The failure this exists for: somebody sorts `nombre`, `presentacion` and
 * `existencia` in Excel without extending the selection, and every row keeps
 * its own `codigo`, `costo` and `idarticulo` while acquiring somebody else's
 * name and quantity. Nothing downstream can tell — every row still parses,
 * still has a plausible price, still writes a well-formed adjustment line — and
 * the file posts quantities to the wrong articles.
 *
 * Two signals, and the two samples are the whole argument for both. The `.xls`
 * satisfies the three self-consistency invariants exactly and reads 48.5% out
 * of alphabetical order; the `.txt` beside it — same bodega, same corte —
 * breaks all three invariants and reads 0%.
 */
import { describe, expect, it } from 'vitest';
import { CatalogueError, catalogueFaults, importZeusFile, inversionRate } from '../src/app';
import { parseTxt, parseXls } from '../src/zeus';
import type { Item } from '../src/domain';
import { SAMPLE_TXT, SAMPLE_XLS, readSample } from './helpers';

const XLS = parseXls(readSample(SAMPLE_XLS));
const TXT = parseTxt(readSample(SAMPLE_TXT));

function item(over: Partial<Item> & { idarticulo: number }): Item {
  return {
    codigo: '0103005',
    nombre: 'PANCETA SV',
    presentacion: 'KILO',
    existencia: 10,
    ultimoConteo: null,
    costo: 1000,
    ...over,
  };
}

describe('the real files', () => {
  it('accepts the .xls, which passes both signals', () => {
    // 298 rows, 232 codigos, 44 of them carrying more than one row: the
    // redundancy the checks below read is genuinely there, and clean.
    expect(catalogueFaults(importZeusFile(XLS).items)).toEqual([]);
  });

  it('measures the two columns that decide the second signal', () => {
    // The whole basis for a 5% threshold: the gap it sits in is 48 points
    // wide, so nothing about it is finely tuned.
    const clean = importZeusFile(XLS).items;
    expect(clean).toHaveLength(298);
    expect(inversionRate(clean.map((i) => i.nombre))).toBeCloseTo(0.485, 2);

    // And the rows of both files are in the order Zeus writes them, ascending
    // `idarticulo` — which is what makes an alphabetical `nombre` impossible.
    for (const file of [XLS, TXT]) {
      const ids = file.items.map((i) => i.idarticulo);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    }
    expect(inversionRate(TXT.items.map((i) => i.nombre))).toBe(0);
  });

  it('refuses the .txt, and says which rows disagree', () => {
    expect(() => importZeusFile(TXT)).toThrow(CatalogueError);

    let thrown: CatalogueError | undefined;
    try {
      importZeusFile(TXT);
    } catch (cause) {
      thrown = cause as CatalogueError;
    }
    const faults = thrown!.faults;
    expect(faults.filter((f) => f.kind === 'nombre-por-codigo')).toHaveLength(43);
    expect(faults.filter((f) => f.kind === 'codigo-por-nombre')).toHaveLength(44);
    // Six colliding keys, not eight rows: three of them collect three rows.
    expect(faults.filter((f) => f.kind === 'fila-repetida')).toHaveLength(6);
    // And the second signal, which is the one that says *why*.
    expect(faults.filter((f) => f.kind === 'columna-ordenada')).toEqual([
      { kind: 'columna-ordenada', key: 'nombre', values: ['|MIEL MAPLE SYRUP', 'ZUMO DE LIMON'] },
    ]);
  });

  it('names the mechanism and the remedy, not just the count', () => {
    // Read in a banner by whoever is holding the file. "43 códigos" alone
    // leaves somebody staring at a file they have no reason to distrust.
    expect(() => importZeusFile(TXT)).toThrow(/ordenan unas columnas en Excel/);
    expect(() => importZeusFile(TXT)).toThrow(/artículos equivocados/);
    expect(() => importZeusFile(TXT)).toThrow(/Vuelve a exportar la bodega desde Zeus/);
  });

  it('carries the whole list, not the sentence', () => {
    // The message caps what it names; a caller that has to act on the set gets
    // all of it, the same bargain `UncountedItemsError` strikes (§9).
    try {
      importZeusFile(TXT);
      expect.unreachable();
    } catch (cause) {
      expect((cause as CatalogueError).faults.length).toBe(94);
    }
  });
});

describe('signal one — the file contradicts itself', () => {
  it('one codigo is one product, however many presentations it has', () => {
    const faults = catalogueFaults([
      item({ idarticulo: 1, presentacion: 'KILO' }),
      item({ idarticulo: 2, presentacion: 'PORCION X 300 GRAMOS', nombre: 'CEBOLLA ROJA' }),
    ]);
    expect(faults).toEqual([
      { kind: 'nombre-por-codigo', key: '0103005', values: ['CEBOLLA ROJA', 'PANCETA SV'] },
    ]);
  });

  it('accepts the same product under several presentations', () => {
    // The normal shape of this catalogue: 44 of 232 codes look like this.
    expect(
      catalogueFaults([
        item({ idarticulo: 1, presentacion: 'KILO' }),
        item({ idarticulo: 2, presentacion: 'PORCION X 300 GRAMOS' }),
        item({ idarticulo: 3, presentacion: 'PORCION X 350 GRAMOS' }),
      ]),
    ).toEqual([]);
  });

  it('catches a displacement that leaves every codigo unique', () => {
    // The case the first invariant cannot see: no code repeats, so nothing
    // disagrees about a name — except that one name now sits under two codes.
    const faults = catalogueFaults([
      item({ idarticulo: 1, codigo: '0103005', nombre: 'ACEITE DE OLIVA' }),
      item({ idarticulo: 2, codigo: '0110004', nombre: 'ACEITE DE OLIVA' }),
    ]);
    expect(faults).toEqual([
      { kind: 'codigo-por-nombre', key: 'ACEITE DE OLIVA', values: ['0103005', '0110004'] },
    ]);
  });

  it('refuses two rows for the same codigo and the same presentation', () => {
    // Two balances for one thing: whichever the counter opens, the other one
    // posts untouched.
    const faults = catalogueFaults([
      item({ idarticulo: 1, presentacion: 'KILO' }),
      item({ idarticulo: 2, presentacion: 'KILO' }),
    ]);
    expect(faults).toEqual([
      { kind: 'fila-repetida', key: '0103005 KILO', values: ['1', '2'] },
    ]);
  });

  it('does not call spacing a different product', () => {
    // A trailing space out of a spreadsheet is not a second article, and a
    // check that blocked a whole count over one would be worse than no check.
    expect(
      catalogueFaults([
        item({ idarticulo: 1, presentacion: 'KILO', nombre: 'PANCETA SV' }),
        item({ idarticulo: 2, presentacion: 'LIBRA', nombre: '  panceta   sv ' }),
      ]),
    ).toEqual([]);
  });

  it('says nothing about a catalogue with no repetition to read', () => {
    // The honest limit of this signal, asserted so nobody mistakes silence for
    // verification: one file carries no second opinion about what an
    // idarticulo is, and these three checks work only where a codigo or a
    // nombre repeats. Two rows, so the second signal has nothing to say either.
    expect(
      catalogueFaults([
        item({ idarticulo: 1, codigo: '0000001', nombre: 'A' }),
        item({ idarticulo: 2, codigo: '0000002', nombre: 'B' }),
      ]),
    ).toEqual([]);
  });
});

/**
 * Rows in `idarticulo` order with `nombre` running A to Z.
 *
 * Built with unique codes and unique names so the first signal has nothing to
 * read: this is exactly the catalogue the invariants above are blind to.
 */
function alphabetical(count: number, names?: string[]): Item[] {
  const letter = (n: number) => String.fromCharCode(65 + n);
  const letters =
    names ??
    Array.from({ length: count }, (_, i) => `ARTICULO ${letter(Math.floor(i / 26))}${letter(i % 26)}`);
  return letters.map((nombre, i) =>
    item({ idarticulo: i + 1, codigo: String(9000 + i).padStart(7, '0'), nombre }),
  );
}

describe('signal two — a column in an order the file is not', () => {
  it('catches a sorted name column in a catalogue with no repetition at all', () => {
    // The reason the second signal exists. Every codigo unique, every nombre
    // unique, every presentation the same: all three invariants are satisfied,
    // and the file is still a scramble.
    const items = alphabetical(20);
    expect(catalogueFaults(items).filter((f) => f.kind !== 'columna-ordenada')).toEqual([]);
    expect(catalogueFaults(items)).toEqual([
      { kind: 'columna-ordenada', key: 'nombre', values: ['ARTICULO AA', 'ARTICULO AT'] },
    ]);
  });

  it('leaves a normal catalogue alone', () => {
    const items = alphabetical(20).map((row, i, all) => ({
      ...row,
      nombre: all[(i * 7) % all.length].nombre,
    }));
    expect(catalogueFaults(items).filter((f) => f.kind === 'columna-ordenada')).toEqual([]);
  });

  it('allows a few names out of order, and stops at 5%', () => {
    // `near-perfectly sorted`, not `sorted`: a couple of names that fell out of
    // place — a manual edit, an accent the sort read differently — should not
    // cost anybody the check, and a file this tidy still did not come out of
    // Zeus that way.
    const names = (rows: Item[]) => rows.map((r) => r.nombre);
    const swap = (rows: Item[], at: number): Item[] =>
      rows.map((row, i) => ({
        ...row,
        nombre: names(rows)[i === at ? at + 1 : i === at + 1 ? at : i],
      }));

    const fires = (rows: Item[]) =>
      catalogueFaults(rows).filter((f) => f.kind === 'columna-ordenada').length;

    expect(fires(alphabetical(40))).toBe(1);
    // One name out of place: 1 of 39 pairs, 2.6%, inside the allowance.
    expect(fires(swap(alphabetical(40), 10))).toBe(1);
    // Two: 2 of 39, 5.1%, over the line and no longer anybody's business.
    expect(fires(swap(swap(alphabetical(40), 10), 20))).toBe(0);
  });

  it('says nothing when the whole row was sorted, which is harmless', () => {
    // Somebody sorted by name in Excel with the sheet selected. The names are
    // alphabetical and every one of them still travels with its own key, so
    // `idarticulo` is shuffled and there is nothing wrong with the file.
    const rows = alphabetical(20);
    const shuffled = rows.map((row, i) => ({ ...row, idarticulo: ((i * 7) % 20) + 1 }));
    expect(catalogueFaults(shuffled)).toEqual([]);
  });

  it('does not refuse a small bodega for being alphabetical by accident', () => {
    expect(catalogueFaults(alphabetical(11))).toEqual([]);
    expect(catalogueFaults(alphabetical(12))).toHaveLength(1);
  });
});

describe('what the person holding the file is told', () => {
  it('names the sorted column, and what a fresh export looks like instead', () => {
    let thrown: CatalogueError | undefined;
    try {
      importZeusFile({ ...TXT, items: TXT.items });
    } catch (cause) {
      thrown = cause as CatalogueError;
    }
    expect(thrown!.message).toMatch(/orden alfabético de punta a punta/);
    expect(thrown!.message).toMatch(/«\|MIEL MAPLE SYRUP» a «ZUMO DE LIMON»/);
    expect(thrown!.message).toMatch(/Un archivo recién exportado no sale así/);
  });

  it('drops the contradiction sentence when there is no contradiction', () => {
    // The whole message has to read as one thing when only one signal fires:
    // no dangling `0 códigos`, and the sentence still opens with a capital.
    const faults = catalogueFaults(alphabetical(20));
    const message = new CatalogueError(faults).message;
    expect(message.startsWith('La columna de nombres va en orden alfabético')).toBe(true);
    expect(message).not.toMatch(/se contradice/);
    expect(message).toMatch(/Vuelve a exportar la bodega desde Zeus/);
  });
});
