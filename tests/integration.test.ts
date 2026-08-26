/**
 * The whole stack over the real 298-row sample:
 *
 *   .xls -> parseXls -> importZeusFile -> events -> summary -> exportAdjustment -> .txt
 *
 * The unit tests pin the rules; this pins the rules against the actual
 * catalogue, where `existencia` is decimal, `costo2` runs to 13 dp and one
 * `codigo` covers several `idarticulo`s (§4).
 */
// Must precede any import that reaches Dexie: Dexie binds the global
// indexedDB at module load, so a shim installed afterwards is too late.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { COL } from '../src/zeus/types';
import { UncountedItemsError, decodeCp850, parseXls, reencode } from '../src/zeus';
import { exportAdjustment, importZeusFile } from '../src/app';
import {
  MemoryRepository,
  summarizeSession,
  type CountEvent,
  type Session,
} from '../src/domain';
import { DexieCountRepository, ConteoDb } from '../src/store';
import { SAMPLE_XLS, readSample } from './helpers';

const SOURCE = parseXls(readSample(SAMPLE_XLS));

function newSession(): Session {
  return importZeusFile(SOURCE, {
    id: 'session-integration',
    createdAt: '2026-08-25T09:00:00.000Z',
  });
}

const EPOCH = Date.UTC(2026, 7, 25, 10, 0, 0);

let seq = 0;
function event(idarticulo: number, kind: 'set' | 'unchanged', qty = 0): CountEvent {
  const n = seq++;
  const common = {
    id: `ev-${n}`,
    sessionId: 'session-integration',
    idarticulo,
    usuario: 'ana',
    zona: 'ALMACEN',
    // Built through toISOString, because appendEvent rejects anything else (§3).
    at: new Date(EPOCH + n).toISOString(),
    deviceId: 'device-a',
    seq: n,
  };
  return kind === 'set' ? { ...common, kind: 'set', qty } : { ...common, kind: 'unchanged' };
}

/** HUEVOS A / UNIDAD — 10 080 units at 433.30 COP, the largest line in the file. */
const HUEVOS = 55;
/** MELON / KILO — booked at zero, last counted at 234.8 (DOMAIN.md §5). */
const MELON = 77;

