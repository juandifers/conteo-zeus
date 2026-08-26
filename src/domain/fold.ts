/**
 * Folding an event log into the state of one item (DOMAIN.md §3).
 *
 * The log is append-only, so this fold is the *only* place a "current count"
 * exists. Nothing is stored resolved; a correction is another event.
 */
import { addDecimal } from '../lib/decimal';
import type { CountEvent, CountEventDraft, ItemState } from './types';

/** What an item's events add up to. `qty` is absent unless the item is counted. */
export interface Resolution {
  state: ItemState;
  /** Present only for `counted`. A count of zero is a quantity, not a state (§2). */
  qty?: number;
}

const UNTOUCHED: Resolution = Object.freeze({ state: 'untouched' as const });

/**
 * Total order over events, used before folding.
 *
 * **Never fold in array order.** Stage 2 merges logs from several offline
 * devices, and the array order is then just whichever log was concatenated
 * first — two devices holding the same events would resolve the same item
 * differently, which is the one thing a distributed count cannot afford.
 *
 * Ordering is `(at, deviceId, seq)`:
 *
 * - `at` first, so a later observation wins. Compared as a string, which is
 *   chronological **only** for ISO-8601 instants normalised to UTC — hence the
 *   contract on `CountEventBase.at`, enforced by `appendEvent` (time.ts). A
 *   local-time or offset-bearing stamp would sort wrongly and silently.
 * - `deviceId` next, so two devices that stamp the same millisecond are
 *   ordered identically everywhere. Which device wins is arbitrary; that it is
 *   the *same* device everywhere is not.
 * - `seq` last, monotonic per device, which recovers the true order of taps a
 *   coarse clock stamped identically. Note it only disambiguates *within* a
 *   device — sequence numbers from different devices are not comparable, which
 *   is why `deviceId` is compared first.
 * - `id` is the final tie-break, so the order is total even if the same event
 *   arrives from two paths with a duplicated `(at, deviceId, seq)`.
 */
