/**
 * The fold — DOMAIN.md §2 and §3.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  changesResolution,
  compareEvents,
  resolve,
  resolveAll,
  undoLast,
} from '../../src/domain';
import { addCount, markUnchanged, resetFactory, retract, setCount } from './factory';

const ITEM = 1181; // PANCETA SV / KILO

beforeEach(resetFactory);

describe('resolve — states (§2)', () => {
  it('an item nobody touched is untouched, and carries no quantity', () => {
    const resolution = resolve([]);
    expect(resolution.state).toBe('untouched');
    expect(resolution.qty).toBeUndefined();
    expect('qty' in resolution).toBe(false);
  });

  it('set replaces the running value', () => {
    expect(resolve([setCount(ITEM, 97.5)])).toEqual({ state: 'counted', qty: 97.5 });
    expect(resolve([setCount(ITEM, 10), setCount(ITEM, 12)])).toEqual({
      state: 'counted',
      qty: 12,
    });
  });

  it('add accumulates from zero', () => {
    expect(resolve([addCount(ITEM, 3), addCount(ITEM, 4)])).toEqual({
      state: 'counted',
      qty: 7,
    });
  });

  it('add continues from a set', () => {
    expect(resolve([setCount(ITEM, 20), addCount(ITEM, 2.5)])).toEqual({
      state: 'counted',
      qty: 22.5,
    });
  });

  it('a count of zero is counted, carrying zero — a quantity, not a state (§2)', () => {
    const zero = resolve([setCount(ITEM, 0)]);
    expect(zero).toEqual({ state: 'counted', qty: 0 });
    // The two that look alike to a careless reader: only one may post, and the
    // difference is the presence of a quantity, not a fourth state.
    expect(resolve([]).state).toBe('untouched');
    expect('qty' in resolve([])).toBe(false);
  });

  it('a tally that nets to zero is a count of zero, not an absence', () => {
    expect(resolve([addCount(ITEM, 5), addCount(ITEM, -5)])).toEqual({
      state: 'counted',
      qty: 0,
    });
  });

  it('unchanged carries no quantity and discards any running value', () => {
    const resolution = resolve([setCount(ITEM, 40), markUnchanged(ITEM)]);
    expect(resolution).toEqual({ state: 'unchanged' });
    expect(resolution.qty).toBeUndefined();
  });

  it('a set after an unchanged returns the item to counted', () => {
    expect(resolve([markUnchanged(ITEM), setCount(ITEM, 8)])).toEqual({
      state: 'counted',
      qty: 8,
    });
  });

  it('an add after an unchanged resumes from 0, not from the withdrawn count', () => {
    // The withdrawn 40 must not come back: the waiver said the count was wrong.
    expect(resolve([setCount(ITEM, 40), markUnchanged(ITEM), addCount(ITEM, 3)])).toEqual({
      state: 'counted',
      qty: 3,
    });
  });

  it('keeps the waiver reason out of the fold — it is for the log, not the count', () => {
    expect(resolve([markUnchanged(ITEM, { motivo: 'nevera sellada' })])).toEqual({
      state: 'unchanged',
    });
  });
});

describe('resolve — ordering is deterministic and merge-safe', () => {
  it('folds by (at, deviceId, seq), not by array order', () => {
    const first = setCount(ITEM, 10, { at: '2026-08-25T10:00:00.000Z', seq: 1 });
    const second = setCount(ITEM, 25, { at: '2026-08-25T11:00:00.000Z', seq: 2 });

    expect(resolve([first, second]).qty).toBe(25);
    expect(resolve([second, first]).qty).toBe(25); // the array order changed; the answer did not
  });

  it('gives the same answer for every permutation of a mixed log', () => {
    const events = [
      setCount(ITEM, 10, { at: '2026-08-25T10:00:00.000Z', deviceId: 'a', seq: 1 }),
      addCount(ITEM, 5, { at: '2026-08-25T10:00:01.000Z', deviceId: 'b', seq: 1 }),
      markUnchanged(ITEM, { at: '2026-08-25T10:00:02.000Z', deviceId: 'a', seq: 2 }),
      setCount(ITEM, 3, { at: '2026-08-25T10:00:03.000Z', deviceId: 'b', seq: 2 }),
      addCount(ITEM, 1.5, { at: '2026-08-25T10:00:04.000Z', deviceId: 'a', seq: 3 }),
    ];

    const expected = { state: 'counted', qty: 4.5 };
    // All 120 orderings — this is what an arbitrary merge of two device logs is.
    for (const permutation of permutations(events)) {
      expect(resolve(permutation)).toEqual(expected);
    }
  });

  it('breaks a same-millisecond tie on deviceId, identically on every device', () => {
    const at = '2026-08-25T10:00:00.000Z';
    const fromA = setCount(ITEM, 10, { at, deviceId: 'device-a', seq: 1 });
    const fromB = setCount(ITEM, 20, { at, deviceId: 'device-b', seq: 1 });

    // Which one wins is arbitrary; that both devices agree is not.
    expect(resolve([fromA, fromB]).qty).toBe(20);
    expect(resolve([fromB, fromA]).qty).toBe(20);
  });

  it('orders taps a coarse clock stamped identically by seq', () => {
    const at = '2026-08-25T10:00:00.000Z';
    const events = [
      setCount(ITEM, 5, { at, seq: 1 }),
      setCount(ITEM, 6, { at, seq: 2 }),
      setCount(ITEM, 7, { at, seq: 10 }),
      setCount(ITEM, 8, { at, seq: 3 }),
    ];
    // seq 10 is last: numeric, not lexicographic ("10" < "3" as strings).
    expect(resolve(events).qty).toBe(7);
  });

  it('is a total order even when (at, deviceId, seq) collide', () => {
    const at = '2026-08-25T10:00:00.000Z';
    const one = setCount(ITEM, 1, { id: 'aaa', at, seq: 1 });
    const two = setCount(ITEM, 2, { id: 'bbb', at, seq: 1 });
    expect(compareEvents(one, two)).toBeLessThan(0);
    expect(compareEvents(two, one)).toBeGreaterThan(0);
    expect(compareEvents(one, one)).toBe(0);
    expect(resolve([two, one]).qty).toBe(2);
  });

  it('does not mutate the caller’s array', () => {
    const events = [
      setCount(ITEM, 1, { at: '2026-08-25T12:00:00.000Z' }),
      setCount(ITEM, 2, { at: '2026-08-25T09:00:00.000Z' }),
    ];
    const before = events.slice();
    resolve(events);
    expect(events).toEqual(before);
  });
});

describe('resolve — decimal accumulation (§3)', () => {
  it('a tally of 0.1 does not drift', () => {
    const events = Array.from({ length: 10 }, () => addCount(ITEM, 0.1));
    expect(resolve(events).qty).toBe(1);
  });

  it('the 21 - 20.8 case, arrived at by tally', () => {
    const events = [setCount(ITEM, 20.8), addCount(ITEM, 0.2)];
    expect(resolve(events).qty).toBe(21);
  });

  it('would have drifted under plain addition', () => {
    let plain = 0;
    for (let i = 0; i < 10; i++) plain += 0.1;
    expect(plain).not.toBe(1);
  });
});

describe('resolve — guards', () => {
  it('refuses to fold two items at once (§4)', () => {
    // 0103005 covers three idarticulos; summing them is the silent merge §4 warns of.
    expect(() => resolve([setCount(1181, 97.5), setCount(330, 30)])).toThrow(
      /more than one item/,
    );
  });

  it('rejects a non-finite quantity rather than writing NaN into the ERP', () => {
    expect(() => resolve([setCount(ITEM, Number.NaN)])).toThrow(/non-finite qty/);
    expect(() => resolve([addCount(ITEM, Number.POSITIVE_INFINITY)])).toThrow(
      /non-finite qty/,
    );
  });
});

describe('resolveAll', () => {
  it('groups by idarticulo and folds each independently', () => {
    const resolved = resolveAll([
      setCount(1181, 97.5),
      setCount(330, 0),
      markUnchanged(2660),
      addCount(1181, 2.5),
    ]);
    expect(resolved.get(1181)).toEqual({ state: 'counted', qty: 100 });
    expect(resolved.get(330)).toEqual({ state: 'counted', qty: 0 });
    expect(resolved.get(2660)).toEqual({ state: 'unchanged' });
  });

  it('omits items with no events, so a miss means untouched', () => {
    const resolved = resolveAll([setCount(1181, 1)]);
    expect(resolved.has(330)).toBe(false);
    expect(resolved.size).toBe(1);
  });
});

describe('retract — the way back to untouched (§3)', () => {
  it('returns a counted item to untouched, carrying no quantity', () => {
    const resolution = resolve([setCount(ITEM, 97.5), retract(ITEM)]);
    expect(resolution).toEqual({ state: 'untouched' });
    expect('qty' in resolution).toBe(false);
  });

  it('withdraws a waiver too — "untouched" means nobody looked, full stop', () => {
    expect(resolve([markUnchanged(ITEM), retract(ITEM)])).toEqual({ state: 'untouched' });
  });

  it('clears the running value, so a later add starts from zero', () => {
    // The same rule as after a waiver, and for the same reason: resuming would
    // silently restore a number somebody deliberately withdrew.
    expect(resolve([addCount(ITEM, 40), retract(ITEM), addCount(ITEM, 1)])).toEqual({
      state: 'counted',
      qty: 1,
    });
  });

  it('is not terminal: a set after it counts normally', () => {
    expect(resolve([setCount(ITEM, 12), retract(ITEM), setCount(ITEM, 97.5)])).toEqual({
      state: 'counted',
      qty: 97.5,
    });
  });

  it('is idempotent — two withdrawals are still one untouched item', () => {
    expect(resolve([setCount(ITEM, 5), retract(ITEM), retract(ITEM)])).toEqual({
      state: 'untouched',
    });
  });

  it('loses to a later count, whatever order the array arrived in', () => {
    const events = [setCount(ITEM, 5), retract(ITEM), setCount(ITEM, 9)];
    for (const order of permutations(events)) {
      expect(resolve(order)).toEqual({ state: 'counted', qty: 9 });
    }
  });
});

describe('undoLast — the event to append (§3)', () => {
  it('is null on an empty log', () => {
    expect(undoLast([])).toBeNull();
  });

  it('walks a tally back one tap, as an add', () => {
    const log = [addCount(ITEM, 1), addCount(ITEM, 1)];
    expect(undoLast(log)).toEqual({ kind: 'add', qty: -1 });
    expect(resolve([...log, addCount(ITEM, -1)])).toEqual({ state: 'counted', qty: 1 });
  });

  it('restores the previous quantity after a set', () => {
    const log = [setCount(ITEM, 5), setCount(ITEM, 50)];
    expect(undoLast(log)).toEqual({ kind: 'set', qty: 5 });
  });

  it('restores a waiver a later count replaced', () => {
    const log = [markUnchanged(ITEM), setCount(ITEM, 3)];
    expect(undoLast(log)).toEqual({ kind: 'unchanged' });
  });

  it('retracts when the prior resolution was untouched', () => {
    expect(undoLast([setCount(ITEM, 5)])).toEqual({ kind: 'retract' });
    expect(undoLast([markUnchanged(ITEM)])).toEqual({ kind: 'retract' });
  });

  it('undoes a waiver back to the count it withdrew', () => {
    const log = [setCount(ITEM, 97.5), markUnchanged(ITEM)];
    expect(undoLast(log)).toEqual({ kind: 'set', qty: 97.5 });
  });

  it('undoes a retraction back to whatever it withdrew', () => {
    expect(undoLast([setCount(ITEM, 97.5), retract(ITEM)])).toEqual({
      kind: 'set',
      qty: 97.5,
    });
    expect(undoLast([markUnchanged(ITEM), retract(ITEM)])).toEqual({ kind: 'unchanged' });
  });

  it('does not use add(-q) where it would restore the wrong state', () => {
    // DOMAIN.md §3's table states the `add` case unconditionally. It restores
    // the prior *value*, which is only the prior *state* when there was a
    // quantity to go back to. A first tap has none, and an add after a waiver
    // has none either — both would land on `counted 0`, a full write-off of
    // the book figure, which is exactly what `retract` was introduced to end.
    expect(undoLast([addCount(ITEM, 1)])).toEqual({ kind: 'retract' });
    expect(undoLast([markUnchanged(ITEM), addCount(ITEM, 1)])).toEqual({
      kind: 'unchanged',
    });
  });

  it('is null when the event it would append would change nothing', () => {
    // A retraction of an already-untouched item used to come back as a
    // legitimate answer: a no-op event written into an append-only log for the
    // sake of a uniform table. `undoLast` now asks whether the candidate moves
    // the item at all, which is also the only rule a disabled button may read.
    expect(undoLast([retract(ITEM)])).toBeNull();
    expect(undoLast([setCount(ITEM, 5), retract(ITEM), retract(ITEM)])).toBeNull();
  });

  it('is null when undoing a repeat that changed nothing', () => {
    expect(undoLast([setCount(ITEM, 5), setCount(ITEM, 5)])).toBeNull();
    expect(undoLast([markUnchanged(ITEM), markUnchanged(ITEM)])).toBeNull();
    expect(undoLast([setCount(ITEM, 5), addCount(ITEM, 0)])).toBeNull();
  });

  it('rejects a mixed-item log, like every other fold here', () => {
    expect(() => undoLast([setCount(1181, 1), setCount(330, 1)])).toThrow(
      /more than one item/,
    );
  });
});

describe('changesResolution — would this move the item?', () => {
  it('says no to a withdrawal of something nobody touched', () => {
    expect(changesResolution([], { kind: 'retract' })).toBe(false);
    expect(changesResolution([setCount(ITEM, 5), retract(ITEM)], { kind: 'retract' })).toBe(
      false,
    );
  });

  it('says yes to a withdrawal of a count or a waiver', () => {
    expect(changesResolution([setCount(ITEM, 5)], { kind: 'retract' })).toBe(true);
    expect(changesResolution([markUnchanged(ITEM)], { kind: 'retract' })).toBe(true);
  });

  it('compares the resolution, not the event', () => {
    // Same quantity twice is a second event and an unchanged resolution.
    expect(changesResolution([setCount(ITEM, 5)], { kind: 'set', qty: 5 })).toBe(false);
    expect(changesResolution([setCount(ITEM, 5)], { kind: 'set', qty: 6 })).toBe(true);
    expect(changesResolution([setCount(ITEM, 5)], { kind: 'add', qty: 0 })).toBe(false);
  });

  it('folds the candidate last, whatever the log already holds', () => {
    // The hypothetical stamp has to sort after every real event or the answer
    // is about some other item's history.
    const log = [setCount(ITEM, 1, { at: '2099-01-01T00:00:00.000Z', seq: 99 })];
    expect(changesResolution(log, { kind: 'retract' })).toBe(true);
  });
});

/** Every ordering of a small array. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}
