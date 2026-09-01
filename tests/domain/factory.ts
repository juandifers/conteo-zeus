/**
 * Event builders for the domain tests.
 *
 * Defaults are deliberate: one device, one user, an `at` that advances by a
 * second per event and a `seq` that advances by one. A test that cares about
 * ordering overrides them explicitly, so the ordering under test is always
 * visible in the test itself rather than inherited from here.
 *
 * `at` is built through `Date#toISOString` rather than by string arithmetic,
 * because `appendEvent` rejects anything that is not a normalised UTC instant
 * (DOMAIN.md §3) — and formatting seconds by hand produces `10:00:60.000Z`
 * once a test passes sixty events.
 */
import type {
  AddCountEvent,
  FinishEvent,
  NoteEvent,
  ReopenEvent,
  RetractEvent,
  SetCountEvent,
  UnchangedEvent,
} from '../../src/domain';

export const SESSION_ID = 'session-1';

/** 2026-08-25T10:00:00.000Z. Events advance one second from here. */
const EPOCH = Date.UTC(2026, 7, 25, 10, 0, 0);

let counter = 0;

/** Reset the auto-incrementing id/at/seq, so each test reads independently. */
export function resetFactory(): void {
  counter = 0;
}

interface Overrides {
  id?: string;
  sessionId?: string;
  /**
   * Absent by default, because that is the shape of every event already in the
   * database: P1 did not have one. A test about the chain, or about scoping
   * undo to a counter, says so by passing it.
   */
  counterId?: string;
  usuario?: string;
  zona?: string;
  at?: string;
  deviceId?: string;
  seq?: number;
}

function base(idarticulo: number | null, over: Overrides) {
  const n = counter++;
  return {
    id: over.id ?? `e${n}`,
    sessionId: over.sessionId ?? SESSION_ID,
    ...(over.counterId === undefined ? {} : { counterId: over.counterId }),
    idarticulo,
    usuario: over.usuario ?? 'ana',
    zona: over.zona ?? 'A1',
    at: over.at ?? new Date(EPOCH + n * 1000).toISOString(),
    deviceId: over.deviceId ?? 'device-a',
    seq: over.seq ?? n,
  };
}

export function setCount(idarticulo: number, qty: number, over: Overrides = {}): SetCountEvent {
  return { ...base(idarticulo, over), kind: 'set', qty };
}

export function addCount(idarticulo: number, qty: number, over: Overrides = {}): AddCountEvent {
  return { ...base(idarticulo, over), kind: 'add', qty };
}

/**
 * A withdrawal (DOMAIN.md §3).
 *
 * With `retractsEventId`, it withdraws that one event. Without, it is P1's
 * whole-item withdrawal — which is what the default builds, because that is
 * what is already in the database and what the migration test has to keep
 * folding the same way.
 */
export function retract(
  idarticulo: number,
  over: Overrides & { retractsEventId?: string } = {},
): RetractEvent {
  const { retractsEventId, ...rest } = over;
  return {
    ...base(idarticulo, rest),
    kind: 'retract',
    ...(retractsEventId === undefined ? {} : { retractsEventId }),
  };
}

/** A remark. Folds to nothing; `idarticulo` is null when it is not about one article. */
export function note(
  idarticulo: number | null,
  texto: string,
  over: Overrides = {},
): NoteEvent {
  return { ...base(idarticulo, over), kind: 'note', texto, idarticulo };
}

/** "I am done", with the manifest that makes the claim checkable. */
export function finish(
  finalSeq: number,
  headHash: string,
  over: Overrides = {},
): FinishEvent {
  return { ...base(null, over), kind: 'finish', idarticulo: null, finalSeq, headHash };
}

/** Withdraws a `finish`. */
export function reopen(over: Overrides = {}): ReopenEvent {
  return { ...base(null, over), kind: 'reopen', idarticulo: null };
}

export function markUnchanged(
  idarticulo: number,
  over: Overrides & { motivo?: string } = {},
): UnchangedEvent {
  const { motivo, ...rest } = over;
  return { ...base(idarticulo, rest), kind: 'unchanged', ...(motivo ? { motivo } : {}) };
}
