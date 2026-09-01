/**
 * The invariant the whole offline model rests on.
 *
 * Under P2 rules the fold over counter-emitted events is **commutative**:
 *
 *   - counters emit only `add`, `unchanged`, scoped `retract` and `note`;
 *   - scoped retraction names its target by id, so it does not depend on
 *     position;
 *   - `add` is decimal addition;
 *   - `unchanged` clears the running value and *is* order-sensitive — but from
 *     P2.3 no counter emits one (a waiver vouches for a book figure their
 *     tablet has never seen), and P2.1's dispatch gate guarantees no two
 *     counters share an article anyway.
 *
 * The last point is why this is now a property of the design rather than of the
 * clocks: with `unchanged` gone from the counter path, what is left is `add`
 * (commutative), scoped `retract` (positional-independent) and `note` (no fold
 * effect). The fixtures below still exercise `unchanged`, because P1 logs and
 * the admin's bulk waiver produce them and both fold through the same function.
 *
 * So arrival order cannot change a total, and clock skew cannot change a total:
 * a device that syncs three hours late produces the same numbers as one that
 * synced instantly. This file asserts that directly rather than trusting the
 * argument.
 *
 * **If blind double-counting is ever built, this reasoning must be redone
 * before it ships** — two counters over one article is exactly the premise
 * removed. That is written here and beside the invariant in DOMAIN.md, not only
 * in the task document.
 */
import { describe, expect, it } from 'vitest';

import { compareEvents, resolveAll, type CountEvent, type Resolution } from '../../src/domain';
import { addCount, markUnchanged, note, resetFactory, retract } from './factory';

const SESSION = 'session-1';

/**
 * A deterministic shuffle, so a failure is reproducible from the seed printed
 * in the test name rather than from whatever `Math.random` did that afternoon.
 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One counter's morning over their own articles, with a mistake and a waiver in it. */
function morning(
  counterId: string,
  deviceId: string,
  articles: readonly number[],
  clockOffsetMs: number,
): CountEvent[] {
  resetFactory();
  const events: CountEvent[] = [];
  let seq = 1;
  const stamp = () =>
    new Date(Date.UTC(2026, 7, 31, 14, 0, 0) + clockOffsetMs + seq * 1000).toISOString();

  for (const [i, idarticulo] of articles.entries()) {
    const at = () => ({ id: `${counterId}-${seq}`, sessionId: SESSION, counterId, deviceId, at: stamp(), seq: seq++ });
    const first = addCount(idarticulo, 3, at());
    events.push(first);
    events.push(addCount(idarticulo, 1.5, at()));
    if (i % 3 === 0) {
      // A mis-tap, withdrawn by name. Order-independent because it names its
      // target rather than relying on position.
      const stray = addCount(idarticulo, 40, at());
      events.push(stray);
      events.push(retract(idarticulo, { ...at(), retractsEventId: stray.id }));
    }
    if (i % 5 === 4) {
      // A waiver, which *is* order-sensitive — and is why "no two counters
      // share an article" is load-bearing rather than decorative.
      events.push(markUnchanged(idarticulo, at()));
    }
    if (i % 7 === 2) events.push(note(idarticulo, 'caja abierta', at()));
  }
  return events;
}

const ANA = [1181, 330, 2660, 77, 1595];
const LUIS = [2104, 4471, 91069, 15450, 812];

function fold(events: readonly CountEvent[]): Record<number, Resolution> {
  return Object.fromEntries(resolveAll(events));
}

