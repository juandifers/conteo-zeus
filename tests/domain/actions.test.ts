/**
 * Counter changes after dispatch, as a pure question — P2.3.5.
 *
 * Everything here runs without a database, because everything here is a
 * decision rather than a write: what a plan resolves to, what it is refused
 * for, whose tablet is about to be handed away without knowing, and what ends
 * up printed on the acta. The transaction that makes those decisions true under
 * concurrency is `tests/backend/acciones.pg.test.ts`, against a real Postgres.
 *
 * The invariant every one of these is really about: **assignments and events
 * are separate concerns.** Reassignment moves responsibility for what is still
 * to be done. Nothing in this file moves, re-attributes or re-hashes an event,
 * and if a future one starts to, that is the bug.
 */
import { describe, expect, it } from 'vitest';

import {
  actaLines,
  handoverRisk,
  planReassignment,
  reassignBlockers,
  sealOverrides,
  type Assignment,
  type ReassignInput,
  type Section,
  type SessionActionRecord,
} from '../../src/domain';

const ANA = 'counter-ana';
const LUIS = 'counter-luis';
const PEDRO = 'counter-pedro';

/**
 * Two counters, three sections, six articles.
 *
 * Luis holds a whole section (the swap case) and half of another (the
 * rebalance), which is the smallest fixture in which the two motions differ.
 */
const SECTIONS: Section[] = [
  { id: 'sec-almacen', nombre: 'ALMACEN', counterId: LUIS },
  { id: 'sec-nevera', nombre: 'NEVERA', counterId: LUIS },
  { id: 'sec-bar', nombre: 'BAR', counterId: ANA },
];

const ASSIGNMENTS: Assignment[] = [
  { idarticulo: 1, counterId: LUIS, sectionId: 'sec-almacen' },
  { idarticulo: 2, counterId: LUIS, sectionId: 'sec-almacen' },
  { idarticulo: 3, counterId: LUIS, sectionId: 'sec-nevera' },
  { idarticulo: 4, counterId: LUIS, sectionId: 'sec-nevera' },
  { idarticulo: 5, counterId: ANA, sectionId: 'sec-bar' },
  { idarticulo: 6, counterId: ANA, sectionId: 'sec-bar' },
];

const ITEMS = [1, 2, 3, 4, 5, 6].map((idarticulo) => ({ idarticulo }));

const COUNTERS = [
  { id: ANA, nombre: 'Ana', estado: 'contando' },
  { id: LUIS, nombre: 'Luis', estado: 'contando' },
  { id: PEDRO, nombre: 'Pedro', estado: 'asignado' },
];

function ids(prefix = 'new') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function input(over: Partial<ReassignInput> = {}): ReassignInput {
  return {
    estado: 'abierto',
    items: ITEMS,
    counters: COUNTERS,
    sections: SECTIONS,
    assignments: ASSIGNMENTS,
    moves: [],
    motivo: 'Luis se fue enfermo',
    newId: ids(),
    ...over,
  };
}

