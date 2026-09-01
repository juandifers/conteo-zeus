/**
 * The review — P2.4.
 *
 * Two properties carry most of this file, and both are about what a screen is
 * allowed to talk somebody into:
 *
 *   - **A waiver never overrides a count**, under any arrival order. That is not
 *     a refinement of the fold, it is the correctness condition: the outcome of
 *     a count must not depend on when a tablet reached wifi.
 *   - **Waiving lowers `pendiente` and leaves `sinVerificar` where it was.** A
 *     waiver accepts an exposure, it does not retire it, and a screen whose only
 *     visible number fell as you clicked would be a screen that talks somebody
 *     into signing 1 800 rows.
 *
 * Everything else here is a flag, and every flag is advisory: nothing in this
 * module changes a count, and the tests say so directly.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  reviewChecklist,
  reviewSession,
  standingWaivers,
  waiversToEvents,
  type CountEvent,
  type Item,
  type ReviewCounter,
  type SessionActionRecord,
} from '../../src/domain';
import { resolveAll } from '../../src/domain';
import {
  SESSION_ID,
  addCount,
  finish,
  note,
  reopen,
  resetFactory,
  retract,
} from './factory';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function item(
  idarticulo: number,
  existencia: number,
  costo: number,
  over: Partial<Item> = {},
): Item {
  return {
    idarticulo,
    codigo: String(idarticulo).padStart(7, '0'),
    nombre: `ITEM ${idarticulo}`,
    presentacion: 'KILO',
    existencia,
    ultimoConteo: null,
    costo,
    ...over,
  };
}

/** Four rows: two cheap, one expensive, one perishable booked at zero (§5). */
const ITEMS: Item[] = [
  item(1, 10, 100), // 1 000 en libros
  item(2, 20, 50), // 1 000
  item(3, 5, 1000, { nombre: 'CAVIAR' }), // 5 000
  item(4, 0, 2000, { nombre: 'MELON', ultimoConteo: 6 }), // 0 en libros, 12 000 de exposición
];

const ANA: ReviewCounter = { id: 'ana', nombre: 'Ana', estado: 'contando' };
const LUIS: ReviewCounter = { id: 'luis', nombre: 'Luis', estado: 'contando' };

let actionSeq = 0;

function action(
  kind: SessionActionRecord['kind'],
  payload: unknown,
  over: Partial<SessionActionRecord> = {},
): SessionActionRecord {
  const seq = over.seq ?? ++actionSeq;
  return {
    id: over.id ?? `accion-${seq}`,
    sessionId: SESSION_ID,
    seq,
    kind,
    payload: payload as SessionActionRecord['payload'],
    usuario: over.usuario ?? 'marta',
    at: over.at ?? new Date(Date.UTC(2026, 7, 25, 15, 0, seq)).toISOString(),
    serverAt: over.serverAt ?? new Date(Date.UTC(2026, 7, 25, 15, 0, seq)).toISOString(),
    prevHash: 'p',
    hash: `h${seq}`,
  };
}

function review(
  events: readonly CountEvent[],
  actions: readonly SessionActionRecord[] = [],
  counters: readonly ReviewCounter[] = [ANA, LUIS],
) {
  return reviewSession({ sessionId: SESSION_ID, items: ITEMS, events, actions, counters });
}

beforeEach(() => {
  resetFactory();
  actionSeq = 0;
});

// --- §4b: the correctness condition -----------------------------------------