describe('arrival order cannot change a total', () => {
  const ana = morning('ana', 'tablet-a', ANA, 0);
  // Nine minutes fast, and syncing three hours late.
  const luis = morning('luis', 'tablet-b', LUIS, 9 * 60 * 1000);
  const canonical = fold([...ana, ...luis]);

  it('folds something worth folding', () => {
    // Guards against the whole file being vacuous over an empty map.
    expect(Object.keys(canonical)).toHaveLength(ANA.length + LUIS.length);
    expect(Object.values(canonical).some((r) => r.state === 'counted')).toBe(true);
    expect(Object.values(canonical).some((r) => r.state === 'unchanged')).toBe(true);
  });

  for (const seed of [1, 7, 42, 1337, 90210, 555_555]) {
    it(`is identical under interleaving ${seed}`, () => {
      expect(fold(shuffled([...ana, ...luis], seed))).toEqual(canonical);
    });
  }

  it('is identical when one counter arrives entirely after the other', () => {
    expect(fold([...luis, ...ana])).toEqual(canonical);
  });

  it('is identical when a batch is delivered twice', () => {
    // Over-delivery is free, which is the property the whole push protocol
    // leans on. Note *where* the deduplication happens: by `id`, at the store —
    // `appendEvent` is idempotent, `unique (counter_id, seq)` refuses the
    // second row — and **not** in the fold, which sums the array it is handed.
    // The redelivered batch is folded through the same gate every real path
    // goes through.
    const delivered = new Map<string, CountEvent>();
    for (const event of [...ana, ...luis, ...ana.slice(0, 4)]) delivered.set(event.id, event);
    expect(fold([...delivered.values()])).toEqual(canonical);
  });

  it('is identical when one counter’s clock is nine minutes fast', () => {
    // Skew corrupts the audit timeline, not the numbers. That is why it is
    // surfaced to the admin and never corrected: rewriting a device's
    // timestamps would change the hashes and break the chain to fix a cosmetic
    // problem.
    const slow = morning('luis', 'tablet-b', LUIS, -9 * 60 * 1000);
    const withSlow = fold([...ana, ...slow]);
    for (const idarticulo of LUIS) {
      expect(withSlow[idarticulo]).toEqual(canonical[idarticulo]);
    }
  });
});

