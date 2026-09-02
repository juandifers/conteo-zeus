// @vitest-environment jsdom
/**
 * The plan the admin builds — since P2.6, the roster — as data.
 *
 * Worth testing apart from the screen because the same structure is asked the
 * same questions on both sides of the network: `planState` runs
 * `sharedDispatchBlockers` in the browser so the admin sees the refusal before
 * pressing anything, and `dispatchBody` is what the server then re-checks.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  dispatchBody,
  EMPTY_PLAN,
  loadPlan,
  planState,
  savePlan,
} from '../../src/ui/admin/plan';

const SERVER = { estado: 'borrador', archivoIntacto: true, parametrosVerificados: true };

afterEach(() => {
  globalThis.localStorage?.clear();
});

describe('planState', () => {
  it('asks the same questions the server will', () => {
    const empty = planState(EMPTY_PLAN, SERVER);
    expect(empty.blockers.map((blocker) => blocker.kind)).toEqual(['sin-contadores']);
  });

  it('clears once anybody at all is on the roster', () => {
    // The shared dispatch has no coverage to complete: the whole catalogue
    // goes to everybody, so one name is a dispatchable count.
    expect(planState({ roster: ['Ana'] }, SERVER).blockers).toEqual([]);
  });

  it('carries the server’s two answers through, because the browser cannot know them', () => {
    const state = planState(
      { roster: ['Ana'] },
      { estado: 'borrador', archivoIntacto: false, parametrosVerificados: false },
    );
    expect(state.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'archivo-cambiado',
      'parametros-sin-verificar',
    ]);
  });
});

describe('dispatchBody', () => {
  it('sends names and nothing else — no secciones key on any counter', () => {
    // The absence of `secciones` is what tells the server this is the shared
    // mode, so a stray key here would silently ask for the sectioned one.
    const body = dispatchBody({ roster: ['Ana', 'Luis'] });
    expect(body).toEqual({ counters: [{ nombre: 'Ana' }, { nombre: 'Luis' }] });
    expect(JSON.stringify(body)).not.toMatch(/secciones|idarticulos/);
  });
});

describe('loadPlan', () => {
  it('folds a sectioned draft’s counters into the roster', () => {
    // A draft saved by the pre-P2.6 planner keeps its people: some on the
    // stored roster, some only named inside sections.
    globalThis.localStorage?.setItem(
      'conteo.reparto.vieja',
      JSON.stringify({
        roster: ['Ana'],
        sections: [
          { id: 's1', nombre: 'ALMACEN', counterNombre: 'Luis' },
          { id: 's2', nombre: 'NEVERA', counterNombre: 'Ana' },
          { id: 's3', nombre: 'BAR', counterNombre: '  ' },
        ],
        asignado: { 10: 's1' },
      }),
    );
    expect(loadPlan('vieja')).toEqual({ roster: ['Ana', 'Luis'] });
  });

  it('survives a corrupt draft by starting over', () => {
    globalThis.localStorage?.setItem('conteo.reparto.rota', '{nope');
    expect(loadPlan('rota')).toEqual(EMPTY_PLAN);
  });

  it('round-trips through savePlan', () => {
    savePlan('s', { roster: ['Ana', 'Luis'] });
    expect(loadPlan('s')).toEqual({ roster: ['Ana', 'Luis'] });
  });
});
