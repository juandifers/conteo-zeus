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
import { counterStore } from './ui/counterHarness';
import { fakeIdentity, sampleSession, seededRepository, SESSION_ID } from './ui/harness';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolvePath(ROOT, file), 'utf8');
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COUNTER = 'counter-ana';

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
    const { store } = await counterStore();
    expect(() => store.retract(1181)).toThrow(/varios contadores/);
  });

  it('and reports itself unavailable, which is what takes the button off the screen', async () => {
    const { store } = await counterStore();
    store.setCount(1181, 5);
    expect(store.canRetract(1181)).toBe(false);
    // `EntryCard` renders the control only where the action exists at all — a
    // permanently disabled button is an action somebody keeps trying.
    expect(store.offersWholeItemDiscard).toBe(false);
    const card = code(read('src/ui/components/EntryCard.tsx'));
    expect(card).toMatch(/store\.offersWholeItemDiscard && \(/);
  });

  it('undo is offered, and it names its target', async () => {
    const { store } = await counterStore();
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
    'src/ui/counter/assignment.ts',
    'src/ui/counter/Search.tsx',
    'src/ui/counter/Entry.tsx',
    'src/ui/counter/MyEntries.tsx',
    'src/ui/counter/Notes.tsx',
    'src/ui/counter/SyncBar.tsx',
    'src/ui/counter/Finish.tsx',
    'src/ui/counter/CounterScreen.tsx',
    'src/ui/counter/Prepare.tsx',
    'src/ui/counter/Registrado.tsx',
    'src/ui/counter/handover.ts',
    'src/domain/ownWork.ts',
    'src/domain/actions.ts',
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

/**
 * P2.3's two gates, asserted the same way and for the same reason.
 *
 * Both are about a *second writer* to something that already has one, and both
 * fail silently: nothing downstream can tell an event stamped with a zone
 * somebody picked from one stamped with the zone they were assigned, and
 * nothing downstream can tell a waiver a counter typed from one a supervisor
 * signed. The first surfaces as an acta that disagrees with the partition; the
 * second as a row that posts at `existencia` because somebody vouched for a
 * figure they had never seen.
 */
describe('G2 — one source of `zona`', () => {
  it('the ZONAS dropdown is gone, along with the preference behind it', () => {
    const identity = code(read('src/ui/identity.ts'));
    expect(identity).not.toMatch(/\bZONAS\b/);
    expect(identity).not.toMatch(/\bloadZona\b|\bsaveZona\b/);
    // And the store no longer has a setter for it, which is what a screen
    // would have had to call.
    expect(code(read('src/ui/store.ts'))).not.toMatch(/\bsetZona\b/);
  });

  it('no P2 path sets `zona` from user input', () => {
    // The one writer left is `zonaFor`, which is a lookup into the partition
    // the admin committed to at dispatch (P2.1 §3c). A control bound to `zona`
    // — a select, an input, an onChange — is what this forbids.
    const P2_UI = [
      'src/ui/counter/CounterScreen.tsx',
      'src/ui/counter/Search.tsx',
      'src/ui/counter/Entry.tsx',
      'src/ui/counter/MyEntries.tsx',
      'src/ui/counter/Notes.tsx',
      'src/ui/counter/SyncBar.tsx',
      'src/ui/counter/Finish.tsx',
      'src/ui/counter/Prepare.tsx',
      'src/ui/counter/Registrado.tsx',
      'src/ui/counter/assignment.ts',
      'src/ui/counter/handover.ts',
    ];
    for (const file of P2_UI) {
      const source = code(read(file));
      expect(source, `${file} writes a zona`).not.toMatch(/zona\s*[:=]\s*(?!\(|undefined)/i);
      expect(source, `${file} names ZONAS`).not.toMatch(/\bZONAS\b/);
    }
    // `zonaFor` is the only thing that produces one, and it reads the sections.
    const assignment = code(read('src/ui/counter/assignment.ts'));
    expect(assignment).toMatch(/zonaFor/);
    expect(assignment).toMatch(/zonas\.set\(item\.idarticulo, section\.nombre\)/);
  });

  it('a counter’s events carry the section they were assigned', async () => {
    // The runtime half. Two sections on one tablet, so a single string would be
    // wrong for one of them.
    const { store } = await counterStore();
    const pan = store.addCount(2165, 3);
    const tilapia = store.addCount(1595, 2);
    expect(pan.zona).toBe('Panadería');
    expect(tilapia.zona).toBe('Cuarto frío proteínas');
  });
});

/**
 * P2.3.5's own gate: **assignments move, events never do.**
 *
 * The invariant that makes counter changes after dispatch tractable at all, and
 * the one a future edit is most likely to break with the best of intentions —
 * "Luis's shelves are Pedro's now, so his events should say Pedro". They should
 * not. Luis did the counting; the events are his by `counterId`, for ever, and
 * reassignment moves responsibility for what is still *to be done*.
 *
 * Asserted by reading the source because the failure would be silent: an
 * `update events set counter_id` runs fine, breaks every chain it touches, and
 * nothing notices until a seal.
 */
describe('reassignment never touches the log (P2.3.5 §4)', () => {
  it('the write path holds no statement that could move or re-hash an event', () => {
    const store = code(read('api/_store.ts'));
    const reassign = store.slice(
      store.indexOf('export function reassignStatements'),
      store.indexOf('export interface ActionOnlyWrites'),
    );
    expect(reassign).not.toMatch(/update events/i);
    expect(reassign).not.toMatch(/delete from events/i);
    expect(reassign).not.toMatch(/counter_id\s*=\s*\$?\w*\s*where[\s\S]{0,40}events/i);
  });

  it('the endpoint reassigns and retires without importing anything that chains an event', () => {
    const handler = code(read('api/sessions/[id]/acciones.ts'));
    expect(handler).not.toMatch(/\bchainEvents\b|\bchainHash\b|\bcanonicalEvent\b/);
    // It does chain **actions**, which is a different chain with a different tag.
    expect(handler).toMatch(/\bchainActionHash\b/);
  });

  it('the plan is expressed in assignments and sections, and in nothing else', () => {
    const actions = code(read('src/domain/actions.ts'));
    expect(actions).not.toMatch(/\bCountEvent\b/);
    expect(actions).toMatch(/assignmentCoverage/);
  });
});

describe('«sin verificar» is not a counter’s to say (P2.3)', () => {
  it('no P2 source constructs an `unchanged`', () => {
    for (const file of [
      'src/ui/counter/Entry.tsx',
      'src/ui/counter/Search.tsx',
      'src/ui/counter/MyEntries.tsx',
      'src/ui/counter/Notes.tsx',
      'src/ui/counter/Finish.tsx',
      'src/ui/counter/CounterScreen.tsx',
      'src/domain/ownWork.ts',
    ]) {
      expect(code(read(file)), file).not.toMatch(/kind:\s*['"]unchanged['"]/);
      expect(code(read(file)), file).not.toMatch(/markUnchanged|waiveMany/);
    }
  });

  it('the kind is unspellable in the counter draft type', () => {
    const types = read('src/domain/types.ts');
    const draft = types.slice(types.indexOf('export type CounterEventDraft'));
    expect(draft.slice(0, draft.indexOf(';'))).not.toMatch(/unchanged/);
  });

  it('the store refuses one even if something reaches for it', async () => {
    const { store } = await counterStore();
    expect(() => store.markUnchanged(2165)).toThrow(/nunca la vio/);
  });

  it('the P1 store and the supervisor’s bulk waiver still write them', async () => {
    // Waivers did not disappear; they moved to the person who can see what they
    // are signing. Both remaining paths are exercised here so that «counters
    // cannot waive» is never read as «the app cannot waive».
    const repo = await seededRepository();
    const p1 = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    expect(p1.markUnchanged(1181)).toMatchObject({ kind: 'unchanged' });
    const [bulk] = p1.waiveMany([330], { motivo: 'revisión de escritorio', usuario: 'marta' });
    expect(bulk).toMatchObject({ kind: 'unchanged', usuario: 'marta', zona: '' });
  });
});

/**
 * P2.4 §4a — **`session_actions.payload` never carries a quantity.**
 *
 * A rule rather than a coincidence of the waiver task, and asserted here for the
 * same reason the withdrawal gate is: the next person to add an admin action
 * will not have read the document that explains why.
 *
 * The waived value is `existencia` from `catalog_rows`, read where it lives. A
 * copy in the payload would be a second figure that can disagree with the first,
 * and there is no reading of a disagreement between the two that is not a
 * problem. If an admin action ever seems to need a number counted off a shelf,
 * it is a count, and a count belongs in `events` — where `cantidad text` exists
 * precisely because decimals do not survive a `numeric` round trip, and where
 * `canonicalJson`'s refusal of anything but safe integers would otherwise bite.
 */
describe('an admin action never carries a quantity (P2.4 §4a)', () => {
  /** Ways an ERP figure or a counted number could enter a payload. */
  const FORBIDDEN = /\b(qty|cantidad|existencia|costo|valor|exposicion|conteo)\s*[?]?\s*:/;

  it('no payload type declares one', () => {
    const actions = code(read('src/domain/actions.ts'));
    // Every `…Payload` interface in the module, body and all.
    const bodies = [...actions.matchAll(/export interface \w*Payload \{([\s\S]*?)\n\}/g)];
    expect(bodies.length).toBeGreaterThan(4);
    for (const body of bodies) {
      expect(FORBIDDEN.test(body[1]), body[0].slice(0, 60)).toBe(false);
    }
  });

  it('the endpoint that writes them never inserts a count', () => {
    const handler = code(read('api/sessions/[id]/acciones.ts'));
    expect(handler).not.toMatch(/insert into events/i);
    expect(handler).not.toMatch(/\bcantidad\b/);
    // And it chains actions, not events — a different chain with a different tag.
    expect(handler).toMatch(/\bchainActionHash\b/);
  });

  it('the review screen posts decisions and never a number somebody counted', () => {
    // Editing a count from the admin screen is refused rather than deferred:
    // the count is what somebody saw, and a number typed at a desk would be
    // entered under a counter's identity or under none.
    const revision = code(read('src/ui/admin/Revision.tsx'));
    expect(revision).not.toMatch(/kind:\s*['"](set|add|retract|unchanged)['"]/);
    const kinds = [...revision.matchAll(/kind:\s*'([a-z_]+)'/g)].map((match) => match[1]);
    expect(new Set(kinds)).toEqual(new Set(['waiver', 'anular_waiver']));
  });

  it('the waiver reaches the fold as a projection, never as a stored event', () => {
    // `waiversToEvents` builds `unchanged` events *for the fold to read*. They
    // are derived from the chain on every read and written nowhere, which is
    // what keeps `anular_waiver` a one-line answer instead of a deletion.
    const review = code(read('src/domain/review.ts'));
    expect(review).toMatch(/export function waiversToEvents/);
    expect(review).not.toMatch(/appendEvent|insertEvents|appendChained/);
  });
});
