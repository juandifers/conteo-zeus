/**
 * The partition the admin builds, as data.
 *
 * Worth testing apart from the screen because the same structure is asked the
 * same questions on both sides of the network: `planState` runs
 * `dispatchBlockers` in the browser so the admin sees the refusal before
 * pressing anything, and `dispatchBody` is what the server then re-checks.
 */
import { describe, expect, it } from 'vitest';

import {
  asDomain,
  chunk,
  countersIn,
  dispatchBody,
  EMPTY_PLAN,
  move,
  newSectionId,
  planState,
  type Plan,
} from '../../src/ui/admin/plan';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import { readSample, SAMPLE_XLS } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));
const SERVER = { estado: 'borrador', archivoIntacto: true, parametrosVerificados: true };

function planOf(sections: Plan['sections'], asignado: Record<number, string> = {}): Plan {
  return { ...EMPTY_PLAN, sections, asignado };
}

describe('chunk', () => {
  it('splits contiguously, in catalogue order', () => {
    // Not round-robin: the order is roughly shelf order, and dealing every
    // third row to a different person sends three people down one aisle.
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('drops the parts there is nothing left for', () => {
    expect(chunk([1, 2], 5)).toEqual([[1], [2]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('countersIn', () => {
  it('is the distinct names, in the order the sections introduce them', () => {
    const plan = planOf([
      { id: 's1', nombre: 'A', counterNombre: 'Ana' },
      { id: 's2', nombre: 'B', counterNombre: 'Luis' },
      { id: 's3', nombre: 'C', counterNombre: 'Ana' },
    ]);
    expect(countersIn(plan)).toEqual(['Ana', 'Luis']);
  });

  it('ignores a section nobody is holding yet', () => {
    expect(countersIn(planOf([{ id: 's1', nombre: 'A', counterNombre: '  ' }]))).toEqual([]);
  });
});

describe('move', () => {
  it('assigns and unassigns without touching anything else', () => {
    const plan = planOf([{ id: 's1', nombre: 'A', counterNombre: 'Ana' }], { 1: 's1', 2: 's1' });
    expect(move(plan, [3], 's1').asignado).toEqual({ 1: 's1', 2: 's1', 3: 's1' });
    expect(move(plan, [1], null).asignado).toEqual({ 2: 's1' });
  });
});

describe('newSectionId', () => {
  it('does not collide with a section already in the plan', () => {
    const plan = planOf([
      { id: 's1', nombre: 'A', counterNombre: '' },
      { id: 's2', nombre: 'B', counterNombre: '' },
    ]);
    expect(newSectionId(plan)).toBe('s3');
  });
});

describe('asDomain', () => {
  it('keys counters on their name, which is what dispatch will mint ids for', () => {
    const plan = planOf(
      [
        { id: 's1', nombre: 'ALMACEN', counterNombre: 'Ana' },
        { id: 's2', nombre: 'NEVERA', counterNombre: 'Ana' },
      ],
      { 1: 's1', 2: 's2' },
    );
    const domain = asDomain(plan);
    expect(domain.counters.map((counter) => counter.id)).toEqual(['Ana']);
    expect(domain.assignments).toEqual([
      { idarticulo: 1, counterId: 'Ana', sectionId: 's1' },
      { idarticulo: 2, counterId: 'Ana', sectionId: 's2' },
    ]);
  });

  it('drops an assignment whose section has been removed, so it reads as a gap', () => {
    // Which is what it is. A reference nobody can resolve would instead be a
    // blocker about an unknown section, and the honest reading is "nobody is
    // counting this".
    const plan = planOf([{ id: 's1', nombre: 'A', counterNombre: 'Ana' }], { 1: 's1', 2: 'borrada' });
    expect(asDomain(plan).assignments.map((a) => a.idarticulo)).toEqual([1]);
  });
});

describe('planState', () => {
  it('asks the same questions the server will, over the real catalogue', () => {
    const empty = planState(catalogue, EMPTY_PLAN, SERVER);
    expect(empty.coverage.complete).toBe(false);
    expect(empty.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'sin-asignar',
      'sin-contadores',
    ]);
    expect(empty.huecos.map((hueco) => hueco.prefix)).toContain('11');
  });

  it('clears once every article has exactly one owner', () => {
    const plan = planOf(
      [{ id: 's1', nombre: 'TODO', counterNombre: 'Ana' }],
      Object.fromEntries(catalogue.map((item) => [item.idarticulo, 's1'])),
    );
    expect(planState(catalogue, plan, SERVER).blockers).toEqual([]);
  });

  it('carries the server’s two answers through, because the browser cannot know them', () => {
    const plan = planOf(
      [{ id: 's1', nombre: 'TODO', counterNombre: 'Ana' }],
      Object.fromEntries(catalogue.map((item) => [item.idarticulo, 's1'])),
    );
    const state = planState(catalogue, plan, {
      estado: 'borrador',
      archivoIntacto: false,
      parametrosVerificados: false,
    });
    expect(state.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'archivo-cambiado',
      'parametros-sin-verificar',
    ]);
  });
});

describe('dispatchBody', () => {
  it('groups sections under the counter holding them', () => {
    const plan = planOf(
      [
        { id: 's1', nombre: 'ALMACEN', counterNombre: 'Ana' },
        { id: 's2', nombre: 'NEVERA', counterNombre: 'Ana' },
        { id: 's3', nombre: 'BAR', counterNombre: 'Luis' },
      ],
      { 10: 's1', 20: 's2', 30: 's3', 40: 's1' },
    );
    expect(dispatchBody(plan)).toEqual({
      counters: [
        {
          nombre: 'Ana',
          secciones: [
            { nombre: 'ALMACEN', idarticulos: [10, 40] },
            { nombre: 'NEVERA', idarticulos: [20] },
          ],
        },
        { nombre: 'Luis', secciones: [{ nombre: 'BAR', idarticulos: [30] }] },
      ],
    });
  });

  it('sends the resolved article list, never the rule that produced it', () => {
    // A rule re-evaluated later against a changed catalogue is a silent
    // reassignment nobody authorised.
    const plan = planOf(
      [{ id: 's1', nombre: 'TODO', counterNombre: 'Ana' }],
      Object.fromEntries(catalogue.map((item) => [item.idarticulo, 's1'])),
    );
    const body = dispatchBody(plan);
    expect(body.counters[0].secciones[0].idarticulos).toHaveLength(catalogue.length);
    expect(JSON.stringify(body)).not.toMatch(/prefix|familia|regla/);
  });
});
