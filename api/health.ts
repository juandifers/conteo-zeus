/**
 * `GET /api/health` — is this deploy talking to a database it understands?
 *
 * The only endpoint in P2.0. No event ingestion, no auth, no sealing.
 *
 * It is deliberately more than a ping. A deploy whose code is ahead of its
 * schema is the failure this exists to catch, and it is a failure that looks
 * like nothing at all until the first write: the function boots, the pool
 * connects, and then a query names a column that is not there. Migrations run
 * in CI and never on a cold start (tools/migrate.mjs says why), so the function
 * cannot fix this — it can only refuse to say it is fine.
 *
 *   200  { ok: true,  dbLatencyMs, migrationVersion, buildSha, … }
 *   503  { ok: false, error, … }
 *
 * 503 rather than 500 on a schema mismatch: the deploy is not broken, it is not
 * ready, and a load balancer should treat those the same way.
 *
 * **The decision-making is `healthCheck`, and the driver is one line at the
 * bottom.** `@neondatabase/serverless` speaks Neon's HTTP protocol and can only
 * address a Neon host — it rewrites the connection string into an `https://`
 * URL — so a handler that reached for it inline would be a handler nobody could
 * exercise against the throwaway Postgres in CI. The seam is what makes every
 * branch below testable with a stub, leaving a driver call too small to be
 * wrong. See docs/BACKEND.md.
 */
import { neon } from '@neondatabase/serverless';

import { EXPECTED_MIGRATION_VERSION } from './_schemaVersion';

export interface HealthBody {
  ok: boolean;
  /** Round trip to Postgres in milliseconds, or `null` if it never answered. */
  dbLatencyMs: number | null;
  /** The highest version in `schema_migrations`, or `null` if unreadable. */
  migrationVersion: number | null;
  /** What this build expects. Reported on success too — a health check nobody can compare is a boolean. */
  expectedMigrationVersion: number;
  /** The commit this deploy was built from, so a stale deploy is nameable. */
  buildSha: string | null;
  error?: string;
}

export interface HealthResult {
  status: number;
  body: HealthBody;
}

/** Reads `max(version)` from `schema_migrations`. The only query this endpoint makes. */
export type VersionQuery = () => Promise<number>;

/** Milliseconds since some epoch. Injected so a test does not race a clock. */
export type Clock = () => number;

/**
 * Everything the endpoint decides, with no driver and no framework in it.
 *
 * @param query  `null` when there is no connection string to build one from.
 */
export async function healthCheck(
  query: VersionQuery | null,
  options: { buildSha?: string | null; expected?: number; now?: Clock } = {},
): Promise<HealthResult> {
  const expected = options.expected ?? EXPECTED_MIGRATION_VERSION;
  const now = options.now ?? Date.now;
  const body: HealthBody = {
    ok: false,
    dbLatencyMs: null,
    migrationVersion: null,
    expectedMigrationVersion: expected,
    buildSha: options.buildSha ?? null,
  };

  if (!query) {
    return { status: 503, body: { ...body, error: 'DATABASE_URL is not set on this deploy' } };
  }

  const started = now();
  try {
    body.migrationVersion = await query();
    body.dbLatencyMs = now() - started;
  } catch (cause) {
    body.dbLatencyMs = now() - started;
    const message = cause instanceof Error ? cause.message : String(cause);
    // A missing ledger table is a database no migration has ever run against,
    // which is worth saying in those words rather than as a Postgres error a
    // reader has to recognise.
    return {
      status: 503,
      body: {
        ...body,
        error: /schema_migrations/.test(message)
          ? 'schema_migrations does not exist: no migration has been applied to this database'
          : `database unreachable: ${message}`,
      },
    };
  }

  if (body.migrationVersion !== expected) {
    const behind = body.migrationVersion < expected;
    return {
      status: 503,
      body: {
        ...body,
        error: behind
          ? `migrations are behind: database is at ${body.migrationVersion}, this build ` +
            `expects ${expected}. Run tools/migrate.mjs in CI`
          : `database is at ${body.migrationVersion} and this build expects ${expected}; ` +
            'this deploy is older than the schema',
      },
    };
  }

  return { status: 200, body: { ...body, ok: true } };
}

/**
 * The one query, against Neon.
 *
 * `max(version)` and not `count(*)`: a ledger with a hole in it is at the
 * version of its highest row, and counting rows would call a database missing
 * `0001` but holding `0002` "version 1".
 */
function neonVersionQuery(url: string): VersionQuery {
  return async () => {
    const sql = neon(url);
    const rows = await sql`select coalesce(max(version), 0)::int as version from schema_migrations`;
    return Number((rows[0] as { version: number } | undefined)?.version ?? 0);
  };
}

/** Vercel's request/response, typed structurally so this file imports no framework. */
interface Req {
  method?: string;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  // Never cached. A cached health check is a health check of the past.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'GET only' });
    return;
  }

  const url = process.env.DATABASE_URL;
  const { status, body } = await healthCheck(url ? neonVersionQuery(url) : null, {
    buildSha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null,
  });
  res.status(status).json(body);
}
