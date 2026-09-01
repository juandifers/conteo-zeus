/**
 * Somebody else's queue, on this tablet — P2.3.5 §6a.
 *
 * Pedro takes over Luis's physical tablet. Luis's Dexie rows are still here, and
 * some of them have not reached the server.
 *
 * **The outbox is per counter, not per device.** That was already true of the
 * store — `CounterChainRepository` is keyed by `(sessionId, counterId)`
 * throughout — and it is what stops Pedro's arrival stranding or, worse,
 * re-attributing Luis's morning. What was missing is that nothing *looked* at a
 * queue whose owner was not in the foreground, and a queue nothing looks at
 * never drains.
 *
 * So: the drain runs for every counter with a non-empty outbox on this device,
 * whoever is counting, and the sync bar can say «Luis: 23 registros sin subir»
 * while Pedro works.
 *
 * Two things this deliberately does **not** do:
 *
 *   - **No «limpiar tableta».** There is no state in which discarding another
 *     person's unsynced counts is the right thing for a tablet to decide on its
 *     own. Nothing in this file or in the port it uses deletes an event.
 *   - **No pulling.** Counter sync stays push-only (DOMAIN.md §6.2). Draining
 *     Luis's outbox sends his events to the server; it asks for nothing back
 *     beyond the ack that says how far they got.
 *
 * The token is the one thing a background drain needs that the outbox does not
 * carry, and it comes from `counterAssignments` — one row per counter link this
 * device has ever prepared, which is exactly the set of counters whose events
 * can be on it.
 */
import type { CounterChainRepository } from '../../domain';
import type { AssignmentStore } from '../../store';
import type { Api } from '../api';
import { CounterSync } from './sync';

/** One other counter's unsent work, as the indicator names it. */
export interface OtherOutbox {
  sessionId: string;
  counterId: string;
  /** Their name, from the assignment their link pulled. */
  nombre: string;
  token: string;
  pendientes: number;
}

/**
 * Every counter on this device with a queue, except the one in the foreground.
 *
 * A counter whose queue is here but whose link this device never prepared is
 * skipped: without a token there is nothing to push to, and inventing one is not
 * an option. In practice it cannot happen — events only ever arrive by way of a
 * link that was opened here — and it is a filter rather than an error because
 * the honest failure is «this row is not actionable», not «refuse to draw a
 * screen».
 */
export async function otherOutboxes(
  chain: CounterChainRepository,
  assignments: AssignmentStore,
  exceptCounterId: string,
): Promise<OtherOutbox[]> {
  const pending = await chain.pendingOutboxes();
  if (pending.length === 0) return [];
  const links = await assignments.list();
  const byCounter = new Map(links.map((link) => [link.counterId, link]));

  const others: OtherOutbox[] = [];
  for (const queue of pending) {
    if (queue.counterId === exceptCounterId) continue;
    const link = byCounter.get(queue.counterId);
    if (!link) continue;
    others.push({
      sessionId: queue.sessionId,
      counterId: queue.counterId,
      nombre: link.payload.counter.nombre,
      token: link.token,
      pendientes: queue.pendientes,
    });
  }
  return others;
}

/**
 * Push what they left behind.
 *
 * One `CounterSync` per queue, created and discarded: these are not screens and
 * nothing subscribes to them, so there is no state worth keeping between
 * attempts — the state is in Dexie, which is the whole design. Failures are
 * swallowed on purpose. A background drain that threw would take down the
 * foreground counter's screen to report that somebody else's tablet queue is
 * still waiting, which is the wrong trade in every direction; what the person
 * needs is the count on the indicator, and it is still there next time.
 */
export async function drainOthers(
  api: Api,
  chain: CounterChainRepository,
  others: readonly OtherOutbox[],
): Promise<void> {
  for (const other of others) {
    const sync = new CounterSync(api, chain, {
      sessionId: other.sessionId,
      counterId: other.counterId,
      token: other.token,
    });
    try {
      await sync.drain();
    } catch {
      // Kept, never dropped. The next wake tries again.
    }
  }
}
