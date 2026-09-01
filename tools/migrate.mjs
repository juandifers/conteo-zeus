/**
 * Apply the migrations in `migrations/`, in order, once each.
 *
 * **Runs in CI, never on a cold start.** A serverless function that migrated on
 * boot would run DDL from however many concurrent cold starts a deploy
 * happened to produce, against a database several of them are already reading.
 * `/api/health` therefore *checks* the version and refuses to be green when it
 * is behind, and this is the only thing that changes it.
 *
 *   node tools/migrate.mjs            apply everything pending
 *   node tools/migrate.mjs --status   print what is applied and what is pending
 *   node tools/migrate.mjs --check    exit 1 if anything is pending (for CI)
 *
 * Connection string from DATABASE_URL. See docs/BACKEND.md.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `pg` over TCP, not `@neondatabase/serverless`.
//
// The HTTP driver exists so a serverless function can query without holding a
// socket across a cold start, which is `api/health.ts`'s problem and not this
// script's. A migration runner that could only speak to Neon would mean the
// schema could only be tested against the production provider — so this uses
// the ordinary protocol, which Neon accepts and a throwaway Postgres in CI or
// on a laptop also accepts.
import pg from 'pg';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** `0001_init.sql` -> `{ version: 1, name: 'init', ... }`. */
export function readMigrations(dir = MIGRATIONS) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const seen = new Set();
  return files.map((file) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(
        `migrations/${file}: name must be NNNN_lower_snake.sql — the order is the ` +
          'filename, so a name the sort cannot read is a migration that runs whenever',
      );
    }
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`two migrations claim version ${version}`);
    seen.add(version);

    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version,
      name: match[2],
      file,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    };
  });
}

/** The version `/api/health` must see. Exported so a test can assert they agree. */
export function latestVersion(migrations = readMigrations()) {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

async function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Locally: put it in .env.local and run ' +
        '`npm run migrate` (docs/BACKEND.md)',
    );
  }
  const client = new pg.Client({
    connectionString: url,
    // Neon requires TLS and presents a certificate a bare Node client will not
    // verify against its default roots; a local throwaway database has no TLS
    // at all. `sslmode` in the URL decides, and `PGSSLMODE=disable` turns it
    // off for the local case.
    ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}

async function applied(client) {
  // The ledger may not exist yet, which is not an error on a fresh database —
  // 0000 is what creates it, and it is `create table if not exists`.
  const { rows } = await client.query(
    `select version, name, checksum, applied_at from schema_migrations order by version`,
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function main() {
  const mode = process.argv[2] ?? '--apply';
  const migrations = readMigrations();
  const client = await connect();
  try {
    await run(mode, migrations, client);
  } finally {
    await client.end();
  }
}

async function run(mode, migrations, client) {
  const rows = await applied(client);
  const byVersion = new Map(rows.map((row) => [Number(row.version), row]));

  // A migration whose text changed after it was applied is a database nobody
  // can reason about from the repository. Checked before anything is applied,
  // so the report is about the whole set rather than about wherever it stopped.
  for (const migration of migrations) {
    const row = byVersion.get(migration.version);
    if (row && row.checksum !== migration.checksum) {
      throw new Error(
        `migrations/${migration.file} was applied as checksum ${row.checksum} and is ` +
          `now ${migration.checksum}. Migrations are immutable once applied: add a new ` +
          'one rather than editing this',
      );
    }
  }

  const pending = migrations.filter((m) => !byVersion.has(m.version));

  if (mode === '--status') {
    for (const m of migrations) {
      const row = byVersion.get(m.version);
      console.log(`${row ? 'applied ' : 'pending '} ${m.file}${row ? `  ${row.applied_at ?? ''}` : ''}`);
    }
    console.log(`\nlatest in repo: ${latestVersion(migrations)}; applied: ${rows.length}`);
    return;
  }

  if (mode === '--check') {
    if (pending.length > 0) {
      console.error(`${pending.length} migration(s) pending: ${pending.map((m) => m.file).join(', ')}`);
      process.exit(1);
    }
    console.log(`up to date at version ${latestVersion(migrations)}`);
    return;
  }

  if (pending.length === 0) {
    console.log(`nothing to do; at version ${latestVersion(migrations)}`);
    return;
  }

  for (const migration of pending) {
    console.log(`applying ${migration.file}…`);
    // The migration and its ledger row go in **one** transaction. Postgres runs
    // DDL transactionally, so a migration that fails half way leaves nothing
    // behind — and, more importantly, a migration that succeeds and then fails
    // to record itself cannot happen, which is the failure that would make the
    // next run reapply it.
    await client.query('begin');
    try {
      await client.query(migration.sql);
      await client.query(
        'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      await client.query('commit');
    } catch (cause) {
      await client.query('rollback');
      throw new Error(`migrations/${migration.file} failed and was rolled back: ${cause.message}`);
    }
    console.log(`  ok  ${migration.file}`);
  }
  console.log(`now at version ${latestVersion(migrations)}`);
}

// Only when run directly, so `readMigrations` can be imported by a test that
// has no database.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
