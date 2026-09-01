/**
 * The leak test.
 *
 * Not a shape test. A shape test asserts the fields it happens to name and says
 * nothing about the one somebody added last week — and the field somebody adds
 * last week is exactly how `existencia` reaches a counting screen. So this
 * walks the serialised payload and asserts the key set at every level of
 * nesting **equals** the allowlist, and then asserts separately that no value
 * anywhere in an article equals that article's book quantity or cost.
 *
 * Both assertions, because they catch different mistakes: the first catches a
 * new field, the second catches an old field under a new name.
 */
import { describe, expect, it } from 'vitest';

import {
  COUNTER_COUNTER_FIELDS,
  COUNTER_ITEM_FIELDS,
  COUNTER_PAYLOAD_FIELDS,
  COUNTER_SECTION_FIELDS,
  COUNTER_SESSION_FIELDS,
  NEVER_SENT_TO_A_COUNTER,
  counterPayload,
  type Assignment,
  type Counter,
  type CounterPayload,
  type Section,
} from '../../src/domain';
import { toItems } from '../../src/app';
import { parseXls } from '../../src/zeus';
import { readSample, SAMPLE_XLS } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));

const ANA: Counter = {
  id: 'ana',
  nombre: 'Ana Rodríguez',
  token: 'aaaaaaaaaaaaaaaaaaaaaa',
  estado: 'asignado',
  fetchedAt: null,
};
const LUIS: Counter = { ...ANA, id: 'luis', nombre: 'Luis', token: 'bbbbbbbbbbbbbbbbbbbbbb' };

const SESSION = {
  id: 'session-1',
  bodega: '01',
  fechaCorte: '2025/04/30',
  nombre: 'Corte abril',
  mostrarMarcaRegistrado: true,
};

const sections: Section[] = [
  { id: 's1', nombre: 'ALMACEN', counterId: 'ana' },
  { id: 's2', nombre: 'NEVERA', counterId: 'ana' },
  { id: 's3', nombre: 'BAR', counterId: 'luis' },
];

const anaAlmacen = catalogue.slice(0, 40);
const anaNevera = catalogue.slice(40, 60);
const luisBar = catalogue.slice(60);

const assignments: Assignment[] = [
  ...anaAlmacen.map((i) => ({ idarticulo: i.idarticulo, counterId: 'ana', sectionId: 's1' })),
  ...anaNevera.map((i) => ({ idarticulo: i.idarticulo, counterId: 'ana', sectionId: 's2' })),
  ...luisBar.map((i) => ({ idarticulo: i.idarticulo, counterId: 'luis', sectionId: 's3' })),
];

function payloadFor(counter: Counter): CounterPayload {
  return counterPayload({ session: SESSION, counter, sections, assignments, items: catalogue });
}

/** Every key at every level, tagged by the path shape it sits at. */
function keysByLevel(value: unknown, path: string, into: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    for (const entry of value) keysByLevel(entry, `${path}[]`, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const keys = into.get(path) ?? new Set<string>();
  for (const key of Object.keys(value)) {
    keys.add(key);
    keysByLevel((value as Record<string, unknown>)[key], `${path}.${key}`, into);
  }
  into.set(path, keys);
}

/** Every leaf value, so an old field under a new name still has to hold the number. */
function leaves(value: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) leaves(entry, into);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) leaves(entry, into);
  } else {
    into.push(value);
  }
  return into;
}