describe('a waiver never overrides a count (§4b)', () => {
  /**
   * The scenario, written out so the rest of the section has a reason.
   *
   *     15:00  el admin exonera el artículo 3
   *     15:30  sincroniza una tableta rezagada — Luis lo contó a las 11:02
   *
   * `unchanged` discards any running value and the fold orders by time, so a
   * projection that simply appended the waiver would let three o'clock beat
   * eleven — and *which* won would depend on when a tablet found wifi.
   */
  it('is the bug, if waivers were projected without asking what was counted', () => {
    const counted = addCount(3, 8, { counterId: 'luis', at: '2026-08-25T11:02:00.000Z' });
    const naive: CountEvent = {
      id: 'w',
      sessionId: SESSION_ID,
      idarticulo: 3,
      kind: 'unchanged',
      usuario: 'marta',
      zona: '',
      at: '2026-08-25T15:00:00.000Z',
      deviceId: '',
      seq: 1,
    };
    expect(resolveAll([counted, naive]).get(3)).toEqual({ state: 'unchanged' });
  });

  it('projects nothing onto an article the counters touched', () => {
    const counted = addCount(3, 8, { counterId: 'luis', at: '2026-08-25T11:02:00.000Z' });
    const actions = [action('waiver', { idarticulo: [3], motivo: 'no alcanzó el turno' })];
    const projected = waiversToEvents(actions, resolveAll([counted]));
    expect(projected).toEqual([]);
    expect(review([counted], actions).rows.find((row) => row.item.idarticulo === 3)).toMatchObject(
      { state: 'counted', conteo: 8 },
    );
  });

  it('holds under every arrival order — the property, not one example', () => {
    // Three events and a waiver, in all 24 orders the log could have been
    // assembled in. The fold sorts, so the array order is only ever "which log
    // was concatenated first"; if any permutation produced a different answer,
    // two devices holding the same events would disagree.
    const events = [
      addCount(3, 8, { counterId: 'luis', at: '2026-08-25T11:02:00.000Z', seq: 1 }),
      addCount(3, 2, { counterId: 'luis', at: '2026-08-25T11:03:00.000Z', seq: 2 }),
      addCount(1, 4, { counterId: 'ana', at: '2026-08-25T16:00:00.000Z', seq: 1 }),
      note(null, 'sobra una caja', { counterId: 'ana', at: '2026-08-25T16:01:00.000Z', seq: 2 }),
    ];
    const actions = [action('waiver', { idarticulo: [1, 2, 3], motivo: 'cierre' })];

    for (const order of permutations(events)) {
      const rows = review(order, actions).rows;
      const byId = new Map(rows.map((row) => [row.item.idarticulo, row]));
      expect(byId.get(3)).toMatchObject({ state: 'counted', conteo: 10 });
      expect(byId.get(1)).toMatchObject({ state: 'counted', conteo: 4 });
      // Only the article nobody touched took the waiver.
      expect(byId.get(2)).toMatchObject({ state: 'unchanged' });
    }
  });

  it('lands on a genuinely untouched article, whenever it was signed', () => {
    const actions = [action('waiver', { idarticulo: [2], motivo: 'cierre' })];
    const rows = review([], actions).rows;
    expect(rows.find((row) => row.item.idarticulo === 2)).toMatchObject({ state: 'unchanged' });
  });

  it('flags the superseded one with both records', () => {
    const counted = addCount(3, 8, { counterId: 'luis', at: '2026-08-25T11:02:00.000Z' });
    const actions = [action('waiver', { idarticulo: [3], motivo: 'no alcanzó el turno' })];
    const result = review([counted], actions);

    expect(result.superseded).toHaveLength(1);
    // The waiver…
    expect(result.superseded[0]).toMatchObject({
      usuario: 'marta',
      motivo: 'no alcanzó el turno',
      state: 'counted',
      qty: 8,
      contadores: ['Luis'],
    });
    // …and the row it lands on carries the mark, so the table ranks it.
    const row = result.rows.find((entry) => entry.item.idarticulo === 3)!;
    expect(row.flags).toContainEqual({ kind: 'waiver-superado' });
  });

  it('is withdrawn by `anular_waiver`, and the original stays on the chain', () => {
    const waiver = action('waiver', { idarticulo: [2], motivo: 'cierre' });
    const withWaiver = review([], [waiver]);
    expect(withWaiver.rows.find((row) => row.item.idarticulo === 2)!.state).toBe('unchanged');

    const annulled = action('anular_waiver', { waiverId: waiver.id, motivo: 'me equivoqué' });
    const after = review([], [waiver, annulled]);
    expect(after.rows.find((row) => row.item.idarticulo === 2)!.state).toBe('untouched');
    expect(after.waivers).toEqual([]);
    // Append-only: the waiver is still in the log that was handed in, and
    // nothing here deleted or mutated it.
    expect(standingWaivers([waiver])).toHaveLength(1);
    expect(waiver.payload).toMatchObject({ idarticulo: [2] });
  });

  it('leaves the fold ignorant of what a session action is', () => {
    // The projection is consumed by the fold; the fold does not learn about the
    // admin's chain. That direction is the reason `fold.ts` is still readable by
    // somebody who has never heard of a waiver.
    const fold = readFileSync(resolvePath(SRC, 'domain', 'fold.ts'), 'utf8');
    const imports = [...fold.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports).not.toContain('./actions');
    expect(imports).not.toContain('./review');
    // It does not name the type either: an `import type` is still a dependency,
    // and the rule this file protects is that the fold has never heard of an
    // admin. (`unchanged` is a *count event*, and predates all of this.)
    expect(fold).not.toMatch(/SessionAction|session_actions/);
  });
});

