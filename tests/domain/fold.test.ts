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
  /** The one shape undo returns now: a withdrawal that names its target. */
  const withdraws = (id: string) => ({ kind: 'retract', retractsEventId: id });

  it('is null on an empty log', () => {
    expect(undoLast([])).toBeNull();
  });

  it('withdraws the last event rather than restating the prior resolution', () => {
    // The rule is one line now: retract the last standing event. Restoring the
    // previous resolution falls out of the fold rather than being computed —
    // with the last `set` withdrawn, the `set` before it is what the log says.
    const first = setCount(ITEM, 5);
    const second = setCount(ITEM, 50);
    expect(undoLast([first, second])).toEqual(withdraws(second.id));
    expect(resolve([first, second, retract(ITEM, { retractsEventId: second.id })])).toEqual({
      state: 'counted',
      qty: 5,
    });
  });

  it('walks a tally back one tap at a time, without add(-q)', () => {
    // `add(-q)` is gone. It restored the prior *value* and not the prior
    // *state*: undoing a first tap with `add(-1)` lands on `counted 0`, a full
    // write-off of the book figure, which is what `retract` was introduced to
    // end. A targeted withdrawal has no such failure mode, so the substitute is
    // now strictly worse than the thing it substituted for.
    const one = addCount(ITEM, 1);
    const two = addCount(ITEM, 1);
    expect(undoLast([one, two])).toEqual(withdraws(two.id));
    expect(resolve([one, two, retract(ITEM, { retractsEventId: two.id })])).toEqual({
      state: 'counted',
      qty: 1,
    });

    // And the first tap, where `add(-1)` was actively wrong.
    expect(undoLast([one])).toEqual(withdraws(one.id));
    expect(resolve([one, retract(ITEM, { retractsEventId: one.id })])).toEqual({
      state: 'untouched',
    });
  });

  it('restores a waiver a later count replaced', () => {
    const waiver = markUnchanged(ITEM);
    const count = setCount(ITEM, 3);
    expect(undoLast([waiver, count])).toEqual(withdraws(count.id));
    expect(resolve([waiver, count, retract(ITEM, { retractsEventId: count.id })])).toEqual({
      state: 'unchanged',
    });
  });

  it('undoes a waiver back to the count it withdrew', () => {
    const count = setCount(ITEM, 97.5);
    const waiver = markUnchanged(ITEM);
    expect(undoLast([count, waiver])).toEqual(withdraws(waiver.id));
    expect(resolve([count, waiver, retract(ITEM, { retractsEventId: waiver.id })])).toEqual({
      state: 'counted',
      qty: 97.5,
    });
  });

  it('is a stack: repeated undo walks back through the log', () => {
    const one = addCount(ITEM, 1);
    const two = addCount(ITEM, 2);
    const undoTwo = retract(ITEM, { retractsEventId: two.id });
    expect(undoLast([one, two])).toEqual(withdraws(two.id));
    // Having withdrawn the second tap, the next undo reaches the first — it
    // does not try to withdraw the withdrawal, which would resurrect the tap.
    expect(undoLast([one, two, undoTwo])).toEqual(withdraws(one.id));
    const undoOne = retract(ITEM, { retractsEventId: one.id });
    expect(resolve([one, two, undoTwo, undoOne])).toEqual({ state: 'untouched' });
    expect(undoLast([one, two, undoTwo, undoOne])).toBeNull();
  });

  it('never targets a scoped retraction', () => {
    // The fold drops them before folding, so withdrawing one changes nothing —
    // and "undo the undo by resurrection" would make the answer depend on the
    // order two withdrawals arrived in.
    const count = setCount(ITEM, 5);
    const undone = retract(ITEM, { retractsEventId: count.id });
    expect(undoLast([count, undone])).toBeNull();
  });

  it('does target an unscoped one, so discarding a count stays reversible', () => {
    // The "descartar conteo" button writes P1's whole-item withdrawal. Undoing
    // it has to bring the count back or the button is one-way, and withdrawing
    // it *by name* is not the clock-driven reversal DOMAIN.md §6 rules out: it
    // is the person who made the decision naming it, order-independently.
    const count = setCount(ITEM, 5);
    const discard = retract(ITEM);
    expect(undoLast([count, discard])).toEqual(withdraws(discard.id));
    expect(
      resolve([count, discard, retract(ITEM, { retractsEventId: discard.id })]),
    ).toEqual({ state: 'counted', qty: 5 });

    // But not when there was nothing to bring back.
    expect(undoLast([retract(ITEM)])).toBeNull();
  });

  it('scopes to one counter when asked, and finds nothing when they wrote nothing', () => {
    // DOMAIN.md §6: a counter may withdraw only what they wrote, which needs no
    // cross-device agreement and no clock at all.
    const ana = setCount(ITEM, 5, { counterId: 'ana' });
    const luis = addCount(ITEM, 2, { counterId: 'luis' });
    expect(undoLast([ana, luis], 'luis')).toEqual(withdraws(luis.id));
    expect(undoLast([ana, luis], 'nobody')).toBeNull();
    // Unscoped is the P1 single-counter case and still reaches the last event.
    expect(undoLast([ana, luis])).toEqual(withdraws(luis.id));
  });

  it("is null when withdrawing this counter's event would not move the number", () => {
    // Ana counted 5; Luis later counted 7 over the top of it. Withdrawing Ana's
    // event changes the log and not the resolution, and undo is about the
    // resolution — the documented meaning of `null`, and the only thing a
    // disabled undo button may be derived from.
    const ana = setCount(ITEM, 5, { counterId: 'ana' });
    const luis = setCount(ITEM, 7, { counterId: 'luis' });
    expect(undoLast([ana, luis], 'ana')).toBeNull();
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
