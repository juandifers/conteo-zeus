/**
 * The counter's assignment on the device.
 *
 * A port and a Dexie implementation, like `CountRepository` beside it. Small
 * enough that it could have been three calls in a screen, and deliberately is
 * not: the property this table exists for — **one fetch on office wifi is
 * enough, forever** — is only testable if there is a seam a test can hold.
 */
import type { CounterPayload } from '../domain';
import { ConteoDb, type CounterAssignmentRow } from './db';

export interface AssignmentStore {
  /** Overwrites whatever this token last pulled. A refetch is a newer truth, not a second one. */
  save(token: string, payload: CounterPayload, fetchedAt: string): Promise<void>;
  /** What this device holds for that link, or `null` if it has never fetched it. */
  load(token: string): Promise<CounterAssignmentRow | null>;
  /** Every link this device has prepared. The tablet may be shared. */
  list(): Promise<CounterAssignmentRow[]>;
}

export class DexieAssignmentStore implements AssignmentStore {
  private readonly db: ConteoDb;

  constructor(db: ConteoDb = new ConteoDb()) {
    this.db = db;
  }

  async save(token: string, payload: CounterPayload, fetchedAt: string): Promise<void> {
    await this.db.counterAssignments.put({
      token,
      sessionId: payload.session.id,
      counterId: payload.counter.id,
      fetchedAt,
      // Stored exactly as it arrived. Nothing here reshapes it: the whole
      // guarantee is that the device holds what the server sent and no more.
      payload,
    });
  }

  async load(token: string): Promise<CounterAssignmentRow | null> {
    return (await this.db.counterAssignments.get(token)) ?? null;
  }

  async list(): Promise<CounterAssignmentRow[]> {
    return this.db.counterAssignments.toArray();
  }
}