describe('one counter, two tablets — the case the premise depends on', () => {
  /**
   * A counter whose tablet died and who moved to a spare.
   *
   * This is the pair P2.3's G1 exists for. `compareEvents` **used to** order by
   * `at` before `deviceId` and `seq`, so a spare whose clock ran behind the
   * tablet it replaced sorted that counter's later events before their earlier
   * ones — and for their own article, with a waiver in the log, that is the
   * difference between a count standing and a count being withdrawn.
   *
   * `seq` is allocated per counter (`unique (counter_id, seq)`) and `/resume`
   * continues the numbering onto the spare, so within one counter it *is* the
   * causal order whatever the clock says. Both halves are asserted below: the
   * comparator that ships, and the one that used to, on exactly the same
   * events. The second is what documents why the branch is there.
   */
  const article = 1181;
  const base = Date.UTC(2026, 7, 31, 14, 0, 0);
  const stamp = (ms: number) => new Date(base + ms).toISOString();

  resetFactory();
  const onA = [
    addCount(article, 5, { id: 'a1', counterId: 'ana', deviceId: 'tablet-a', seq: 1, at: stamp(1000) }),
    markUnchanged(article, { id: 'a2', counterId: 'ana', deviceId: 'tablet-a', seq: 2, at: stamp(2000) }),
  ];

  /** `compareEvents` as it stood before P2.3 — `(at, deviceId, seq, id)`. */
  function legacyCompare(a: CountEvent, b: CountEvent): number {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /** What the old comparator would have folded this article to. */
  function legacyFold(events: readonly CountEvent[]): number | 'unchanged' {
    const ordered = events.slice().sort(legacyCompare);
    let qty: number | undefined;
    let waived = false;
    for (const event of ordered) {
      if (event.kind === 'add') {
        qty = (qty ?? 0) + event.qty;
        waived = false;
      } else if (event.kind === 'unchanged') {
        qty = undefined;
        waived = true;
      }
    }
    return waived ? 'unchanged' : qty ?? 0;
  }

  it('folds correctly when the spare stamps after the tablet it replaced', () => {
    const onB = addCount(article, 9, {
      id: 'b1',
      counterId: 'ana',
      deviceId: 'tablet-b',
      seq: 3,
      at: stamp(3000),
    });
    // The waiver came first and the count resumed from zero after it.
    expect(resolveAll([...onA, onB]).get(article)).toEqual({ state: 'counted', qty: 9 });
  });

  it('folds the same when the spare’s clock is five minutes behind', () => {
    // The same three events, with the spare stamping *before* the tablet it
    // replaced. `seq` still says the count came after the waiver, because `seq`
    // is the counter's own numbering and `/resume` handed the spare number 3.
    const behind = addCount(article, 9, {
      id: 'b1',
      counterId: 'ana',
      deviceId: 'tablet-b',
      seq: 3,
      at: stamp(-300_000),
    });
    expect(resolveAll([...onA, behind]).get(article)).toEqual({ state: 'counted', qty: 9 });
  });

  it('would have folded to a waiver under the old comparator — the reason for the branch', () => {
    // Asserted rather than described. If somebody restores `at`-first ordering
    // for a counter's own events, the test above turns red and this one stays
    // green, which is the pair that says what changed and why.
    const behind = addCount(article, 9, {
      id: 'b1',
      counterId: 'ana',
      deviceId: 'tablet-b',
      seq: 3,
      at: stamp(-300_000),
    });
    expect(legacyFold([...onA, behind])).toBe('unchanged');
    expect(legacyFold([...onA, { ...behind, at: stamp(3000) }])).toBe(9);
  });

  it('the watermark still holds, and now only for the timeline', () => {
    // `CountStoreOptions.highWater` is not what keeps the total right any more.
    // It keeps the audit trail on the acta in the order things happened, which
    // is what it should have been doing: clamped up to `lastClientAt`, the
    // spare's first event no longer claims to predate the tablet it replaced.
    const clamped = addCount(article, 9, {
      id: 'b1',
      counterId: 'ana',
      deviceId: 'tablet-b',
      seq: 3,
      at: stamp(2000),
    });
    expect(clamped.at >= onA[1].at).toBe(true);
    expect(resolveAll([...onA, clamped]).get(article)).toEqual({ state: 'counted', qty: 9 });
  });
});

describe('compareEvents is a total order', () => {
  /**
   * Every tie shape there is, in one fixture.
   *
   * A comparator that returns 0 for two distinct events is not a total order,
   * and the consequence is not an untidy list: two devices holding the same
   * events sort them differently and fold them differently, and nothing
   * anywhere says so. The shape that used to do it is the last pair below —
   * two tokens open on **one tablet** give the same `deviceId`, the same `at`
   * and the same `seq` for two genuinely different events.
   */
  const at = '2026-08-31T14:00:00.000Z';
  const shapes: CountEvent[] = [
    addCount(1, 1, { id: 'x1', counterId: 'ana', deviceId: 'tab-a', seq: 1, at }),
    addCount(1, 1, { id: 'x2', counterId: 'ana', deviceId: 'tab-a', seq: 2, at }),
    // Same counter, same seq — a bug the repository rejects, still ordered.
    addCount(1, 1, { id: 'x3', counterId: 'ana', deviceId: 'tab-b', seq: 2, at }),
    addCount(1, 1, { id: 'y1', counterId: 'luis', deviceId: 'tab-a', seq: 1, at }),
    // Two tokens on one tablet: same deviceId, same at, same seq.
    addCount(1, 1, { id: 'y2', counterId: 'luis', deviceId: 'tab-a', seq: 2, at }),
    // P1 events: no `counterId` at all, so the same-counter branch never fires.
    addCount(1, 1, { id: 'z1', deviceId: 'tab-a', seq: 1, at }),
    addCount(1, 1, { id: 'z2', deviceId: 'tab-a', seq: 2, at }),
    addCount(1, 1, { id: 'z3', deviceId: 'tab-c', seq: 1, at: '2026-08-31T13:00:00.000Z' }),
  ];

  it('never returns 0 for two distinct events', () => {
    for (const a of shapes) {
      for (const b of shapes) {
        if (a.id === b.id) continue;
        expect(compareEvents(a, b), `${a.id} vs ${b.id}`).not.toBe(0);
      }
    }
  });

  it('is antisymmetric', () => {
    for (const a of shapes) {
      for (const b of shapes) {
        expect(Math.sign(compareEvents(a, b)) + Math.sign(compareEvents(b, a))).toBe(0);
      }
    }
  });

  it('is transitive, and sorts identically from any starting order', () => {
    for (const a of shapes) {
      for (const b of shapes) {
        for (const c of shapes) {
          if (compareEvents(a, b) < 0 && compareEvents(b, c) < 0) {
            expect(compareEvents(a, c)).toBeLessThan(0);
          }
        }
      }
    }
    const forwards = shapes.slice().sort(compareEvents).map((event) => event.id);
    const backwards = shapes.slice().reverse().sort(compareEvents).map((event) => event.id);
    expect(backwards).toEqual(forwards);
  });

  it('orders one counter by seq and nothing else', () => {
    const first = shapes.find((event) => event.id === 'x1')!;
    const second = shapes.find((event) => event.id === 'x2')!;
    // Even with the later event stamped an hour earlier on another device.
    const skewed = { ...second, at: '2026-08-31T13:00:00.000Z', deviceId: 'tab-z' };
    expect(compareEvents(first, skewed)).toBeLessThan(0);
  });
});


/**
 * Reassignment mid-count does not touch the fold — P2.3.5 §4.
 *
 * The property the whole task rests on, and the reason it is tractable at all:
 * **assignments and events are separate tables and separate concerns.** Luis
 * counted sixty articles; those events are attributed to him by `counterId` and
 * stay that way for ever, whoever holds the assignment afterwards. Reassignment
 * moves responsibility for what is *still to be done*.
 *
 * So the fold cannot notice one happening. There is nothing to assert about the
 * events themselves — no event changes — which is exactly why this is worth
 * writing down: it is the shape of a bug somebody could introduce later by
 * "tidying up" a counter's log when their shelves move.
 *
 * The premise is unchanged from §6.2: no article is counted by two counters. A
 * handover is precisely the moment that can stop being true, which is what
 * `yaRegistrados` and the extra confirm in the entry card are for.
 */
describe('a reassignment mid-count (P2.3.5 §4)', () => {
  const LUIS = 'counter-luis';
  const PEDRO = 'counter-pedro';

  it('changes nothing about the numbers, in either arrival order', () => {
    resetFactory();
    // Luis counts two shelves. His articles are handed to Pedro at eleven —
    // which writes rows in `assignments` and `session_actions` and not one row
    // in `events`. Pedro then counts the third.
    const luis = [
      addCount(1181, 8, { counterId: LUIS, seq: 1, at: '2026-08-31T10:00:00.000Z' }),
      addCount(330, 2.5, { counterId: LUIS, seq: 2, at: '2026-08-31T10:30:00.000Z' }),
    ];
    const pedro = [
      addCount(1595, 4, { counterId: PEDRO, seq: 1, at: '2026-08-31T11:30:00.000Z', deviceId: 'tab-b' }),
    ];

    const flat = (resolutions: Map<number, Resolution>) =>
      [...resolutions.entries()].sort(([a], [b]) => a - b);
    const before = resolveAll([...luis, ...pedro]);
    const after = resolveAll([...pedro, ...luis]);
    expect(flat(after)).toEqual(flat(before));
    expect(before.get(1181)).toEqual({ state: 'counted', qty: 8 });
    expect(before.get(1595)).toEqual({ state: 'counted', qty: 4 });
  });

  it('keeps the predecessor’s work when their successor counts the same shelf', () => {
    // The §4b hole, folded. If Luis's tablet drains at 17:40 with a count of an
    // article Pedro also counted, the fold **sums both** — that is a real double
    // count and no arithmetic here can undo it. What this asserts is that it is
    // the sum and not a silent overwrite, because the sum is at least a number
    // the review screen can see is wrong.
    resetFactory();
    const events = [
      addCount(1181, 8, { counterId: LUIS, seq: 1, at: '2026-08-31T10:00:00.000Z' }),
      addCount(1181, 6, { counterId: PEDRO, seq: 1, at: '2026-08-31T11:30:00.000Z', deviceId: 'tab-b' }),
    ];
    expect(resolveAll(events).get(1181)).toEqual({ state: 'counted', qty: 14 });
    expect(resolveAll(events.slice().reverse()).get(1181)).toEqual({ state: 'counted', qty: 14 });
  });

  it('does not let a successor withdraw what their predecessor recorded', () => {
    // Scoped retraction names its target, and the store refuses one that is not
    // the counter's own (P2.3 §3). Stated at the fold as well: even a retraction
    // that reached the log naming somebody else's event withdraws that event and
    // nothing more — it does not clear the article.
    resetFactory();
    const mine = addCount(1181, 8, { counterId: LUIS, seq: 1, at: '2026-08-31T10:00:00.000Z' });
    const theirs = addCount(1181, 6, { counterId: PEDRO, seq: 1, at: '2026-08-31T11:00:00.000Z', deviceId: 'tab-b' });
    const undo = retract(1181, {
      counterId: PEDRO,
      seq: 2,
      deviceId: 'tab-b',
      at: '2026-08-31T11:05:00.000Z',
      retractsEventId: theirs.id,
    });
    expect(resolveAll([mine, theirs, undo]).get(1181)).toEqual({ state: 'counted', qty: 8 });
  });
});
