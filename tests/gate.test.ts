/**
 * The gate: **no P2 path can construct a withdrawal without a target.**
 *
 * This is a test rather than a review convention because the next person to add
 * a withdrawal button will not have read the document that explains why:
 *
 *     Ana y Luis cuentan secciones distintas.
 *     Por error Ana registra 5 en el artículo 4471, que es de Luis.
 *
 *       Ana  add 5      (4471)
 *       Luis add 8      (4471)   ← su sección, su conteo real
 *       Ana  retract    (4471)   ← sin scope: "este artículo vuelve a untouched"
 *
 *       fold → untouched.  Los 8 de Luis desaparecieron.
 *
 * Nothing downstream catches it. The chain is intact — nothing was tampered
 * with. The export is well-formed. `verifyWriteBack` passes, because the file
 * faithfully reflects a fold that is quietly wrong. It surfaces as a variance
 * nobody can explain, weeks later.
 *
 * So it is closed in three places, and all three are asserted here: the type
 * (`CounterEventDraft`), the store, and the source. The server closes it a
 * fourth time — `tests/backend/push.pg.test.ts` — because a cached PWA build
 * from three weeks ago is a client nothing in this repository controls.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MemoryChain,
  genesisHash,
  resolve,
  undoLast,
  type CountEvent,
} from '../src/domain';
import { CountStore } from '../src/ui/store';
import { addCount, resetFactory } from './domain/factory';
import { fakeIdentity, sampleSession, seededRepository, SESSION_ID } from './ui/harness';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolvePath(ROOT, file), 'utf8');
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COUNTER = 'counter-ana';

async function counterStore(): Promise<CountStore> {
  const repo = await seededRepository();
  const chain = new MemoryChain();
  const session = sampleSession();
  return new CountStore(repo, session, [], {
    ...fakeIdentity(),
    nextSeq: 1,
    counterId: COUNTER,
    head: genesisHash(session.id, COUNTER),
    chain,
  });
}

describe('the fold still loses a count when a withdrawal has no target', () => {
  it('is the bug, written out, so the rest of this file has a reason', () => {
    resetFactory();
    const ana = addCount(4471, 5, { id: 'a', counterId: 'ana', seq: 1, deviceId: 'a' });
    const luis = addCount(4471, 8, { id: 'l', counterId: 'luis', seq: 1, deviceId: 'b' });
    const unscoped: CountEvent = {
      id: 'r',
      sessionId: 'session-1',
      counterId: 'ana',
      idarticulo: 4471,
      usuario: 'ana',
      zona: 'A1',
      at: '2026-08-25T10:00:09.000Z',
      deviceId: 'a',
      seq: 2,
      kind: 'retract',
    };

    expect(resolve([ana, luis])).toEqual({ state: 'counted', qty: 13 });
    // Luis's eight are gone, and nothing anywhere says so.
    expect(resolve([ana, luis, unscoped])).toEqual({ state: 'untouched' });

    // Scoped, the same withdrawal takes back only Ana's five.
    const scoped = { ...unscoped, id: 'r2', retractsEventId: ana.id };
    expect(resolve([ana, luis, scoped])).toEqual({ state: 'counted', qty: 8 });
  });
});

describe('the store refuses it', () => {
  it('«Descartar conteo» throws in a session with counters', async () => {
    const store = await counterStore();
    expect(() => store.retract(1181)).toThrow(/varios contadores/);
  });

  it('and reports itself unavailable, which is what takes the button off the screen', async () => {
    const store = await counterStore();
    store.setCount(1181, 5);
    expect(store.canRetract(1181)).toBe(false);
    // `EntryCard` renders the control only where the action exists at all — a
    // permanently disabled button is an action somebody keeps trying.
    expect(store.offersWholeItemDiscard).toBe(false);
    const card = code(read('src/ui/components/EntryCard.tsx'));
    expect(card).toMatch(/store\.offersWholeItemDiscard && \(/);
  });

  it('undo is offered, and it names its target', async () => {
    const store = await counterStore();
    const first = store.addCount(1181, 5);
    store.addCount(1181, 3);
    expect(store.canUndo(1181)).toBe(true);
    const undone = store.undo(1181)!;
    expect(undone).toMatchObject({ kind: 'retract' });
    expect((undone as { retractsEventId?: string }).retractsEventId).toBeTruthy();
    expect(store.resolutionFor(1181)).toEqual({ state: 'counted', qty: 5 });
    expect(first.id).toBeTruthy();
  });

  it('undo is scoped to this counter, so it cannot reach another counter’s event', async () => {
    const repo = await seededRepository();
    const session = sampleSession();
    resetFactory();
    const luis = addCount(1181, 8, {
      sessionId: SESSION_ID,
      counterId: 'counter-luis',
      deviceId: 'tablet-2',
      seq: 1,
    });
    const store = new CountStore(repo, session, [luis], {
      ...fakeIdentity(),
      nextSeq: 1,
      counterId: COUNTER,
      head: genesisHash(SESSION_ID, COUNTER),
      chain: new MemoryChain(),
    });
    // Ana has written nothing, so there is nothing of hers to undo — even
    // though the article has a standing count on it.
    expect(store.canUndo(1181)).toBe(false);
    expect(store.undo(1181)).toBeNull();
  });

  it('the P1 store is untouched: its whole-item discard still works', async () => {
    // Not politeness toward old code. A P1 log has to fold to the same numbers
    // after the upgrade as before it (docs/MIGRATION-P1-P2.md), and the button
    // that writes those events is still on the P1 screen.
    const repo = await seededRepository();
    const store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    store.setCount(1181, 5);
    expect(store.canRetract(1181)).toBe(true);
    expect(store.offersWholeItemDiscard).toBe(true);
    const event = store.retract(1181);
    expect(event).toMatchObject({ kind: 'retract' });
    expect(event).not.toHaveProperty('retractsEventId');
    expect(store.resolutionFor(1181)).toEqual({ state: 'untouched' });
  });
});

describe('undoLast never produces an unscoped withdrawal for a counter', () => {
  it('always names its target when a counter is given', () => {
    resetFactory();
    const events = [
      addCount(1181, 5, { counterId: COUNTER, seq: 1 }),
      addCount(1181, 3, { counterId: COUNTER, seq: 2 }),
    ];
    const draft = undoLast(events, COUNTER);
    expect(draft).toEqual({ kind: 'retract', retractsEventId: events[1].id });
  });
});

describe('no P2 source constructs one', () => {
  /**
   * Everything a counter's tablet or the server runs. The P1 app is not on the
   * list: `src/ui/App.tsx` and its screens keep the whole-item discard for the
   * sessions that already contain those events.
   */
  const P2_SOURCES = [
    'src/ui/counter/sync.ts',
    'src/ui/counter/boot.ts',
    'src/ui/counter/Finish.tsx',
    'src/ui/counter/CounterScreen.tsx',
    'src/ui/counter/Prepare.tsx',
    'src/domain/counterView.ts',
    'src/domain/sync.ts',
    'api/c/[token]/index.ts',
    'api/c/[token]/events.ts',
    'api/c/[token]/resume.ts',
    'api/sessions/[id]/sync.ts',
    'api/sessions/[id]/events.ts',
  ];

  for (const file of P2_SOURCES) {
    it(`${file} never writes kind: 'retract'`, () => {
      expect(code(read(file))).not.toMatch(/kind:\s*['"]retract['"]/);
    });
  }

  it('the one place that can build one guards it, in the type and at runtime', () => {
    const store = code(read('src/ui/store.ts'));
    // The runtime half of `CounterEventDraft`: a draft that arrived through the
    // wider `CountEventDraft` — which is what `undoLast` returns — would
    // otherwise walk straight past the compiler.
    expect(store).toMatch(/draft\.retractsEventId === undefined/);
    const types = read('src/domain/types.ts');
    expect(types).toMatch(/CounterEventDraft/);
    expect(types).toMatch(/\{ kind: 'retract'; retractsEventId: string \}/);
  });

  it('the server refuses it too, whatever the client believes', () => {
    // The gate that actually holds: a cached PWA build from three weeks ago is
    // a client nothing in this repository controls.
    const handler = code(read('api/c/[token]/events.ts'));
    expect(handler).toMatch(/retractsEventId === undefined/);
    expect(handler).toMatch(/RETRACT_SIN_SCOPE/);
  });
});