// --- §2a: the two figures ----------------------------------------------------

describe('the two figures (§2a, DOMAIN.md §5)', () => {
  it('match §5’s definitions: pendiente is untouched, sinVerificar adds the waived', () => {
    const result = review([addCount(1, 10, { counterId: 'ana' })]);
    // Untouched: 2, 3 and 4. Exposure of 4 is `max(existencia, ultimoConteo)`,
    // which is the whole reason §5 has two measures: its book value is nothing.
    expect(result.pendiente.items).toBe(3);
    expect(result.pendiente.valor).toBe(1000 + 5000 + 0);
    expect(result.pendiente.exposicion).toBe(1000 + 5000 + 12000);
    expect(result.sinVerificar).toEqual(result.pendiente);
  });

  it('waiving lowers pendiente and does not move sinVerificar — the honesty property', () => {
    const events = [addCount(1, 10, { counterId: 'ana' })];
    const before = review(events);
    const after = review(events, [action('waiver', { idarticulo: [3], motivo: 'cierre' })]);

    expect(after.pendiente.items).toBe(before.pendiente.items - 1);
    expect(after.pendiente.exposicion).toBe(before.pendiente.exposicion - 5000);
    // Not a peso.
    expect(after.sinVerificar).toEqual(before.sinVerificar);
    expect(after.exoneradas).toBe(1);
  });

  it('ranks the table by exposure of the variance, so the produce row is not last', () => {
    // MELON is booked at zero and was counted at six against a prior of six: no
    // variance, so it drops down the ranking on its own merits. What must not
    // happen is the *untouched* case sorting to the bottom on book value.
    const result = review([addCount(1, 11, { counterId: 'ana' })]);
    expect(result.rows.map((row) => row.item.idarticulo)).toEqual([4, 3, 2, 1]);
    expect(result.rows[0].exposicion).toBe(12000);
  });
});

// --- §3: flags ---------------------------------------------------------------