describe('planning a reassignment', () => {
  it('repoints a whole section rather than inventing a second name for one shelf', () => {
    // The swap. Pedro counting Luis's ALMACEN is standing in ALMACEN, and
    // `Section.nombre` **is** `zona` (P2.1 §3c) — a new section would put two
    // zones on one place in the acta for no reason anybody could reconstruct.
    const plan = planReassignment(
      input({
        moves: [
          { idarticulo: 1, from: LUIS, to: PEDRO },
          { idarticulo: 2, from: LUIS, to: PEDRO },
        ],
      }),
    );

    expect(plan.createSections).toEqual([]);
    expect(plan.repointSections).toEqual([
      { id: 'sec-almacen', nombre: 'ALMACEN', from: LUIS, to: PEDRO },
    ]);
    expect(plan.moves.every((move) => move.sectionId === 'sec-almacen')).toBe(true);
    expect(plan.coverage.complete).toBe(true);
  });

  it('splits a section when only part of it moves, and names the new one after both', () => {
    // The rebalance. `sections` is unique on `(session_id, nombre)` and the
    // original name is still held by the articles that stayed, so the new one
    // has to be a different string — and the string that is useful afterwards
    // names the shelf and the person.
    const plan = planReassignment(
      input({ moves: [{ idarticulo: 3, from: LUIS, to: ANA }] }),
    );

    expect(plan.repointSections).toEqual([]);
    expect(plan.createSections).toEqual([
      { id: 'new-1', nombre: 'NEVERA · Ana', counterId: ANA },
    ]);
    expect(plan.moves).toEqual([
      { idarticulo: 3, from: LUIS, to: ANA, sectionId: 'new-1' },
    ]);
    // The article that stayed keeps its section, so its zone is unchanged.
    expect(plan.coverage.complete).toBe(true);
  });

  it('reuses the section it already made, rather than growing a numbered family', () => {
    const sections = [
      ...SECTIONS,
      { id: 'sec-split', nombre: 'NEVERA · Ana', counterId: ANA },
    ];
    const plan = planReassignment(
      input({ sections, moves: [{ idarticulo: 3, from: LUIS, to: ANA }] }),
    );
    expect(plan.createSections).toEqual([]);
    expect(plan.moves[0].sectionId).toBe('sec-split');
  });

  it('steps around a name somebody else is holding instead of colliding with it', () => {
    // `unique (session_id, nombre)` would refuse this with a message no admin
    // can read. Two zones with one name are also two places nobody can separate
    // afterwards, which is the reason the constraint exists.
    const sections = [
      ...SECTIONS,
      { id: 'sec-taken', nombre: 'NEVERA · Ana', counterId: PEDRO },
    ];
    const plan = planReassignment(
      input({ sections, moves: [{ idarticulo: 3, from: LUIS, to: ANA }] }),
    );
    expect(plan.createSections[0].nombre).toBe('NEVERA · Ana (2)');
  });

  it('mints a counter and their work in one plan — nobody arrives empty-handed', () => {
    // P2.1 leaves nothing unassigned, so «metamos a Carla» is not a counter
    // followed by a reassignment: it is one operation, or Carla stands in the
    // bodega with a link and no shelves.
    const plan = planReassignment(
      input({
        nuevos: [{ ref: 'carla', nombre: 'Carla' }],
        moves: [
          { idarticulo: 5, from: ANA, to: 'carla' },
          { idarticulo: 6, from: ANA, to: 'carla' },
        ],
      }),
    );
    expect(plan.counters).toEqual([{ id: 'new-1', nombre: 'Carla', ref: 'carla' }]);
    expect(plan.repointSections).toEqual([
      { id: 'sec-bar', nombre: 'BAR', from: ANA, to: 'new-1' },
    ]);
    expect(plan.moves.every((move) => move.to === 'new-1')).toBe(true);
  });

  it('honours a destination section the admin named', () => {
    const plan = planReassignment(
      input({ moves: [{ idarticulo: 3, from: LUIS, to: ANA, seccion: 'NEVERA GRANDE' }] }),
    );
    expect(plan.createSections).toEqual([
      { id: 'new-1', nombre: 'NEVERA GRANDE', counterId: ANA },
    ]);
  });

  it('leaves coverage exactly as it found it', () => {
    // Moves preserve coverage by construction, and the check is still what
    // catches the bug in whatever generated them (§4a).
    const plan = planReassignment(
      input({
        moves: ASSIGNMENTS.filter((a) => a.counterId === LUIS).map((a) => ({
          idarticulo: a.idarticulo,
          from: LUIS,
          to: PEDRO,
        })),
      }),
    );
    expect(plan.coverage).toEqual({
      assigned: 6,
      unassigned: [],
      duplicated: [],
      foreign: [],
      complete: true,
    });
  });
});

