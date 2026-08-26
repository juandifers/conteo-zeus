/**
 * The lifeboat under an optimistic write.
 *
 * Writing to the screen first and to IndexedDB behind it is right — forty tally
 * taps must not queue on a database — but it opens a window in which a count
 * exists only in a JavaScript array. A tab closed in that window, or a Dexie
 * write that rejects, loses work the counter has already seen accepted. So
 * every event is stamped into `localStorage` *synchronously*, between the
 * render and the flush, and removed once the flush lands.
 *
 * `localStorage` is the right store for this and only this: it is the one
 * browser API that writes durably without a promise. It is also small and
 * synchronous, which is why what goes in it is a queue of a few hundred bytes
 * per unflushed event and nothing else.
 *
 * **One key per event.** Serialising a growing array on every append turns
 * forty taps into forty serialisations of an array that is forty long — and
 * `localStorage` is synchronous, so that cost lands on the tap.
 */
import type { CountEvent, CountRepository } from '../domain';

const PREFIX = 'conteo.outbox.';
const CANARY = 'conteo.outbox.probe';

export interface Outbox {
  /**
   * False when the browser will not durably store anything — private mode with
   * storage disabled, a blocked origin, a full quota. The caller must not
   * pretend the count is safe.
   */
  readonly available: boolean;
  /** Stamp an event. Returns false if it did not land; the caller must react. */
  hold(event: CountEvent): boolean;
  /** Forget an event that reached the database. */
  release(id: string): void;
  /** Everything still unflushed, in no particular order — the fold sorts. */
  pending(): CountEvent[];
}

/**
 * Probe storage by actually using it.
 *
 * A `try/catch` around `setItem` is not enough: Safari's private mode has
 * historically accepted a write and returned nothing on read, and a quota that
 * is already full throws only on the write that overflows it. A write, a read
 * back and a delete is the only answer that means what it says.
 */
function usable(storage: Storage | undefined): storage is Storage {
  if (!storage) return false;
  try {
    storage.setItem(CANARY, '1');
    const read = storage.getItem(CANARY);
    storage.removeItem(CANARY);
    return read === '1';
  } catch {
    return false;
  }
}

export function localOutbox(storage = globalThis.localStorage): Outbox {
  const store = usable(storage) ? storage : null;

  return {
    available: store !== null,

    hold(event: CountEvent): boolean {
      if (!store) return false;
      try {
        store.setItem(PREFIX + event.id, JSON.stringify(event));
        return true;
      } catch {
        // Almost always quota. The event is still in memory and still on
        // screen; what is gone is the guarantee, and the store is told so.
        return false;
      }
    },

    release(id: string): void {
      try {
        store?.removeItem(PREFIX + id);
      } catch {
        // A release that fails costs a duplicate replay, and replay is
        // idempotent by event id. Nothing to do and nothing to report.
      }
    },

    pending(): CountEvent[] {
      if (!store) return [];
      const held: CountEvent[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key === null || !key.startsWith(PREFIX)) continue;
        const raw = store.getItem(key);
        if (raw === null) continue;
        try {
          held.push(JSON.parse(raw) as CountEvent);
        } catch {
          // Unreadable: it can never be flushed, and leaving it would make
          // every boot report work that will never land.
          store.removeItem(key);
        }
      }
      return held;
    },
  };
}

export interface ReplayResult {
  replayed: number;
  /** Still stuck. Left in the outbox for the next boot. */
  failed: number;
}

/**
 * Push everything the outbox is still holding into the database.
 *
 * Runs at boot, before a session is loaded, so a session opens against a log
 * that already includes whatever the last run could not flush. Safe to run
 * twice: `appendEvent` is idempotent by event id, so an event that reached the
 * database and then failed to be released is a no-op the second time.
 */
export async function replayOutbox(
  outbox: Outbox,
  repo: CountRepository,
): Promise<ReplayResult> {
  let replayed = 0;
  let failed = 0;
  for (const event of outbox.pending()) {
    try {
      await repo.appendEvent(event);
      outbox.release(event.id);
      replayed++;
    } catch {
      failed++;
    }
  }
  return { replayed, failed };
}