export function compareEvents(a: CountEvent, b: CountEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function quantity(event: CountEvent & { qty: number }): number {
  if (typeof event.qty !== 'number' || !Number.isFinite(event.qty)) {
    throw new Error(
      `event ${event.id} (${event.kind}, idarticulo ${event.idarticulo}) carries a ` +
        `non-finite qty: ${String(event.qty)}`,
    );
  }
  return event.qty;
}

/**
 * Fold one item's events into its state.
 *
 * Semantics (DOMAIN.md §2, §3):
 *
 * - no events → `untouched`, no quantity. This blocks posting; it is not zero.
 * - `set(q)` → the running value becomes `q`, whatever came before.
 * - `add(q)` → the running value becomes `(current ?? 0) + q`, added decimally
 *   so a tally does not drift into the ERP.
 * - `unchanged` → the state becomes `unchanged` and any running value is
 *   **discarded**. A waiver after a count means the count was withdrawn; the
 *   quantity does not linger where a later `add` could resume from it.
 * - `retract` → the item returns to `untouched`, running value cleared. The
 *   only kind that moves an item *out* of a state that posts; the other three
 *   are one-way, which is why DOMAIN.md §3 added it.
 * - a `set` or `add` after an `unchanged` returns the item to counted, with
 *   `add` resuming from 0 for the same reason.
 * - any resolved quantity, zero included, is `counted`. "I counted zero" is
 *   reported through the variance class (`shortage` against a non-zero book
 *   figure, `none` against an empty one), not through a fourth state — see
 *   §2 on why the two axes stay apart.
 *
 * @param events events for a **single** item. Mixing items is rejected rather
 *   than merged: one `codigo` covers several `idarticulo`s (ZEUS_FORMAT.md §4),
 *   and a fold that quietly summed them is that section's exact failure mode.
 */
export function resolve(events: readonly CountEvent[]): Resolution {
  if (events.length === 0) return UNTOUCHED;

  const idarticulo = events[0].idarticulo;
  for (const event of events) {
    if (event.idarticulo !== idarticulo) {
      throw new Error(
        `resolve() received events for more than one item (${idarticulo} and ` +
          `${event.idarticulo}); fold one item at a time (ZEUS_FORMAT.md §4)`,
      );
    }
  }

  const ordered = events.slice().sort(compareEvents);

  let qty: number | undefined;
  let waived = false;
  for (const event of ordered) {
    switch (event.kind) {
      case 'set':
        qty = quantity(event);
        waived = false;
        break;
      case 'add':
        qty = addDecimal(qty ?? 0, quantity(event));
        waived = false;
        break;
      case 'unchanged':
        qty = undefined;
        waived = true;
        break;
      case 'retract':
        // Back to "nobody looked". The running value goes with it, so a later
        // `add` starts from zero for the same reason it does after a waiver:
        // resuming would restore a number somebody deliberately withdrew.
        qty = undefined;
        waived = false;
        break;
    }
  }

  if (waived) return { state: 'unchanged' };
  if (qty === undefined) return UNTOUCHED;
  return { state: 'counted', qty };
}

/**
 * Fold a whole session's log at once, grouped by `idarticulo`.
 *
 * Items with no events are absent from the map — callers walk the session's
 * items and treat a miss as `untouched`, so an item nobody opened and an item
 * whose events were all withdrawn cannot be confused.
 */
export function resolveAll(events: readonly CountEvent[]): Map<number, Resolution> {
  const byItem = new Map<number, CountEvent[]>();
  for (const event of events) {
    const bucket = byItem.get(event.idarticulo);
    if (bucket) bucket.push(event);
    else byItem.set(event.idarticulo, [event]);
  }

  const resolved = new Map<number, Resolution>();
  for (const [idarticulo, bucket] of byItem) {
    resolved.set(idarticulo, resolve(bucket));
  }
  return resolved;
}

/**
 * A stamp that sorts strictly after every real event.
 *
 * Used to fold a *hypothetical* append without minting an identity for it. The
 * alternative — a second implementation of "what would this draft do" — is a
 * copy of the fold that would drift from it, and the fold is the only thing
 * allowed to know what an event means.
 */
const HYPOTHETICAL = {
  id: '\uffff',
  usuario: '',
  zona: '',
  at: '9999-12-31T23:59:59.999Z',
  deviceId: '\uffff',
  seq: Number.MAX_SAFE_INTEGER,
} as const;

function hypothetically(
  events: readonly CountEvent[],
  draft: CountEventDraft,
): CountEvent {
  return {
    ...HYPOTHETICAL,
    sessionId: events[0]?.sessionId ?? '',
    idarticulo: events[0]?.idarticulo ?? 0,
    ...draft,
  } as CountEvent;
}

/**
 * Whether appending `draft` would move the item at all.
 *
 * The predicate every "is this control available" question should be asked
 * through. A screen that decides for itself when there is nothing to undo — or
 * nothing to withdraw — has reimplemented the fold in a component, and the two
 * copies disagree the first time the fold changes.
 */
export function changesResolution(
  events: readonly CountEvent[],
  draft: CountEventDraft,
): boolean {
  const before = resolve(events);
  const after = resolve([...events, hypothetically(events, draft)]);
  return before.state !== after.state || before.qty !== after.qty;
}

/**
 * The event to append in order to undo the last one (DOMAIN.md §3).
 *
 * Undo lives here rather than in a component because undoing a `set` has to
 * restore the *previous resolution*, and only a fold knows what that was. The
 * rule is uniform: find the last event in fold order, resolve the log without
 * it, and append whatever restates that answer.
 *
 *     prior resolution   append
 *     counted p          set(p)
 *     unchanged          unchanged
 *     untouched          retract
 *
 * with one specialisation: when the last event is an `add` **and** the prior
 * resolution is a quantity, `add(-q)` restores it exactly and keeps a tally's
 * log readable as the sequence of taps it was.
 *
 * That specialisation is deliberately *not* unconditional, though DOMAIN.md §3's
 * table states it that way. `add(-q)` restores the prior *value*, not the prior
 * *state*: undoing the first tap of a tally with `add(-1)` leaves the item
 * `counted` at 0 — a full write-off of the book figure — and undoing an `add`
 * that followed a waiver leaves it counted at 0 rather than waived. Both are
 * exactly the "overwritten with a number nobody counted" outcome `retract` was
 * introduced to end, so the shortcut applies only where it is equivalent.
 *
 * Every case is an append. `null` means there is nothing to undo: an empty log,
 * or a candidate that would leave the resolution exactly where it is — which is
 * what keeps a retraction of an already-untouched item out of the log, and is
 * the only thing a disabled undo button may be derived from.
 */
export function undoLast(events: readonly CountEvent[]): CountEventDraft | null {
  if (events.length === 0) return null;
  // Resolving the whole log first is not wasted work: it is what rejects a
  // mixed-item array, and a one-event log would otherwise skip the check.
  resolve(events);

  const ordered = events.slice().sort(compareEvents);
  const last = ordered[ordered.length - 1];
  const prior = resolve(ordered.slice(0, -1));

  const draft = candidateFor(last, prior);
  return changesResolution(events, draft) ? draft : null;
}

function candidateFor(last: CountEvent, prior: Resolution): CountEventDraft {
  if (last.kind === 'add' && prior.state === 'counted') {
    return { kind: 'add', qty: -last.qty };
  }
  switch (prior.state) {
    case 'counted':
      return { kind: 'set', qty: prior.qty! };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'untouched':
      return { kind: 'retract' };
  }
}