describe('what a reassignment is refused for', () => {
  it('refuses a stale plan rather than silently overwriting somebody else’s move', () => {
    // The admin's browser tab is ten minutes old and still believes Luis holds
    // article 5. Overwriting would hand Ana's shelf to Pedro on the strength of
    // a screen nobody had looked at since.
    const blockers = reassignBlockers(
      input({ moves: [{ idarticulo: 5, from: LUIS, to: PEDRO }] }),
    );
    expect(blockers).toContainEqual({
      kind: 'origen-no-tiene',
      movimientos: [{ idarticulo: 5, from: LUIS }],
    });
  });

  it('refuses a retired destination', () => {
    const counters = COUNTERS.map((counter) =>
      counter.id === PEDRO ? { ...counter, estado: 'retirado' } : counter,
    );
    expect(
      reassignBlockers(input({ counters, moves: [{ idarticulo: 1, from: LUIS, to: PEDRO }] })),
    ).toContainEqual({ kind: 'destino-retirado', counterIds: [PEDRO] });
  });

  it('refuses a session that is no longer being counted', () => {
    expect(
      reassignBlockers(
        input({ estado: 'sellado', moves: [{ idarticulo: 1, from: LUIS, to: PEDRO }] }),
      ),
    ).toContainEqual({ kind: 'estado', estado: 'sellado' });
  });

  it('allows one in `revision`, because that is when a gap gets found', () => {
    // The consequence is deliberate: the session can move backwards from
    // «everyone finished», and a counter who was `terminado_confirmado` can be
    // handed work and reopen. «Todos terminaron» is not final until the seal.
    expect(
      reassignBlockers(
        input({ estado: 'revision', moves: [{ idarticulo: 1, from: LUIS, to: PEDRO }] }),
      ),
    ).toEqual([]);
  });

  it('refuses a move with no reason on it', () => {
    // Why a particular article changed hands is not reconstructible from a diff
    // of two assignment tables, and it is the first thing anybody asks
    // afterwards.
    expect(
      reassignBlockers(
        input({ motivo: '   ', moves: [{ idarticulo: 1, from: LUIS, to: PEDRO }] }),
      ),
    ).toContainEqual({ kind: 'sin-motivo' });
  });

  it('refuses an article moved twice, an article to its own holder, and an unknown one', () => {
    const blockers = reassignBlockers(
      input({
        moves: [
          { idarticulo: 1, from: LUIS, to: PEDRO },
          { idarticulo: 1, from: LUIS, to: ANA },
          { idarticulo: 5, from: ANA, to: ANA },
          { idarticulo: 99, from: LUIS, to: PEDRO },
        ],
      }),
    );
    expect(blockers).toContainEqual({ kind: 'articulo-repetido', idarticulos: [1] });
    expect(blockers).toContainEqual({ kind: 'mismo-contador', idarticulos: [5] });
    expect(blockers).toContainEqual({ kind: 'articulo-desconocido', idarticulos: [99] });
  });

  it('refuses a second counter with a name somebody already has', () => {
    // Two counters called "Ana" on one printed sheet are two people nobody can
    // tell apart when a chain turns out to have a gap in it.
    expect(
      reassignBlockers(
        input({
          nuevos: [{ ref: 'x', nombre: 'Ana' }],
          moves: [{ idarticulo: 1, from: LUIS, to: 'x' }],
        }),
      ),
    ).toContainEqual({ kind: 'nombre-repetido', nombres: ['Ana'] });
  });

  it('returns every reason at once rather than the first', () => {
    // An admin who fixes the stale row and is then told about the retired
    // destination has been made to walk the same screen twice for nothing.
    const blockers = reassignBlockers(input({ motivo: '', moves: [] }));
    expect(blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'sin-motivo',
      'sin-movimientos',
    ]);
  });

  it('accepts a plan that is actually fine', () => {
    expect(
      reassignBlockers(input({ moves: [{ idarticulo: 1, from: LUIS, to: PEDRO }] })),
    ).toEqual([]);
  });
});

describe('the hole that cannot be closed (§4b)', () => {
  const NOW = '2026-08-31T11:00:00.000Z';
  const counters = [
    { id: LUIS, nombre: 'Luis', lastServerAt: '2026-08-31T10:14:00.000Z' },
    { id: ANA, nombre: 'Ana', lastServerAt: '2026-08-31T10:58:00.000Z' },
    { id: PEDRO, nombre: 'Pedro', lastServerAt: null },
  ];

  it('names the counter whose tablet has not been heard from, and when', () => {
    // Luis is in the cold room. His articles are being handed to Pedro; his
    // tablet does not know and cannot know. If he keeps counting, the fold sums
    // both — a real double count that **nothing** here can prevent, because
    // prevention means reaching an unreachable device.
    const risks = handoverRisk({
      counters,
      moves: [
        { idarticulo: 1, from: LUIS, to: PEDRO },
        { idarticulo: 2, from: LUIS, to: PEDRO },
      ],
      now: NOW,
    });
    expect(risks).toEqual([
      {
        counterId: LUIS,
        nombre: 'Luis',
        lastServerAt: '2026-08-31T10:14:00.000Z',
        articulos: 2,
      },
    ]);
  });

  it('says nothing about a counter who synced two minutes ago', () => {
    expect(handoverRisk({ counters, moves: [{ idarticulo: 5, from: ANA, to: LUIS }], now: NOW }))
      .toEqual([]);
  });

  it('treats never-synced the same as long-silent, because it means the same thing', () => {
    const risks = handoverRisk({
      counters,
      moves: [{ idarticulo: 1, from: PEDRO, to: ANA }],
      now: NOW,
    });
    expect(risks).toHaveLength(1);
    expect(risks[0].lastServerAt).toBeNull();
  });

  it('is silent about counters nothing was taken from', () => {
    // The warning is about work being moved *away*, not about who is quiet.
    expect(handoverRisk({ counters, moves: [], now: NOW })).toEqual([]);
  });
});