describe('overlap tells a handover apart from a crossed section (§3a)', () => {
  const both = () => [
    addCount(3, 4, { counterId: 'ana', at: '2026-08-25T10:00:00.000Z', seq: 1 }),
    addCount(3, 6, { counterId: 'luis', at: '2026-08-25T12:00:00.000Z', seq: 1 }),
  ];

  it('is `secciones` when nothing reassigned it — the double count the sum cannot see', () => {
    const result = review(both());
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0].causa).toBe('secciones');
    expect(result.overlaps[0].movimiento).toBeNull();
    // The breakdown names who contributed what: the sum is 10 and neither of
    // them counted 10.
    expect(result.overlaps[0].contribuciones.map((part) => [part.nombre, part.cantidad])).toEqual([
      ['Ana', 4],
      ['Luis', 6],
    ]);
    expect(result.rows.find((row) => row.item.idarticulo === 3)!.conteo).toBe(10);
  });

  it('is `reasignado` when P2.3.5’s payload explains it, and names both and the time', () => {
    const moved = action('reasignar', {
      motivo: 'Luis se fue enfermo',
      movimientos: [{ idarticulo: 3, from: 'ana', to: 'luis', sectionId: 's1' }],
      seccionesCreadas: [],
      seccionesReapuntadas: [],
      sinSincronizar: [],
    });
    const result = review(both(), [moved]);
    expect(result.overlaps[0].causa).toBe('reasignado');
    expect(result.overlaps[0].movimiento).toMatchObject({
      from: 'Ana',
      to: 'Luis',
      usuario: 'marta',
      motivo: 'Luis se fue enfermo',
    });
    expect(result.rows.find((row) => row.item.idarticulo === 3)!.flags).toContainEqual({
      kind: 'overlap',
      causa: 'reasignado',
    });
  });
});

describe('post-finish amendments come from log position, never a stored flag (§3b)', () => {
  const log = () => {
    const first = addCount(1, 3, { counterId: 'ana', seq: 1 });
    const done = finish(1, 'h1', { counterId: 'ana', seq: 2 });
    const again = reopen({ counterId: 'ana', seq: 3 });
    const later = addCount(2, 5, { counterId: 'ana', seq: 4 });
    return { first, done, again, later };
  };

  it('names what came after the first finish, and whether a reopen preceded it', () => {
    const { first, done, again, later } = log();
    const result = review([first, done, again, later]);
    expect(result.amendments).toHaveLength(1);
    expect(result.amendments[0]).toMatchObject({ nombre: 'Ana', reabierto: true });
    expect(result.amendments[0].event.id).toBe(later.id);
  });

  it('follows the log when the log is reordered — a stored boolean would not', () => {
    // The same four events, handed over in the order a late batch would arrive
    // in. A flag written at ingest would stamp `later` post-finish in one of
    // these and not the other; position in the counter's own sequence does not
    // care which arrived first.
    const { first, done, again, later } = log();
    const arrived = review([later, again, done, first]);
    expect(arrived.amendments.map((entry) => entry.event.id)).toEqual([later.id]);

    // And an event written *before* the finish that merely arrived after it is
    // not an amendment, however late it landed.
    const early = addCount(2, 5, { counterId: 'ana', seq: 1 });
    const finished = finish(2, 'h2', { counterId: 'ana', seq: 3 });
    const other = addCount(1, 1, { counterId: 'ana', seq: 2 });
    expect(review([finished, early, other]).amendments).toEqual([]);
  });
});

describe('explicit zeros are their own list (§3c)', () => {
  it('holds exactly the standing zeros on rows with a book figure', () => {
    const zero = addCount(1, 0, { counterId: 'ana', seq: 1 });
    const alsoZero = addCount(3, 0, { counterId: 'luis', seq: 1 });
    // Item 4 is booked at zero: confirming an empty shelf empty writes nothing
    // off, so it is not on this list.
    const harmless = addCount(4, 0, { counterId: 'ana', seq: 2 });
    // Withdrawn, so it is not standing.
    const mistake = addCount(2, 0, { counterId: 'ana', seq: 3 });
    const undone = retract(2, { counterId: 'ana', seq: 4, retractsEventId: mistake.id });

    const result = review([zero, alsoZero, harmless, mistake, undone]);
    expect(result.zeros.map((entry) => entry.item.idarticulo)).toEqual([3, 1]);
    // Sorted by what each line writes off: CAVIAR is 5 000, item 1 is 1 000.
    expect(result.zeros[0].valor).toBe(5000);
    expect(result.zeros[0].nombre).toBe('Luis');
    expect(result.rows.find((row) => row.item.idarticulo === 1)!.flags).toContainEqual({
      kind: 'cero',
    });
  });
});

