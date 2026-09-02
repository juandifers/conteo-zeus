/**
 * Coverage as a gate, and everything that stands in front of `abierto`.
 *
 * The rule under test is the one the jefe de costos cannot bend: every article
 * in the catalogue is assigned to exactly one counter, or nothing is
 * dispatched. Not "warned about" — a bodega dispatched with a gap is a shelf
 * nobody walks to, discovered when the variance report says the stock is zero.
 */
import { describe, expect, it } from 'vitest';

import {
  assignmentCoverage,
  dispatchBlockers,
  sharedDispatchBlockers,
  sharedScope,
  unassignedByFamily,
  type Assignment,
  type Counter,
  type DispatchInput,
  type Item,
  type Section,
} from '../../src/domain';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import { readSample, SAMPLE_XLS } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));

function counter(id: string, nombre = id): Counter {
  return { id, nombre, token: `token-${id}`, estado: 'asignado', fetchedAt: null };
}

function section(id: string, counterId: string | null, nombre = id): Section {
  return { id, nombre, counterId };
}

function assign(items: readonly Item[], counterId: string, sectionId: string): Assignment[] {
  return items.map((item) => ({ idarticulo: item.idarticulo, counterId, sectionId }));
}

/** The whole catalogue split cleanly in two, which is the shape dispatch expects. */
function wholeCatalogue(): { counters: Counter[]; sections: Section[]; assignments: Assignment[] } {
  const half = Math.floor(catalogue.length / 2);
  return {
    counters: [counter('ana'), counter('luis')],
    sections: [section('s1', 'ana', 'ALMACEN'), section('s2', 'luis', 'NEVERA')],
    assignments: [
      ...assign(catalogue.slice(0, half), 'ana', 's1'),
      ...assign(catalogue.slice(half), 'luis', 's2'),
    ],
  };
}

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  const plan = wholeCatalogue();
  return {
    estado: 'borrador',
    items: catalogue,
    counters: plan.counters,
    sections: plan.sections,
    assignments: plan.assignments,
    archivoIntacto: true,
    parametrosVerificados: true,
    ...over,
  };
}

describe('assignmentCoverage', () => {
  it('is complete when every article is held exactly once', () => {
    const plan = wholeCatalogue();
    const coverage = assignmentCoverage(catalogue, plan.assignments);
    expect(coverage.complete).toBe(true);
    expect(coverage.assigned).toBe(catalogue.length);
    expect(coverage.unassigned).toEqual([]);
    expect(coverage.duplicated).toEqual([]);
    expect(coverage.foreign).toEqual([]);
  });

  it('names the gap rather than counting it', () => {
    // "23 sin asignar" is not something an admin can act on at six on cutoff
    // day. The ids are what turns it into a place to go.
    const plan = wholeCatalogue();
    const dropped = new Set([catalogue[3].idarticulo, catalogue[200].idarticulo]);
    const coverage = assignmentCoverage(
      catalogue,
      plan.assignments.filter((a) => !dropped.has(a.idarticulo)),
    );
    expect(coverage.complete).toBe(false);
    expect(coverage.unassigned).toEqual([catalogue[3].idarticulo, catalogue[200].idarticulo]);
    expect(coverage.assigned).toBe(catalogue.length - 2);
  });

  it('reports the gap in catalogue order, which is shelf order', () => {
    const coverage = assignmentCoverage(catalogue, []);
    expect(coverage.unassigned).toEqual(catalogue.map((item) => item.idarticulo));
  });

  it('treats two counters on one article as a duplication, not as coverage', () => {
    const plan = wholeCatalogue();
    const target = catalogue[10].idarticulo;
    const coverage = assignmentCoverage(catalogue, [
      ...plan.assignments,
      { idarticulo: target, counterId: 'luis', sectionId: 's2' },
    ]);
    expect(coverage.complete).toBe(false);
    expect(coverage.duplicated).toEqual([{ idarticulo: target, counterIds: ['ana', 'luis'] }]);
    // And it is not also counted as assigned.
    expect(coverage.assigned).toBe(catalogue.length - 1);
  });

  it('does not mistake the same fact stated twice for a disagreement', () => {
    // One counter, two rows, one article — through two sections, which the
    // admin can produce by dragging a family in and then a stray article. It
    // is one assignment restated, and nobody is going to count it twice.
    const plan = wholeCatalogue();
    const target = catalogue[10].idarticulo;
    const coverage = assignmentCoverage(catalogue, [
      ...plan.assignments,
      { idarticulo: target, counterId: 'ana', sectionId: 's1' },
    ]);
    expect(coverage.complete).toBe(true);
    expect(coverage.duplicated).toEqual([]);
  });

  it('flags an article that is not in this catalogue at all', () => {
    const plan = wholeCatalogue();
    const coverage = assignmentCoverage(catalogue, [
      ...plan.assignments,
      { idarticulo: 999999, counterId: 'ana', sectionId: 's1' },
    ]);
    expect(coverage.foreign).toEqual([999999]);
    expect(coverage.complete).toBe(false);
  });
});

describe('unassignedByFamily', () => {
  it('groups the gap and ranks it by exposure, not by book value', () => {
    // The produce family is 54 rows of which 31 are booked at zero. Ranked on
    // `valor` it would report as nearly worthless — which is the exact §5 trap
    // this ordering exists to avoid.
    const coverage = assignmentCoverage(catalogue, []);
    const gaps = unassignedByFamily(catalogue, coverage);
    expect(gaps.map((gap) => gap.prefix)).toContain('11');
    expect(gaps.reduce((total, gap) => total + gap.rows, 0)).toBe(catalogue.length);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].exposicion).toBeGreaterThanOrEqual(gaps[i].exposicion);
    }
  });

  it('is empty when nothing is missing', () => {
    const plan = wholeCatalogue();
    expect(unassignedByFamily(catalogue, assignmentCoverage(catalogue, plan.assignments))).toEqual(
      [],
    );
  });
});