describe('what reaches the acta', () => {
  const at = '2026-08-31T11:00:00.000Z';
  const record = (
    seq: number,
    kind: SessionActionRecord['kind'],
    payload: unknown,
    usuario = 'Marta',
  ): SessionActionRecord =>
    ({
      id: `a${seq}`,
      sessionId: 'sesion-1',
      seq,
      kind,
      payload,
      usuario,
      at,
      serverAt: at,
      prevHash: 'p',
      hash: 'h',
    }) as SessionActionRecord;

  const acciones = [
    record(1, 'agregar_contador', {
      counterId: PEDRO,
      nombre: 'Pedro',
      motivo: 'reemplaza a Luis',
    }),
    record(2, 'reasignar', {
      motivo: 'Luis se fue enfermo',
      movimientos: [{ idarticulo: 1, from: LUIS, to: PEDRO, sectionId: 'sec-almacen' }],
      seccionesCreadas: [],
      seccionesReapuntadas: [],
      sinSincronizar: [
        { counterId: LUIS, nombre: 'Luis', lastServerAt: '2026-08-31T10:14:00.000Z', articulos: 1 },
      ],
    }),
    record(3, 'retirar_contador', { counterId: LUIS, nombre: 'Luis', motivo: 'se fue enfermo' }),
    record(4, 'sellar_sin_registros', {
      counterId: LUIS,
      nombre: 'Luis',
      motivo: 'la tableta se fue en el bolsillo y no volvió',
      faltan: '61–83',
      storedMaxSeq: 90,
    }),
  ];

  it('prints the missing range with a name on it, not a footnote', () => {
    // The whole value of the sealing gate is that it cannot be satisfied by
    // assertion. When it *is* stepped around, the step is on the page.
    const lines = actaLines(acciones);
    expect(lines[3]).toContain('ESTE CONTEO SE SELLÓ SIN LOS REGISTROS DE Luis');
    expect(lines[3]).toContain('61–83');
    expect(lines[3]).toContain('Marta');
    expect(lines[3]).toContain('la tableta se fue en el bolsillo');
  });

  it('names who was added, who was retired, and what moved — with the reasons', () => {
    const lines = actaLines(acciones);
    expect(lines[0]).toContain('Se agregó a Pedro');
    expect(lines[0]).toContain('reemplaza a Luis');
    expect(lines[1]).toContain('Se reasignaron 1 artículos');
    expect(lines[2]).toContain('Se retiró a Luis');
  });

  it('carries the mid-count risk onto the acta, so an overlap arrives explained', () => {
    expect(actaLines(acciones)[1]).toContain('sin sincronizar al momento del cambio: Luis');
  });

  it('reads the log in sequence order, whatever order it is handed in', () => {
    const shuffled = [acciones[2], acciones[0], acciones[3], acciones[1]];
    expect(actaLines(shuffled)).toEqual(actaLines(acciones));
  });

  it('derives the seal overrides from the log rather than from a flag on a row', () => {
    // A flag on `counters` would be a second copy of a fact the chain already
    // carries — and a state an admin could reach by editing a row, which is
    // exactly what the sealing gate exists to make impossible.
    const overrides = sealOverrides(acciones);
    expect(overrides.get(LUIS)?.faltan).toBe('61–83');
    expect(overrides.has(ANA)).toBe(false);
  });
});
