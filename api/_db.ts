/**
 * The database port, and the one implementation that speaks to Neon.
 *
 * Same seam as `api/health.ts`, for the same reason: `@neondatabase/serverless`
 * rewrites its connection string into an `https://…/sql` URL and can only
 * address a Neon host, so a handler holding the driver inline is a handler
 * nobody can exercise against the throwaway Postgres CI runs. Every function in
 * this directory takes a `Db` and never names a driver, and
 * `tests/backend/pgDb.ts` supplies a `pg`-backed one — which means the SQL
 * below is executed, against a real Postgres, by the test suite. Mocked SQL
 * proves the handler calls a function; this proves the query is a query.
 */
import { neon } from '@neondatabase/serverless';

export type Row = Record<string, unknown>;

export interface Statement {
  text: string;
  params?: readonly unknown[];
}

export interface Db {
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * All of these, or none of them.
   *
   * Non-interactive on purpose: the statements are decided before the first one
   * runs. Neon's HTTP protocol has no session to hold a transaction open
   * across, and a handler that needed to read a row *inside* a transaction to
   * decide the next statement would be a handler that had to hold a socket —
   * which is the thing serverless cannot do cheaply. Every write path here
   * reads first, decides, and then commits one batch.
   */
  transaction(statements: readonly Statement[]): Promise<Row[][]>;
}

/** The Neon-backed implementation. The only place in `api/` that names a driver. */
export function neonDb(url: string): Db {
  const sql = neon(url);
  return {
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await sql.query(text, [...params])) as T[];
    },
    async transaction(statements: readonly Statement[]): Promise<Row[][]> {
      return (await sql.transaction(
        statements.map((statement) => sql.query(statement.text, [...(statement.params ?? [])])),
      )) as Row[][];
    },
  };
}

/** Thrown when a handler cannot run at all, as opposed to refusing a request. */
export class NoDatabaseError extends Error {
  constructor() {
    super('DATABASE_URL is not set on this deploy');
    this.name = 'NoDatabaseError';
  }
}

export function dbFromEnv(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new NoDatabaseError();
  return neonDb(url);
}
