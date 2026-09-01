/**
 * A `Db` over plain Postgres, so the SQL in `api/_store.ts` is executed rather
 * than mocked.
 *
 * `@neondatabase/serverless` rewrites its connection string into an
 * `https://…/sql` URL and can only address a Neon host, so nothing that imports
 * it can be pointed at the throwaway Postgres CI runs. That is why every
 * handler takes a `Db` and names no driver — and it is why this file exists on
 * the test side rather than in `api/`, where `pg` would end up in the
 * serverless bundle.
 *
 * The payoff is that these tests fail on a real constraint violation, a real
 * `numeric` round trip and a real `text[]`. A mocked database proves the
 * handler calls a function; this proves the query is a query.
 */
import pg from 'pg';

import type { Db, Row, Statement } from '../../api/_db';

export interface TestDb extends Db {
  client: pg.Client;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Reachable only when `DATABASE_URL` is set; the suites skip themselves otherwise.
 *
 * `owner` is a uuid prefix — one hex character is enough — that a suite mints
 * all of its session ids under. `reset()` then deletes **only that suite's**
 * sessions rather than truncating the table, which is what lets two Postgres
 * suites run in parallel: Vitest runs files concurrently, and a `truncate` in
 * one suite's `beforeEach` is a suite next door losing its fixtures halfway
 * through a test. Everything else hangs off `sessions` by `on delete cascade`,
 * so one delete is still the whole fixture.
 */
export async function openTestDb(url: string, owner?: string): Promise<TestDb> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // One data-owning Postgres suite at a time.
  //
  // Vitest runs test files in parallel processes against one database, and
  // these suites are not only writers — they *read across the table*
  // (`listSessions` answers with every session there is, which is the whole
  // point of the endpoint). Scoping each suite's rows under its own id prefix
  // keeps them from deleting each other's fixtures; it cannot keep them out of
  // each other's `select *`.
  //
  // A session-level advisory lock is the smallest thing that fixes it: the
  // second suite blocks in `beforeAll` until the first has run its final
  // `reset()` and closed, and Postgres releases the lock with the connection
  // whatever happens to the process. No configuration, no serialising the
  // hundreds of tests that have nothing to do with a database.
  await client.query('select pg_advisory_lock($1)', [0x0c027e0]);

  const db: TestDb = {
    client,
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await client.query(text, [...params]);
      return result.rows as T[];
    },
    async transaction(statements: readonly Statement[]): Promise<Row[][]> {
      await client.query('begin');
      try {
        const out: Row[][] = [];
        for (const statement of statements) {
          const result = await client.query(statement.text, [...(statement.params ?? [])]);
          out.push(result.rows as Row[]);
        }
        await client.query('commit');
        return out;
      } catch (cause) {
        await client.query('rollback');
        throw cause;
      }
    },
    async reset(): Promise<void> {
      if (owner === undefined) {
        await client.query('truncate sessions cascade');
        return;
      }
      await client.query('delete from sessions where id::text like $1', [`${owner}%`]);
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
  return db;
}