describe('the payload key set equals the allowlist at every level', () => {
  // Through JSON, not over the object: what a device holds is what came off
  // the wire, and a getter or an undefined would read differently here than
  // there.
  const serialised = JSON.parse(JSON.stringify(payloadFor(ANA))) as CounterPayload;

  it('walks a payload with real depth — sections, and more than one', () => {
    expect(serialised.secciones).toHaveLength(2);
    expect(serialised.secciones[0].items.length).toBeGreaterThan(10);
  });

  it('has exactly the allowed keys, level by level', () => {
    const found = new Map<string, Set<string>>();
    keysByLevel(serialised, '$', found);

    const expected: Record<string, readonly string[]> = {
      $: COUNTER_PAYLOAD_FIELDS,
      '$.session': COUNTER_SESSION_FIELDS,
      '$.counter': COUNTER_COUNTER_FIELDS,
      '$.secciones[]': COUNTER_SECTION_FIELDS,
      '$.secciones[].items[]': COUNTER_ITEM_FIELDS,
    };

    // Both directions. Missing a path here would let a whole new nested object
    // through unexamined, so the set of paths is asserted too.
    expect([...found.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [path, allowed] of Object.entries(expected)) {
      expect([...found.get(path)!].sort()).toEqual([...allowed].sort());
    }
  });

  it('never carries a name from the never-sent list, at any depth', () => {
    const found = new Map<string, Set<string>>();
    keysByLevel(serialised, '$', found);
    const every = new Set([...found.values()].flatMap((keys) => [...keys]));
    for (const forbidden of NEVER_SENT_TO_A_COUNTER) {
      expect(every.has(forbidden)).toBe(false);
    }
  });

  it('carries no value equal to an article’s book quantity or cost', () => {
    const byId = new Map(catalogue.map((item) => [item.idarticulo, item]));
    let checked = 0;
    for (const section of serialised.secciones) {
      for (const article of section.items) {
        const source = byId.get(article.idarticulo)!;
        const values = leaves(article);
        for (const forbidden of [source.existencia, source.costo, source.ultimoConteo]) {
          if (forbidden === null) continue;
          expect(values).not.toContain(forbidden);
          expect(values).not.toContain(String(forbidden));
        }
        checked++;
      }
    }
    expect(checked).toBe(anaAlmacen.length + anaNevera.length);
  });

  it('would catch a leak — the assertion above is not vacuous', () => {
    // A planted `existencia`, under a name nobody would grep for.
    const leaked = JSON.parse(JSON.stringify(serialised)) as CounterPayload & {
      secciones: { items: (Record<string, unknown> & { idarticulo: number })[] }[];
    };
    const first = leaked.secciones[0].items[0];
    const source = catalogue.find((item) => item.idarticulo === first.idarticulo)!;
    expect(source.existencia).not.toBe(0);
    first.referencia = source.existencia;

    expect(leaves(first)).toContain(source.existencia);
    const found = new Map<string, Set<string>>();
    keysByLevel(leaked, '$', found);
    expect([...found.get('$.secciones[].items[]')!]).toContain('referencia');
  });
});

describe('what the projection sends', () => {
  it('sends unidad verbatim from presentacion, without parsing it', () => {
    // `presentacion` is free text — `KILO`, `500 GRM`, `UNIDAD DE 450 A 550
    // GRAMOS`. Extracting "the unit" from that is a guess, and a guessed unit
    // beside a keypad is a wrong number.
    const payload = payloadFor(ANA);
    for (const section of payload.secciones) {
      for (const article of section.items) {
        const source = catalogue.find((item) => item.idarticulo === article.idarticulo)!;
        expect(article.unidad).toBe(source.presentacion);
      }
    }
    const presentaciones = payload.secciones.flatMap((s) => s.items.map((i) => i.presentacion));
    expect(presentaciones).toContain('KILO');
  });

  it('keeps codigo a zero-padded string', () => {
    const payload = payloadFor(ANA);
    const codigos = payload.secciones.flatMap((s) => s.items.map((i) => i.codigo));
    expect(codigos.every((codigo) => typeof codigo === 'string')).toBe(true);
    expect(codigos.some((codigo) => codigo.startsWith('0'))).toBe(true);
  });

  it('sends only this counter’s articles', () => {
    const ana = payloadFor(ANA);
    const mine = ana.secciones.flatMap((s) => s.items.map((i) => i.idarticulo));
    expect(new Set(mine)).toEqual(
      new Set([...anaAlmacen, ...anaNevera].map((item) => item.idarticulo)),
    );
    expect(mine).not.toContain(luisBar[0].idarticulo);
  });

  it('groups by section, so an article’s zona is derivable without a second fetch', () => {
    // The section name becomes `zona` on every event from these articles
    // (DOMAIN.md §6). A flat list would need a section name per row, which is a
    // sixth field on the object the leak test is strictest about.
    const ana = payloadFor(ANA);
    expect(ana.secciones.map((s) => s.nombre)).toEqual(['ALMACEN', 'NEVERA']);
    expect(ana.secciones[0].items).toHaveLength(anaAlmacen.length);
    expect(ana.secciones[1].items).toHaveLength(anaNevera.length);
  });

  it('keeps each section in catalogue order, which is shelf order', () => {
    const ana = payloadFor(ANA);
    expect(ana.secciones[0].items.map((i) => i.idarticulo)).toEqual(
      anaAlmacen.map((i) => i.idarticulo),
    );
  });

  it('drops a section holding nothing rather than printing a place to look for', () => {
    const payload = counterPayload({
      session: SESSION,
      counter: ANA,
      sections: [...sections, { id: 's4', nombre: 'CAVA', counterId: 'ana' }],
      assignments,
      items: catalogue,
    });
    expect(payload.secciones.map((s) => s.nombre)).toEqual(['ALMACEN', 'NEVERA']);
  });

  it('refuses to quietly drop an article whose section belongs to somebody else', () => {
    // The partition is inconsistent and `dispatchBlockers` refuses it, so this
    // should be unreachable. If it is reached, an article vanishes from a
    // tablet — a shelf nobody counts and nobody can see is missing — and that
    // has to be an error rather than a shorter list.
    const broken: Assignment[] = [
      ...assignments,
      { idarticulo: luisBar[0].idarticulo, counterId: 'ana', sectionId: 's3' },
    ];
    expect(() =>
      counterPayload({ session: SESSION, counter: ANA, sections, assignments: broken, items: catalogue }),
    ).toThrow(/partition is inconsistent/);
  });

  it('sends the registrado toggle, because it is config and not a build flag', () => {
    const off = counterPayload({
      session: { ...SESSION, mostrarMarcaRegistrado: false },
      counter: ANA,
      sections,
      assignments,
      items: catalogue,
    });
    expect(off.session.mostrarMarcaRegistrado).toBe(false);
  });

  it('sends no token back: it is already in the URL that fetched this', () => {
    const payload = payloadFor(LUIS);
    expect(JSON.stringify(payload)).not.toContain(LUIS.token);
  });
});
