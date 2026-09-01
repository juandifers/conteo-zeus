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
 * **Never fold in array order.** A session's log is merged from several offline
 * devices, and the array order is then just whichever log was concatenated
 * first — two devices holding the same events would resolve the same item
 * differently, which is the one thing a distributed count cannot afford.
 *
 * There are two orders here, and which one applies is decided by one question:
 * **do these two events belong to the same counter?**
 *
 * ## Within one counter: `seq`, and nothing else
 *
 * `seq` is allocated per counter — `unique (counter_id, seq)` on the server,
 * continued onto a replacement tablet by `GET /api/c/:token/resume` — so within
 * one counter it *is* the causal order, whatever any clock says. Ordering their
 * events by `at` first was a real bug rather than a tidiness complaint: a
 * counter who moves to a spare tablet whose clock runs nine minutes slow stamps
 * events that sort **before** the ones they continue, and for that counter's own
 * article the difference is a correction losing to the value it was correcting.
 *
 * The resume watermark (`CountStoreOptions.highWater`) does hold that shut, but
 * only by clamping the spare's `at` up to the last one the server saw — which
 * makes the two events *equal* on the first key and hands the decision to the
 * lexicographic order of two uuids. A tie-break deciding which of a counter's
 * own taps came first is not an ordering, it is a coin. The watermark stays
 * because it keeps the audit timeline on the acta readable, which is what it
 * should have been doing; it is no longer what keeps a total right.
 *
 * P1 events have no `counterId`, so this branch never fires for them and their
 * logs fold exactly as they did — asserted by `tests/domain/migration.test.ts`,
 * which is the reason it is safe to change this at all.
 *
 * ## Across counters: `(at, deviceId, seq, counterId, id)`
 *
 * - `at` first, so a later observation wins. Compared as a string, which is
 *   chronological **only** for ISO-8601 instants normalised to UTC — hence the
 *   contract on `CountEventBase.at`, enforced by `appendEvent` (time.ts). A
 *   local-time or offset-bearing stamp would sort wrongly and silently.
 * - `deviceId` next, so two devices that stamp the same millisecond are
 *   ordered identically everywhere. Which device wins is arbitrary; that it is
 *   the *same* device everywhere is not.
 * - `seq` next. Across counters it is not a comparable ordinal — which is why
 *   `deviceId` is compared first — but it is still a stable number.
 * - `counterId`, because two tokens open on one tablet produce the same
 *   `deviceId`, the same `at` and the same `seq` for two genuinely different
 *   events. Without it the comparator returns 0 for a distinct pair, the order
 *   stops being total, and the fold stops being deterministic with nothing
 *   anywhere saying so.
 * - `id` last, so the order is total even if the same `(at, deviceId, seq,
 *   counterId)` arrives twice.
 */