describe('import (§4)', () => {
  it('produces one item per row, keyed on idarticulo', () => {
    const session = newSession();
    expect(session.items).toHaveLength(298);
    expect(new Set(session.items.map((i) => i.idarticulo)).size).toBe(298);
  });

  it('keeps the 232 distinct codigos that share those 298 rows (§4)', () => {
    const session = newSession();
    expect(new Set(session.items.map((i) => i.codigo)).size).toBe(232);

    // 0103005 is three separate balances, not one merged product.
    const panceta = session.items.filter((i) => i.codigo === '0103005');
    expect(panceta.map((i) => i.idarticulo).sort((a, b) => a - b)).toEqual([330, 1181, 2660]);
    expect(panceta.map((i) => i.existencia).sort((a, b) => a - b)).toEqual([30, 60, 97.5]);
  });

  it('carries the file-level metadata', () => {
    const session = newSession();
    expect(session.bodega).toBe('01');
    expect(session.fechaCorte).toBe('2025/04/30');
    expect(session.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops the Zeus vocabulary entirely', () => {
    const session = newSession();
    expect(Object.keys(session.items[0]).sort()).toEqual([
      'codigo',
      'costo',
      'existencia',
      'idarticulo',
      'nombre',
      'presentacion',
      'ultimoConteo',
    ]);
    expect(JSON.stringify(session.items[0])).not.toMatch(/rawRow|conteo|Grupo/);
  });

  it('maps the last count onto a neutral name, keeping the value', () => {
    const session = newSession();
    const melon = session.items.find((i) => i.idarticulo === MELON)!;
    const raw = SOURCE.items.find((i) => i.idarticulo === MELON)!;
    expect(melon.ultimoConteo).toBe(raw.conteo1);
    expect(melon.ultimoConteo).toBe(234.8);
    // All 298 rows carry a positive prior, so nothing maps to null here.
    expect(session.items.every((i) => i.ultimoConteo !== null)).toBe(true);
    expect(session.items.filter((i) => i.ultimoConteo! > 0)).toHaveLength(298);
  });

  it('uses costo2, not the 11-char costo (ZEUS_FORMAT.md §3)', () => {
    const session = newSession();
    const huevos = session.items.find((i) => i.idarticulo === HUEVOS)!;
    const raw = SOURCE.items.find((i) => i.idarticulo === HUEVOS)!;
    expect(huevos.costo).toBe(raw.costo2);
    expect(huevos.costo).not.toBe(raw.costo);
  });

  it('freezes the items — a re-import is a new session', () => {
    const session = newSession();
    expect(Object.isFrozen(session.items)).toBe(true);
    const again = importZeusFile(SOURCE);
    expect(again.id).not.toBe(session.id);
    expect(again.sourceHash).toBe(session.sourceHash); // same file, same content
  });
});

describe('a session nobody has counted yet (§9)', () => {
  it('is 298 untouched items and cannot post', () => {
    const summary = summarizeSession(newSession(), []);
    expect(summary.counts).toEqual({ counted: 0, unchanged: 0, untouched: 298 });
    expect(summary.canPost).toBe(false);
  });

  it('waives 140,505,651 COP of book value — the accounting figure (§5)', () => {
    const summary = summarizeSession(newSession(), []);
    expect(Math.round(summary.pendiente.valor)).toBeGreaterThanOrEqual(140_505_650);
    expect(Math.round(summary.pendiente.valor)).toBeLessThanOrEqual(140_505_652);
  });

  it('names HUEVOS A first, because which rows go unverified is the point', () => {
    const summary = summarizeSession(newSession(), []);
    expect(summary.pendienteTop).toHaveLength(10);
    expect(summary.pendienteTop[0].item.nombre).toBe('HUEVOS A');
    expect(Math.round(summary.pendienteTop[0].valor)).toBe(4_367_705);

    // ZEUS_FORMAT.md §9 quoted 22.5% for the top 10; that is what makes naming
    // them worthwhile.
    const top10 = summary.pendienteTop.reduce((sum, u) => sum + u.valor, 0);
    expect(top10 / summary.pendiente.valor).toBeCloseTo(0.225, 3);
  });

  it('reports no variance at all — untouched is not a zero (§2)', () => {
    const summary = summarizeSession(newSession(), []);
    expect(summary.netVarianceValue).toBe(0);
    expect(summary.grossVarianceValue).toBe(0);
    expect(summary.byMateriality).toEqual([]);
    expect(summary.items.every((s) => s.variance === null)).toBe(true);
  });
});

describe('what a waiver actually risks (§5)', () => {
  const summary = summarizeSession(newSession(), []);
  const zeroBook = summary.byExposicion.filter((u) => u.item.existencia === 0);

  it('is 31 rows the book value cannot see', () => {
    expect(zeroBook).toHaveLength(31);
    // Fresh produce, booked at zero between purchases — and every one of them
    // held stock at the last count, which is what makes the blind spot real
    // rather than theoretical.
    expect(zeroBook.every((u) => u.valor === 0)).toBe(true);
    expect(zeroBook.every((u) => u.item.ultimoConteo! > 0)).toBe(true);
    expect(zeroBook.map((u) => u.item.nombre)).toContain('MELON');
    expect(zeroBook.map((u) => u.item.nombre)).toContain('FRESA');
  });

  it('contributes 0 to pendiente.valor and 6.24M COP to pendiente.exposicion', () => {
    const valor = zeroBook.reduce((sum, u) => sum + u.valor, 0);
    const exposicion = zeroBook.reduce((sum, u) => sum + u.exposicion, 0);

    expect(valor).toBe(0);
    expect(Math.round(exposicion)).toBeGreaterThanOrEqual(6_244_683);
    expect(Math.round(exposicion)).toBeLessThanOrEqual(6_244_685);
    // 4.4% of the bodega, invisible to the figure finance is given.
    expect(exposicion / summary.pendiente.valor).toBeCloseTo(0.0444, 4);
  });

  it('carries both totals, the second above the first', () => {
    expect(Math.round(summary.pendiente.valor)).toBe(140_505_651);
    expect(Math.round(summary.pendiente.exposicion)).toBe(152_562_010);
    expect(summary.pendiente.exposicion).toBeGreaterThan(summary.pendiente.valor);
  });

  it('ranks MELON 28th by exposure and 274th by book value', () => {
    const melon = summary.byExposicion.find((u) => u.item.idarticulo === MELON)!;
    expect(melon.valor).toBe(0);
    expect(Math.round(melon.exposicion)).toBe(1_366_930);

    const byExposure = summary.byExposicion.findIndex((u) => u.item.idarticulo === MELON);
    const byValue = summary.byExposicion
      .slice()
      .sort((a, b) => b.valor - a.valor || a.item.idarticulo - b.item.idarticulo)
      .findIndex((u) => u.item.idarticulo === MELON);

    // 246 places apart. Not the top 20 — 27 rows are worth more by exposure —
    // but the highest-ranked row the book-value order cannot see at all, and
    // 246 places is the whole point: a value-ordered walk reaches it last.
    expect(byExposure).toBe(27);
    expect(byValue).toBe(273);
    expect(byValue - byExposure).toBe(246);
  });

  it('puts MELON first among the rows worth nothing on paper', () => {
    expect(zeroBook[0].item.nombre).toBe('MELON');
    expect(zeroBook[0]).toBe(summary.byExposicion[27]);
  });

  it('agrees with book value on rows that have no hidden stock', () => {
    // 249 of 298 rows have a prior at or below the book figure, so the two
    // figures coincide there; the gap is entirely in the other 49.
    const same = summary.byExposicion.filter((u) => u.exposicion === u.valor);
    expect(same).toHaveLength(249);
    expect(summary.byExposicion[0].item.nombre).toBe('HUEVOS A');
  });
});

describe('a partial count refuses to post (ZEUS_FORMAT.md §9)', () => {
  const session = newSession();
  const counted = session.items.slice(0, 6).map((i) => i.idarticulo);
  const waived = session.items.slice(6, 10).map((i) => i.idarticulo);
  const events = [
    ...counted.map((id) => event(id, 'set', 3)),
    ...waived.map((id) => event(id, 'unchanged')),
  ];
  const untouched = session.items
    .map((i) => i.idarticulo)
    .filter((id) => !counted.includes(id) && !waived.includes(id));

  it('summarises what is missing', () => {
    const summary = summarizeSession(session, events);
    expect(summary.counts.counted).toBe(6);
    expect(summary.counts.unchanged).toBe(4);
    expect(summary.counts.untouched).toBe(288);
    expect(summary.canPost).toBe(false);
  });

  it('throws, and the thrown list is exactly the untouched set', () => {
    let thrown: unknown;
    try {
      exportAdjustment(session, events, { file: SOURCE });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UncountedItemsError);
    const ids = (thrown as UncountedItemsError).idarticulos;
    // Not a superset and not a subset: the same 288 ids, exactly.
    expect(ids).toHaveLength(288);
    expect([...ids].sort((a, b) => a - b)).toEqual([...untouched].sort((a, b) => a - b));
    expect(ids.some((id) => counted.includes(id))).toBe(false);
    expect(ids.some((id) => waived.includes(id))).toBe(false);
    expect((thrown as UncountedItemsError).total).toBe(298);
  });

  it('summarises the tail of the list rather than dumping 288 ids', () => {
    const error = new UncountedItemsError([1, 2, 3], 298);
    expect(error.message).toContain('1, 2, 3');
    expect(() => exportAdjustment(session, events, { file: SOURCE })).toThrow(
      /\(\+268 more\)/,
    );
  });
});

describe('a complete count posts, and moves only what it touched', () => {
  /** Five real rows, each counted one unit above the book figure. */
  const MOVED = new Map<number, number>([
    [HUEVOS, 10081], // 10 080 -> 10 081
    [1181, 98.5], // PANCETA SV / KILO, 97.5 -> 98.5
    [330, 31], // PANCETA SV / PORCION X 300 GRAMOS, 30 -> 31
    [56, 114.1], // QUESO COSTEÑO / KILO, 113.1 -> 114.1
    [2033, 56], // ACEITE DE GIRASOL, 55 -> 56
  ]);

  function completeEvents(session: Session): CountEvent[] {
    return session.items.map((item, index) => {
      const moved = MOVED.get(item.idarticulo);
      if (moved !== undefined) return event(item.idarticulo, 'set', moved);
      // Everything else is either counted at the book figure or waived —
      // both post, neither moves a number.
      return index % 3 === 0
        ? event(item.idarticulo, 'unchanged')
        : event(item.idarticulo, 'set', item.existencia);
    });
  }

  it('can post once nothing is untouched', () => {
    const session = newSession();
    const summary = summarizeSession(session, completeEvents(session));
    expect(summary.counts.untouched).toBe(0);
    expect(summary.pendiente.valor).toBe(0);
    expect(summary.canPost).toBe(true);
  });

  it('differs from the source only in toma and diferencia, only on the moved rows', () => {
    const session = newSession();
    const before = decodeCp850(reencode(SOURCE)).split('\r\n');
    const after = decodeCp850(
      exportAdjustment(session, completeEvents(session), { file: SOURCE }),
    ).split('\r\n');

    expect(after).toHaveLength(before.length);

    const changed: Array<[number, number]> = [];
    for (let row = 0; row < before.length; row++) {
      const left = before[row].split('\t');
      const right = after[row].split('\t');
      expect(right).toHaveLength(left.length);
      for (let field = 0; field < left.length; field++) {
        if (left[field] !== right[field]) changed.push([row, field]);
      }
    }

    const movedRows = SOURCE.items
      .map((item, row) => (MOVED.has(item.idarticulo) ? row : -1))
      .filter((row) => row >= 0);
    expect(movedRows).toHaveLength(5);

    const expected = movedRows.flatMap((row): Array<[number, number]> => [
      [row, COL.toma],
      [row, COL.diferencia],
    ]);
    expect(changed.sort(byRowThenField)).toEqual(expected.sort(byRowThenField));
  });

  it('writes the count and the variance on those rows', () => {
    const session = newSession();
    const after = decodeCp850(
      exportAdjustment(session, completeEvents(session), { file: SOURCE }),
    ).split('\r\n');

    const row = (idarticulo: number) =>
      after[SOURCE.items.findIndex((item) => item.idarticulo === idarticulo)].split('\t');

    expect(row(HUEVOS)[COL.toma]).toBe('10081');
    expect(row(HUEVOS)[COL.diferencia]).toBe('1');
    // 98.5 - 97.5 must be 1, not 0.9999999999999929 (§3).
    expect(row(1181)[COL.toma]).toBe('98.5');
    expect(row(1181)[COL.diferencia]).toBe('1');
    expect(row(56)[COL.toma]).toBe('114.1');
    expect(row(56)[COL.diferencia]).toBe('1');
  });

  it('leaves Grupo1..5 empty, whatever the count said (ZEUS_FORMAT.md §9)', () => {
    const session = newSession();
    const after = decodeCp850(
      exportAdjustment(session, completeEvents(session), { file: SOURCE }),
    ).split('\r\n');
    for (const line of after.filter(Boolean)) {
      const fields = line.split('\t');
      expect(fields.slice(COL.grupo1, COL.grupo5 + 1)).toEqual(['', '', '', '', '']);
    }
  });

  it('refuses to write against a different file than the count was taken on', () => {
    const session = newSession();
    const tampered = {
      ...SOURCE,
      items: SOURCE.items.map((item, index) =>
        index === 0 ? { ...item, rawRow: item.rawRow.map((f, i) => (i === COL.existencia ? '1' : f)) } : item,
      ),
    };
    expect(() =>
      exportAdjustment(session, completeEvents(session), { file: tampered }),
    ).toThrow(/not the one session .* was imported from/);
  });
});

describe('materiality ranking', () => {
  /** A count that finds 5 000 eggs where the book says 10 080. */
  function events(session: Session): CountEvent[] {
    return session.items.map((item) =>
      item.idarticulo === HUEVOS
        ? event(HUEVOS, 'set', 5000)
        : event(item.idarticulo, 'set', item.existencia),
    );
  }

  it('puts HUEVOS A at the top when it is the one that moved', () => {
    const session = newSession();
    const summary = summarizeSession(session, events(session));
    expect(summary.byMateriality[0].item.nombre).toBe('HUEVOS A');
    expect(summary.byMateriality[0].variance!.variance).toBe(-5080);
    expect(Math.round(summary.byMateriality[0].variance!.valorVariance)).toBe(-2_201_184);
    expect(summary.byMateriality.slice(0, 10).some((s) => s.item.nombre === 'HUEVOS A')).toBe(
      true,
    );
  });

  it('is stable: the same events in a different order rank identically', () => {
    const session = newSession();
    const log = events(session);
    const shuffled = [...log].reverse();
    const straight = summarizeSession(session, log);
    const reversed = summarizeSession(session, shuffled);

    const ids = (s: typeof straight) =>
      s.byMateriality.slice(0, 10).map((entry) => entry.item.idarticulo);
    expect(ids(reversed)).toEqual(ids(straight));
    // Everything but HUEVOS A matched the book, so the rest is a 297-way tie
    // at zero — broken on idarticulo, which is why the order is reproducible.
    expect(ids(straight)[0]).toBe(HUEVOS);
    expect(ids(straight).slice(1)).toEqual([...ids(straight).slice(1)].sort((a, b) => a - b));
  });

  it('nets to the same money it grosses when only one row moved', () => {
    const session = newSession();
    const summary = summarizeSession(session, events(session));
    expect(Math.round(summary.netVarianceValue)).toBe(-2_201_184);
    expect(Math.round(summary.grossVarianceValue)).toBe(2_201_184);
  });
});

describe('through the store', () => {
  it('imports, persists, counts, reloads and posts', async () => {
    const db = new ConteoDb('conteo-integration');
    const repo = new DexieCountRepository(db);
    const session = newSession();
    await repo.createSession(session);

    for (const item of session.items) {
      await repo.appendEvent(
        item.idarticulo === HUEVOS
          ? event(HUEVOS, 'set', 10081)
          : event(item.idarticulo, 'set', item.existencia),
      );
    }

    const reloaded = (await repo.getSession(session.id))!;
    expect(reloaded.items).toHaveLength(298);
    expect(reloaded.items.map((i) => i.idarticulo)).toEqual(
      session.items.map((i) => i.idarticulo),
    );

    const log = await repo.eventsForSession(session.id);
    const summary = summarizeSession(reloaded, log);
    expect(summary.canPost).toBe(true);
    expect(summary.counts.counted).toBe(298);

    // 31 rows carry existencia 0, so counting them at the book figure is a
    // count of zero. They are `counted` + `none`, not a fourth state (§2) —
    // an empty shelf confirmed empty, which is nothing like a write-off.
    const zeroStock = summary.items.filter((s) => s.item.existencia === 0);
    expect(zeroStock).toHaveLength(31);
    expect(zeroStock.every((s) => s.state === 'counted' && s.qty === 0)).toBe(true);
    expect(zeroStock.every((s) => s.variance!.varianceClass === 'none')).toBe(true);

    const bytes = exportAdjustment(reloaded, log, { file: SOURCE });
    const rows = decodeCp850(bytes).split('\r\n').filter(Boolean);
    expect(rows).toHaveLength(298);
    const huevosRow = rows[SOURCE.items.findIndex((i) => i.idarticulo === HUEVOS)].split('\t');
    expect(huevosRow[COL.toma]).toBe('10081');

    await db.delete();
  });

  it('resolves one item without reading the session log', async () => {
    const repo = new MemoryRepository();
    const session = newSession();
    await repo.createSession(session);
    await repo.appendEvent(event(HUEVOS, 'set', 10000));
    await repo.appendEvent(event(1181, 'set', 1));

    const forHuevos = await repo.eventsForItem(session.id, HUEVOS);
    expect(forHuevos).toHaveLength(1);
  });
});

function byRowThenField(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}