describe('a trailing retraction waits until the counter is done (§3d)', () => {
  const log = () => {
    const entry = addCount(1, 3, { counterId: 'ana', seq: 1 });
    const undone = retract(1, { counterId: 'ana', seq: 2, retractsEventId: entry.id });
    return [entry, undone];
  };

  it('says nothing while they are still counting — every correction passes through this', () => {
    expect(review(log(), [], [{ ...ANA, estado: 'contando' }]).trailing).toEqual([]);
  });

  it('surfaces once they are terminado_confirmado', () => {
    const result = review(log(), [], [{ ...ANA, estado: 'terminado_confirmado' }]);
    expect(result.trailing).toHaveLength(1);
    expect(result.trailing[0]).toMatchObject({ nombre: 'Ana', estado: 'terminado_confirmado' });
    expect(result.trailing[0].retirado).not.toBeNull();
    expect(result.rows.find((row) => row.item.idarticulo === 1)!.flags).toContainEqual({
      kind: 'retraccion-final',
    });
  });

  it('surfaces for a retired counter too, which is the case nobody will chase', () => {
    expect(review(log(), [], [{ ...ANA, estado: 'retirado' }]).trailing).toHaveLength(1);
  });

  it('says nothing when the withdrawal had a replacement after it', () => {
    const [entry, undone] = log();
    const replacement = addCount(1, 8, { counterId: 'ana', seq: 3 });
    const result = review(
      [entry, undone, replacement],
      [],
      [{ ...ANA, estado: 'terminado_confirmado' }],
    );
    expect(result.trailing).toEqual([]);
  });
});

describe('outliers show the arithmetic and change nothing (§3e)', () => {
  it('names an order-of-magnitude difference in either direction', () => {
    const high = review([addCount(1, 500, { counterId: 'ana' })]);
    expect(high.rows.find((row) => row.item.idarticulo === 1)!.flags).toContainEqual({
      kind: 'outlier',
      motivo: 'magnitud',
      ratio: 50,
    });
    const low = review([addCount(2, 1, { counterId: 'ana' })]);
    expect(low.rows.find((row) => row.item.idarticulo === 2)!.flags).toContainEqual({
      kind: 'outlier',
      motivo: 'magnitud',
      ratio: 0.05,
    });
  });

  it('names the case-versus-unit error, which is the classic one', () => {
    // Item 2 is booked at 20 and somebody counted 240: twelve to a case.
    const result = review([addCount(2, 240, { counterId: 'ana' })]);
    const flags = result.rows.find((row) => row.item.idarticulo === 2)!.flags;
    expect(flags).toContainEqual({
      kind: 'outlier',
      motivo: 'caja',
      factor: 12,
      ratio: 12,
      invertido: true,
    });
  });

  it('names one entry that dwarfs the rest on the same article', () => {
    const result = review([
      addCount(2, 2, { counterId: 'ana', seq: 1 }),
      addCount(2, 3, { counterId: 'ana', seq: 2 }),
      addCount(2, 500, { counterId: 'ana', seq: 3 }),
    ]);
    const flags = result.rows.find((row) => row.item.idarticulo === 2)!.flags;
    expect(flags).toContainEqual({ kind: 'outlier', motivo: 'entrada', ratio: 100 });
  });

  it('never touches a count: the events handed in come back untouched', () => {
    const events = [addCount(1, 500, { counterId: 'ana' })];
    const snapshot = JSON.stringify(events);
    const result = review(events);
    expect(JSON.stringify(events)).toBe(snapshot);
    // And the row still reports what was counted, not something corrected.
    expect(result.rows.find((row) => row.item.idarticulo === 1)!.conteo).toBe(500);
  });
});

