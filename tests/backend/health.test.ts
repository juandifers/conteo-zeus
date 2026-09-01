/**
 * `/api/health`'s decision-making, with no driver and no database.
 *
 * The seam exists because `@neondatabase/serverless` can only address a Neon
 * host — it rewrites the connection string into an `https://` URL — so a
 * handler with the driver inline could not be exercised against the throwaway
 * Postgres CI runs. Here every branch is reachable, and what is left in the
 * real handler is one query too small to be wrong.
 */
import { describe, expect, it } from 'vitest';

import { healthCheck } from '../../api/health';
import { EXPECTED_MIGRATION_VERSION } from '../../api/_schemaVersion';

/** A clock that advances a fixed amount on its second reading. */
function clockTaking(ms: number) {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return 1000;
    }
    return 1000 + ms;
  };
}

describe('healthCheck', () => {
  it('is green when the database is at the version this build expects', async () => {
    const result = await healthCheck(async () => EXPECTED_MIGRATION_VERSION, {
      buildSha: 'abc123',
      now: clockTaking(7),
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      dbLatencyMs: 7,
      migrationVersion: EXPECTED_MIGRATION_VERSION,
      expectedMigrationVersion: EXPECTED_MIGRATION_VERSION,
      buildSha: 'abc123',
    });
  });

  it('is 503 when migrations are behind, and says which way', async () => {
    const result = await healthCheck(async () => 0, { expected: 3 });
    expect(result.status).toBe(503);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toMatch(/migrations are behind: database is at 0, this build expects 3/);
  });

  it('is 503 when the deploy is older than the schema, which reads differently', async () => {
    // Not the same incident. Behind means "run the migration"; ahead means
    // "this deploy should not be serving traffic", and a message that said
    // "migrations are behind" would send somebody to migrate a database that
    // is already further along than the code.
    const result = await healthCheck(async () => 5, { expected: 3 });
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/this deploy is older than the schema/);
  });

  it('names a missing ledger as a database nothing has ever migrated', async () => {
    const result = await healthCheck(async () => {
      throw new Error('relation "schema_migrations" does not exist');
    });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe(
      'schema_migrations does not exist: no migration has been applied to this database',
    );
    expect(result.body.migrationVersion).toBeNull();
  });

  it('reports an unreachable database as unreachable, with the cause', async () => {
    const result = await healthCheck(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432');
    });
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/^database unreachable: ECONNREFUSED/);
  });

  it('still reports latency when the query failed', async () => {
    // How long it took to fail is the difference between a wrong password and a
    // network that is not there.
    const result = await healthCheck(
      async () => {
        throw new Error('timeout');
      },
      { now: clockTaking(4200) },
    );
    expect(result.body.dbLatencyMs).toBe(4200);
  });

  it('is 503 with no query at all when DATABASE_URL is unset', async () => {
    const result = await healthCheck(null);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('DATABASE_URL is not set on this deploy');
    expect(result.body.dbLatencyMs).toBeNull();
  });

  it('always reports what it expected, so a red check is comparable', async () => {
    // A health check that says "not ok" without saying against what is a
    // boolean, and a boolean is not something anybody can act on at 2am.
    for (const version of [0, 1, 2, 99]) {
      const result = await healthCheck(async () => version, { expected: 1 });
      expect(result.body.expectedMigrationVersion).toBe(1);
      expect(result.body.migrationVersion).toBe(version);
    }
  });
});

describe('the handler around it', () => {
  it('refuses a method that is not a read, and never caches', async () => {
    const { default: handler } = await import('../../api/health');
    const headers: Record<string, string> = {};
    let status = 0;
    let body: unknown = null;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      json(payload: unknown) {
        body = payload;
      },
    };

    await handler({ method: 'POST' }, res);
    expect(status).toBe(405);
    expect(body).toEqual({ error: 'GET only' });
    // Set before the method check, so even a rejection is uncacheable.
    expect(headers['Cache-Control']).toBe('no-store, max-age=0');
  });
});
