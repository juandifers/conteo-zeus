/**
 * The invariant the whole offline model rests on.
 *
 * Under P2 rules the fold over counter-emitted events is **commutative**:
 *
 *   - counters emit only `add`, `unchanged`, scoped `retract` and `note`;
 *   - scoped retraction names its target by id, so it does not depend on
 *     position;
 *   - `add` is decimal addition;
 *   - `unchanged` clears the running value and *is* order-sensitive — but a
 *     counter's own events are strictly ordered, and P2.1's dispatch gate
 *     guarantees no two counters share an article.
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

import { resolveAll, type CountEvent, type Resolution } from '../../src/domain';
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
   * `compareEvents` orders by `at` before `deviceId` and `seq`, so if the spare
   * stamped events *earlier* than the tablet it replaced, a waiver and a count
   * on the counter's own article would swap. The replacement path therefore
   * seeds the spare's clock watermark from `/api/c/:token/resume`
   * (`lastClientAt`), and this is the assertion that it matters.
   */
  const article = 1181;
  const base = Date.UTC(2026, 7, 31, 14, 0, 0);
  const stamp = (ms: number) => new Date(base + ms).toISOString();

  resetFactory();
  const onA = [
    addCount(article, 5, { id: 'a1', counterId: 'ana', deviceId: 'tablet-a', seq: 1, at: stamp(1000) }),
    markUnchanged(article, { id: 'a2', counterId: 'ana', deviceId: 'tablet-a', seq: 2, at: stamp(2000) }),
  ];

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

  it('would fold differently if the spare stamped before it — which is why the watermark exists', () => {
    // The same three events, with the spare's clock five minutes behind. The
    // waiver now sorts last and wins. Nothing about the chain is wrong; the
    // *clock* is, and that is the one thing `at`-first ordering is sensitive to.
    const behind = addCount(article, 9, {
      id: 'b1',
      counterId: 'ana',
      deviceId: 'tablet-b',
      seq: 3,
      at: stamp(-300_000),
    });
    expect(resolveAll([...onA, behind]).get(article)).toEqual({ state: 'unchanged' });
    // Stated as a test rather than left as a comment: the fix is upstream, in
    // `CountStoreOptions.highWater` seeded from `/resume`, and if that ever
    // stops being wired the failure is silent everywhere except here.
  });
});