export function compareEvents(a: CountEvent, b: CountEvent): number {
  // One counter's own events, in the order that counter recorded them.
  if (a.counterId !== undefined && a.counterId === b.counterId) {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.counterId !== b.counterId) return (a.counterId ?? '') < (b.counterId ?? '') ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** An event about one article: everything except `finish`, `reopen` and a session-wide `note`. */
export type ItemEvent = CountEvent & { idarticulo: number };

/**
 * Does this event belong to an item's fold?
 *
 * The one place the `idarticulo: number | null` widening is answered. Every
 * caller that groups a log by the primary key has to say what it does with the
 * session-scoped kinds, and saying it through this guard means the answer is
 * a filter with a name rather than a non-null assertion.
 */
export function isItemEvent(event: CountEvent): event is ItemEvent {
  return event.idarticulo !== null;
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
 * - `retract` naming a `retractsEventId` → that **one event** is withdrawn, and
 *   so is the retraction itself; the rest of the log folds as if neither had
 *   been written. Event-scoped because a whole-item withdrawal under several
 *   counters is a data-loss bug: Ana retracting her own mis-tap would silently
 *   discard Luis's count of the same article.
 * - `retract` with **no** `retractsEventId` → the P1 whole-item withdrawal: the
 *   item returns to `untouched`, running value cleared. Preserved exactly, for
 *   the events already in the database and for them alone.
 * - `note` → nothing. It asserts nothing about the stock.
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
    if (event.idarticulo === null) {
      throw new Error(
        `resolve() received a session-scoped ${event.kind} event (${event.id}), ` +
          'which is about the session and not about an item. Drop these before ' +
          'folding — resolveAll() does (ZEUS_FORMAT.md §4)',
      );
    }
    if (event.idarticulo !== idarticulo) {
      throw new Error(
        `resolve() received events for more than one item (${idarticulo} and ` +
          `${event.idarticulo}); fold one item at a time (ZEUS_FORMAT.md §4)`,
      );
    }
  }

  // Step 1: every event a scoped retraction names.
  //
  // Collected before anything is folded, and by *name* rather than by position,
  // which is the property that keeps merging several offline logs a sort. A
  // retraction that arrives after its target, before it, or from another
  // device's log withdraws exactly the same event either way.
  const withdrawn = new Set<string>();
  for (const event of events) {
    if (event.kind === 'retract' && event.retractsEventId !== undefined) {
      withdrawn.add(event.retractsEventId);
    }
  }

  // Step 2: drop the withdrawn events, and drop the scoped retractions
  // themselves — they have said what they had to say. A scoped retraction of a
  // scoped retraction therefore does nothing, which is deliberate: undoing an
  // undo by resurrection would make the fold depend on the order two
  // withdrawals arrived in, and that is the one thing this design buys.
  const survivors = withdrawn.size === 0
    ? events
    : events.filter(
        (event) =>
          !withdrawn.has(event.id) &&
          !(event.kind === 'retract' && event.retractsEventId !== undefined),
      );

  // Step 3: fold the survivors under the existing rules.
  const ordered = survivors.slice().sort(compareEvents);

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
        // Step 4: an *unscoped* retraction — one with no `retractsEventId`.
        // Only P1 wrote these, and they keep P1 semantics exactly: as of this
        // event the item is untouched and the running value is cleared, so a
        // later `add` starts from zero for the same reason it does after a
        // waiver.
        //
        // This is not politeness toward old data. DOMAIN.md §6 records that
        // sessions predating later checks are still in the database, and a
        // session that folds to a different number after an upgrade is a
        // session whose `ExportRecord` no longer describes it.
        qty = undefined;
        waived = false;
        break;
      case 'note':
        // A remark asserts nothing about the stock, so it moves nothing. It is
        // in the item's bucket because it is *about* the item.
        break;
      case 'finish':
      case 'reopen':
        // Unreachable: both carry `idarticulo: null` and the guard above
        // rejected them. Named rather than defaulted, so that adding a kind is
        // a compile error here instead of a silent no-op.
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
    // Session-scoped kinds — `finish`, `reopen`, and a `note` about no
    // particular article — have no primary key and so no bucket. Dropped here
    // rather than rejected, because this is the function that gets handed a
    // whole session's log and a whole session's log contains them.
    if (event.idarticulo === null) continue;
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
 * The events a scoped retraction has already withdrawn.
 *
 * Shared with `resolve`'s step 1 in spirit but computed separately, because
 * `undoLast` needs the *set* rather than the fold: "what is still standing" is
 * the question undo asks, and the fold has thrown that away by the time it
 * returns a `Resolution`.
 */
function withdrawnIds(events: readonly CountEvent[]): Set<string> {
  const withdrawn = new Set<string>();
  for (const event of events) {
    if (event.kind === 'retract' && event.retractsEventId !== undefined) {
      withdrawn.add(event.retractsEventId);
    }
  }
  return withdrawn;
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
 * Undo lives here rather than in a component because only a fold knows which
 * event is last and whether it is still standing. With scoped retraction
 * available (`RetractEvent.retractsEventId`) the rule collapses to one line:
 *
 *     retract(the last event this counter wrote that has not already been withdrawn)
 *
 * and that is the whole of it. The `add(-q)` special case is gone. It existed
 * only to keep a tally's running value correct without a targeted withdrawal —
 * `add(-1)` after a first tap restores the *value* but lands on `counted 0`, a
 * write-off of the whole book figure, which is the outcome `retract` was
 * introduced to end. Now that a withdrawal can name its target, the substitute
 * is strictly worse than the thing it substituted for.
 *
 * Restoring the prior resolution falls out rather than being computed: with the
 * last `set` withdrawn, the `set` before it is what the log folds to.
 *
 * **A scoped retraction is never itself a target.** `resolve` drops them before
 * folding, so withdrawing one would do nothing; undo walks past them to the
 * last event still standing. Repeated undo is therefore a stack: `add(1)
 * add(2)` undoes to `add(1)` and then to `untouched`.
 *
 * An **unscoped** retraction *is* a target — undoing the "descartar conteo"
 * button has to bring the count back, or the button is one-way — and
 * withdrawing it by name restores everything it took, because the fold then
 * never sees it.
 *
 * @param counterId when given, undo is scoped to that counter's own events —
 *   DOMAIN.md §6: a counter may withdraw only what they wrote, which needs no
 *   cross-device agreement and no clock at all. Withdrawing somebody else's
 *   count is a supervisor action, where the two-person step is the safeguard.
 *   Omitted, it is the whole log, which is P1's single-counter case and what
 *   the existing callers pass.
 *
 * Returns `null` when there is nothing to undo: an empty log, no standing event
 * belonging to this counter, or a candidate that would leave the resolution
 * exactly where it is. That last case is the only thing a disabled undo button
 * may be derived from — a component with its own rule for it has reimplemented
 * the fold. Note it does mean that under several counters, withdrawing an event
 * another counter's later `set` has already overridden reads as "nothing to
 * undo": the log would change, the number would not, and undo is about the
 * number.
 */
export function undoLast(
  events: readonly CountEvent[],
  counterId?: string,
): CountEventDraft | null {
  if (events.length === 0) return null;
  // Resolving the whole log first is not wasted work: it is what rejects a
  // mixed-item array, and a one-event log would otherwise skip the check.
  resolve(events);

  const withdrawn = withdrawnIds(events);
  const standing = events
    .filter((event) => !withdrawn.has(event.id))
    // A **scoped** retraction is not a target. The fold drops it before
    // folding, so withdrawing one would change nothing, and "undo the undo by
    // resurrection" would make the answer depend on the order two withdrawals
    // arrived in — the one thing this design buys.
    //
    // An **unscoped** one is. It is P1's whole-item withdrawal, the event the
    // "descartar conteo" button writes, and undoing it has to bring the count
    // back or the button is one-way. Withdrawing it by name is not the
    // reversal DOMAIN.md §6 rules out: that was a clock silently overriding
    // somebody's decision, and this is the person who made the decision naming
    // it. Order-independent, no clock involved.
    .filter((event) => !(event.kind === 'retract' && event.retractsEventId !== undefined))
    .filter((event) => counterId === undefined || event.counterId === counterId)
    .sort(compareEvents);

  const last = standing[standing.length - 1];
  if (!last) return null;

  const draft: CountEventDraft = { kind: 'retract', retractsEventId: last.id };
  return changesResolution(events, draft) ? draft : null;
}
