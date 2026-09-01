/**
 * The leak test, re-run **against what actually landed on the tablet**.
 *
 * `tests/domain/counterView.test.ts` asserts the projection. This asserts the
 * artefact: the payload goes through the real `AssignmentStore` into a real
 * IndexedDB, comes back out, and is walked again. The two are not the same
 * claim. A store that spread the payload together with a cached catalogue row,
 * or a schema upgrade that merged two tables, would leave the projection
 * perfectly correct and the device holding `existencia` anyway — and the device
 * is what a counter's screen renders from.
 *
 * It also closes a slower failure: `counterAssignments` is a *durable* table.
 * A figure that reaches it stays on that tablet across sessions, across
 * upgrades, and until somebody clears site data.
 */
// Must precede any import that reaches Dexie: Dexie binds the global
// indexedDB at module load, so a shim installed afterwards is too late.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { toItems } from '../../src/app';
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
  type Section,
} from '../../src/domain';
import { ConteoDb, DexieAssignmentStore } from '../../src/store';
import { parseXls } from '../../src/zeus';
import { SAMPLE_XLS, readSample } from '../helpers';

const catalogue = toItems(parseXls(readSample(SAMPLE_XLS)));
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa';

const ANA: Counter = {
  id: 'ana',
  nombre: 'Ana Rodríguez',
  token: TOKEN,
  estado: 'asignado',
  fetchedAt: null,
};

const sections: Section[] = [
  { id: 's1', nombre: 'Cuarto frío proteínas', counterId: 'ana' },
  { id: 's2', nombre: 'Panadería', counterId: 'ana' },
];

const assignments: Assignment[] = [
  ...catalogue.slice(0, 30).map((item): Assignment => ({
    sessionId: 'session-1',
    idarticulo: item.idarticulo,
    counterId: 'ana',
    sectionId: 's1',
  })),
  ...catalogue.slice(30, 50).map((item): Assignment => ({
    sessionId: 'session-1',
    idarticulo: item.idarticulo,
    counterId: 'ana',
    sectionId: 's2',
  })),
];

const payload = counterPayload({
  session: {
    id: 'session-1',
    bodega: '01',
    fechaCorte: '2025/04/30',
    nombre: 'Corte abril',
    mostrarMarcaRegistrado: true,
  },
  counter: ANA,
  sections,
  assignments,
  items: catalogue,
});

/** Every key at every depth, and every leaf value. */
function walk(value: unknown, keys: Set<string>, leaves: unknown[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, keys, leaves);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      walk(child, keys, leaves);
    }
    return;
  }
  leaves.push(value);
}

describe('the assignment on the device carries no Zeus figure', () => {
  let db: ConteoDb;

  beforeEach(async () => {
    db = new ConteoDb(`leak-${Math.random().toString(36).slice(2)}`);
    await new DexieAssignmentStore(db).save(TOKEN, payload, '2026-08-31T12:00:00.000Z');
  });

  it('reads back with exactly the allowlisted keys, at every level', async () => {
    const row = await new DexieAssignmentStore(db).load(TOKEN);
    expect(row).not.toBeNull();
    const held = row!.payload;

    expect(Object.keys(held).sort()).toEqual([...COUNTER_PAYLOAD_FIELDS].sort());
    expect(Object.keys(held.session).sort()).toEqual([...COUNTER_SESSION_FIELDS].sort());
    expect(Object.keys(held.counter).sort()).toEqual([...COUNTER_COUNTER_FIELDS].sort());
    for (const section of held.secciones) {
      expect(Object.keys(section).sort()).toEqual([...COUNTER_SECTION_FIELDS].sort());
      for (const item of section.items) {
        expect(Object.keys(item).sort()).toEqual([...COUNTER_ITEM_FIELDS].sort());
      }
    }
  });

  it('contains none of the forbidden names anywhere in the stored row', async () => {
    // The whole row, not only the payload: the wrapper carries `token`,
    // `sessionId`, `counterId` and `fetchedAt`, and a future column on that
    // table is exactly as durable as one inside the payload.
    const row = await new DexieAssignmentStore(db).load(TOKEN);
    const keys = new Set<string>();
    const leaves: unknown[] = [];
    walk(row, keys, leaves);
    for (const forbidden of NEVER_SENT_TO_A_COUNTER) {
      expect(keys.has(forbidden), `the device is holding ${forbidden}`).toBe(false);
    }
  });

  it('holds no value equal to an article’s book quantity, cost or last count', async () => {
    // The second half of the argument: the first assertion catches a new field,
    // this one catches an old field under a new name.
    const row = await new DexieAssignmentStore(db).load(TOKEN);
    const byId = new Map(catalogue.map((item) => [item.idarticulo, item]));
    let checked = 0;
    for (const section of row!.payload.secciones) {
      for (const article of section.items) {
        const source = byId.get(article.idarticulo)!;
        const leaves: unknown[] = [];
        walk(article, new Set(), leaves);
        for (const forbidden of [source.existencia, source.costo, source.ultimoConteo]) {
          if (forbidden === null) continue;
          expect(leaves).not.toContain(forbidden);
          expect(leaves).not.toContain(String(forbidden));
        }
        checked++;
      }
    }
    expect(checked).toBe(50);
  });
});