// --- §5: notes ---------------------------------------------------------------

describe('notes (§5)', () => {
  it('groups them by counter and pulls the ones with no article into their own list', () => {
    const result = review([
      note(1, 'la caja está abollada', { counterId: 'ana', seq: 1 }),
      note(null, 'hay dos canastas sin código', { counterId: 'ana', seq: 2 }),
      note(null, 'sobra un saco de arroz', { counterId: 'luis', seq: 1 }),
    ]);
    expect(result.notes.porContador.map((group) => group.nombre)).toEqual(['Ana', 'Luis']);
    expect(result.notes.porContador[0].notas).toHaveLength(2);
    expect(result.notes.sueltas.map((entry) => entry.event.texto)).toEqual([
      'hay dos canastas sin código',
      'sobra un saco de arroz',
    ]);
    // A note asserts nothing about stock, so it never registers an article.
    expect(result.rows.find((row) => row.item.idarticulo === 1)!.state).toBe('untouched');
  });
});

// --- §6: the advisory tier ---------------------------------------------------

describe('the pre-seal checklist is advisory and priced where it can be', () => {
  it('lists what is worth a look, with the money on the two that have one', () => {
    const result = review(
      [addCount(1, 0, { counterId: 'ana', seq: 1 }), note(null, 'sin código', { counterId: 'ana', seq: 2 })],
      [],
      [ANA, LUIS],
    );
    const checklist = reviewChecklist(result);
    expect(checklist.map((entry) => entry.kind)).toEqual(['sin-contar', 'ceros', 'notas-sueltas']);
    expect(checklist.find((entry) => entry.kind === 'ceros')!.valor).toBe(1000);
  });
});

// --- P1 ----------------------------------------------------------------------

describe('a P1 session, which has no counters at all', () => {
  it('reviews without inventing an identity for events that never had one', () => {
    // P1 events carry no `counterId` (MIGRATION-P1-P2.md). Nothing here is a
    // missing lookup to be papered over: the log predates counter identity, and
    // «sin contador» is the truthful label.
    const result = reviewSession({
      sessionId: SESSION_ID,
      items: ITEMS,
      events: [addCount(1, 12), note(null, 'sobra una caja')],
      actions: [],
      counters: [],
    });
    expect(result.rows.find((row) => row.item.idarticulo === 1)).toMatchObject({
      state: 'counted',
      conteo: 12,
      contadores: ['sin contador'],
    });
    expect(result.notes.porContador[0].nombre).toBe('sin contador');
    // One counter's worth of events is not an overlap, whoever they were.
    expect(result.overlaps).toEqual([]);
    expect(result.trailing).toEqual([]);
  });
});

// --- scale -------------------------------------------------------------------

describe('scale', () => {
  it('folds 2 400 rows and 5 000 events inside a budget', () => {
    const items = Array.from({ length: 2400 }, (_, i) => item(i + 1, (i % 40) + 1, 100 + i));
    const events: CountEvent[] = [];
    for (let n = 0; n < 5000; n++) {
      events.push(
        addCount((n % 2400) + 1, (n % 7) + 1, {
          counterId: n % 2 === 0 ? 'ana' : 'luis',
          seq: Math.floor(n / 2) + 1,
          id: `ev-${n}`,
        }),
      );
    }
    const started = performance.now();
    const result = reviewSession({
      sessionId: SESSION_ID,
      items,
      events,
      actions: [],
      counters: [ANA, LUIS],
    });
    const ms = performance.now() - started;

    expect(result.rows).toHaveLength(2400);
    // Generous by an order of magnitude on purpose: this is a regression guard
    // against an accidental quadratic, not a benchmark.
    expect(ms).toBeLessThan(4000);
  });
});

/** Every ordering of a small array. Used to state a property rather than a case. */
function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  const out: T[][] = [];
  for (const [index, value] of values.entries()) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([value, ...tail]);
  }
  return out;
}
