/**
 * The admin's copy of the log, pulled by cursor and merged by id.
 *
 * **Overlap and deduplicate; never poll strictly forwards.** `server_seq` is a
 * `bigserial` and carries the standard cursor trap: the value is taken from the
 * sequence at insert and the row becomes visible at commit, and those two orders
 * are not the same. Under concurrent transactions a *lower* `server_seq` can
 * appear after a higher one, so a `where server_seq > cursor` poll skips an
 * event permanently — and a skipped event is a wrong total on a screen somebody
 * signs.
 *
 * The endpoint applies the overlap itself (`api/sessions/[id]/events.ts`), so no
 * caller can forget it: `since` is what this client last saw and the query
 * starts four hundred rows before it. What is left here is the other half —
 * merging by `id`. Events are immutable and keyed by a device-generated uuid, so
 * redelivery costs nothing and the merge is a `Map.set`.
 *
 * The feed is a plain object rather than a hook because both screens want it and
 * they want it differently: the monitor pulls when `/sync` shows movement, and
 * the review pulls once and folds 5 000 events.
 */
import { eventFromRow, type CountEvent, type EventWire } from '../../domain';
import type { Api } from '../api';

/** What `GET /api/sessions/:id/events` answers with. */
export interface EventPage {
  events: (EventWire & { serverSeq: string; serverAt: string })[];
  /** Where to ask from next. Passed back verbatim; the overlap is the server's. */
  nextCursor: string;
}

/** How many rows to ask for at a time. The endpoint caps at 2 000. */
const PAGE = 1000;

/**
 * A guard, not a policy: at 1 000 rows a page this is a 200 000-event session,
 * which does not exist. It is here so a cursor that somehow stopped advancing
 * cannot spin a browser tab for ever.
 */
const MAX_PAGES = 200;

export class EventFeed {
  private readonly byId = new Map<string, CountEvent>();
  /** The highest `server_seq` seen. Handed back to the endpoint, which re-overlaps it. */
  cursor = '0';

  /** Every event this feed holds. Fold order is the fold's business, not this one's. */
  get events(): CountEvent[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * Pull until the server has nothing more, and return how many events were new.
   *
   * Zero is the ordinary answer on a quiet poll and is what the monitor uses to
   * decide it has nothing to redraw. It is **not** the same as "the page was
   * empty": the overlap means the last page of every pull is rows this feed
   * already holds, which is the mechanism working rather than waste.
   */
  async pull(api: Api, sessionId: string): Promise<number> {
    let fresh = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await api.get<EventPage>(
        `/api/sessions/${sessionId}/events?since=${this.cursor}&limit=${PAGE}`,
      );
      for (const row of body.events) {
        if (this.byId.has(row.id)) continue;
        this.byId.set(row.id, eventFromRow(row));
        fresh++;
      }
      this.cursor = body.nextCursor;
      // A short page is the end of what is visible right now. The next `pull`
      // starts from this cursor and the server re-reads the overlap, which is
      // where an event that committed out of sequence order is picked up.
      if (body.events.length < PAGE) break;
    }
    return fresh;
  }
}
