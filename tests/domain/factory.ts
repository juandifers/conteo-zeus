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
  usuario?: string;
  zona?: string;
  at?: string;
  deviceId?: string;
  seq?: number;
}

function base(idarticulo: number, over: Overrides) {
  const n = counter++;
  return {
    id: over.id ?? `e${n}`,
    sessionId: over.sessionId ?? SESSION_ID,
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

/** A withdrawal: back to `untouched`, nothing deleted (DOMAIN.md §3). */
export function retract(idarticulo: number, over: Overrides = {}): RetractEvent {
  return { ...base(idarticulo, over), kind: 'retract' };
}

export function markUnchanged(
  idarticulo: number,
  over: Overrides & { motivo?: string } = {},
): UnchangedEvent {
  const { motivo, ...rest } = over;
  return { ...base(idarticulo, rest), kind: 'unchanged', ...(motivo ? { motivo } : {}) };
}