describe('dispatchBlockers', () => {
  it('clears a complete plan on a verified session', () => {
    expect(dispatchBlockers(input())).toEqual([]);
  });

  it('reports every blocker at once, not the first one', () => {
    // An admin who fixes the coverage gap and is then told about the counter
    // with no articles has walked the same screen twice for no reason.
    const blockers = dispatchBlockers(
      input({
        counters: [counter('ana'), counter('luis'), counter('sin-nada')],
        assignments: assign(catalogue.slice(0, 5), 'ana', 's1'),
        archivoIntacto: false,
        parametrosVerificados: false,
      }),
    );
    const kinds = blockers.map((blocker) => blocker.kind).sort();
    expect(kinds).toEqual(
      ['archivo-cambiado', 'contador-vacio', 'parametros-sin-verificar', 'sin-asignar'].sort(),
    );
  });

  it('refuses a session that is not a draft', () => {
    // `borrador -> abierto` is the only transition P2.1 implements, and
    // dispatching an already-open session would re-mint every token under the
    // counters holding the old links.
    const blockers = dispatchBlockers(input({ estado: 'abierto' }));
    expect(blockers).toContainEqual({ kind: 'estado', estado: 'abierto' });
  });

  it('refuses when there are no counters', () => {
    expect(dispatchBlockers(input({ counters: [], sections: [], assignments: [] }))).toContainEqual(
      { kind: 'sin-contadores' },
    );
  });

  it('refuses when a counter holds no article, even holding a named section', () => {
    const plan = wholeCatalogue();
    const blockers = dispatchBlockers(
      input({
        counters: [...plan.counters, counter('marta')],
        sections: [...plan.sections, section('s3', 'marta', 'BAR')],
      }),
    );
    expect(blockers).toContainEqual({ kind: 'contador-vacio', counterIds: ['marta'] });
  });

  it('refuses a section nobody holds', () => {
    const blockers = dispatchBlockers(
      input({ sections: [section('s1', 'ana'), section('s2', null)] }),
    );
    expect(blockers).toContainEqual({ kind: 'seccion-sin-contador', sectionIds: ['s2'] });
  });

  it('refuses a plan naming a counter or a section that does not exist', () => {
    const blockers = dispatchBlockers(
      input({
        assignments: [
          ...assign(catalogue.slice(0, 150), 'ana', 's1'),
          ...assign(catalogue.slice(150), 'fantasma', 's9'),
        ],
      }),
    );
    expect(blockers).toContainEqual({ kind: 'contador-desconocido', counterIds: ['fantasma'] });
    expect(blockers).toContainEqual({ kind: 'seccion-desconocida', sectionIds: ['s9'] });
  });

  it('refuses double assignment — in the application, and not in the schema', () => {
    // `assignments`' primary key permits several counters per article on
    // purpose: blind double-counting is a real audit technique and the schema
    // should not foreclose it. P2 does not have that feature, so the check
    // lives here where it can be lifted deliberately rather than discovered.
    const plan = wholeCatalogue();
    const target = catalogue[0].idarticulo;
    const blockers = dispatchBlockers(
      input({
        assignments: [...plan.assignments, { idarticulo: target, counterId: 'luis', sectionId: 's2' }],
      }),
    );
    expect(blockers).toContainEqual({ kind: 'doble-asignacion', idarticulos: [target] });
  });

  it('refuses a session whose file no longer hashes to what it was imported as', () => {
    expect(dispatchBlockers(input({ archivoIntacto: false }))).toContainEqual({
      kind: 'archivo-cambiado',
    });
  });

  it('refuses untested posting parameters, so choosing them is an act', () => {
    expect(dispatchBlockers(input({ parametrosVerificados: false }))).toContainEqual({
      kind: 'parametros-sin-verificar',
    });
  });

  it('names every unassigned article, not a count of them', () => {
    const blockers = dispatchBlockers(input({ assignments: [] }));
    const gap = blockers.find((blocker) => blocker.kind === 'sin-asignar');
    expect(gap).toBeDefined();
    expect(gap!.kind === 'sin-asignar' && gap!.idarticulos).toHaveLength(catalogue.length);
  });
});

describe('sharedDispatchBlockers (P2.6)', () => {
  const SHARED = {
    estado: 'borrador' as const,
    counters: [{ id: 'ana', nombre: 'Ana' }],
    archivoIntacto: true,
    parametrosVerificados: true,
  };

  it('gates on the session, never on a partition: one name is dispatchable', () => {
    expect(sharedDispatchBlockers(SHARED)).toEqual([]);
  });

  it('still refuses everything that is about the session itself', () => {
    const blockers = sharedDispatchBlockers({
      ...SHARED,
      estado: 'abierto',
      counters: [],
      archivoIntacto: false,
      parametrosVerificados: false,
    });
    expect(blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'archivo-cambiado',
      'estado',
      'parametros-sin-verificar',
      'sin-contadores',
    ]);
  });
});

describe('sharedScope (P2.6)', () => {
  it('hands one counter the whole catalogue as one constant section', () => {
    const items = [{ idarticulo: 3 }, { idarticulo: 1 }, { idarticulo: 2 }];
    const scope = sharedScope('ana', items);
    expect(scope.sections).toEqual([{ id: 'todo', nombre: 'BODEGA', counterId: 'ana' }]);
    // Catalogue order preserved: the shelf and the printed list share it.
    expect(scope.assignments.map((assignment) => assignment.idarticulo)).toEqual([3, 1, 2]);
    expect(scope.assignments.every((assignment) => assignment.counterId === 'ana')).toBe(true);
  });
});
