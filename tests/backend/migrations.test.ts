/**
 * The migrations directory, and the one constant that has to agree with it.
 *
 * No database. These are the checks that catch a bad migration before it
 * reaches one — and the drift check between `migrations/` and the literal
 * `/api/health` compares against, which is the whole reason that literal is
 * safe to hard-code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { latestVersion, readMigrations } from '../../tools/migrate.mjs';
import { EXPECTED_MIGRATION_VERSION } from '../../api/_schemaVersion';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrations = readMigrations(join(ROOT, 'migrations'));

describe('migrations/', () => {
  it('is named so the sort is the order', () => {
    for (const migration of migrations) {
      expect(migration.file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('creates the ledger first, and idempotently', () => {
    // 0000 is the only migration that can run against a database with no
    // `schema_migrations` to record it in, so it has to survive being reached
    // twice.
    const ledger = migrations[0];
    expect(ledger.version).toBe(0);
    expect(ledger.sql).toMatch(/create table if not exists schema_migrations/);
  });

  it('agrees with the version /api/health checks against', () => {
    // The drift guard. `api/_schemaVersion.ts` is a literal because the
    // serverless bundle does not carry `migrations/`; this is what stops the
    // literal being wrong.
    expect(EXPECTED_MIGRATION_VERSION).toBe(latestVersion(migrations));
  });

  it('carries the decisions in comments, not only in a document', () => {
    // Three of them are load-bearing enough that somebody reading the schema
    // cold must not have to go looking: why `cantidad` is text, why `raw_row`
    // is an array, and what `unique (counter_id, seq)` is for.
    const init = migrations.find((m) => m.name === 'init')!.sql;
    expect(init).toMatch(/DECIMAL AS STRING/);
    expect(init).toMatch(/0\.20000000000000107/);
    expect(init).toMatch(/unique \(counter_id, seq\)/);
    expect(init).toMatch(/raw_row\s+text\[\]\s+not null/);
  });
});

describe('the schema says what P2.0 decided', () => {
  const init = migrations.find((m) => m.name === 'init')!.sql;

  it('stores quantities as text, never numeric', () => {
    // The single most consequential column type here. A `numeric` a driver
    // round-trips through a float breaks the hash chain silently, and the
    // canonical decimal string is what `canonicalEvent` hashed.
    expect(init).toMatch(/^\s*cantidad\s+text,/m);
    expect(init).not.toMatch(/cantidad\s+numeric/);
    expect(init).not.toMatch(/cantidad\s+(double|real|float)/);
  });

  it('stores the event timestamp as text, as hashed', () => {
    expect(init).toMatch(/^\s*client_at\s+text\s+not null,/m);
  });

  it('stores fecha_corte as a label, never a date', () => {
    expect(init).toMatch(/^\s*fecha_corte\s+text\s+not null,/m);
  });

  it('keeps the source bytes with the session', () => {
    expect(init).toMatch(/^\s*source_bytes\s+bytea\s+not null,/m);
  });

  it('defaults to the verified triple and nothing else', () => {
    expect(init).toMatch(/count_target_column\s+text\s+not null default 'toma'/);
    expect(init).toMatch(/uncounted_policy\s+text\s+not null default 'existencia'/);
    expect(init).toMatch(/difference_column\s+text\s+not null default 'computed'/);
  });

  it('lets assignments hold several counters per article', () => {
    // Blind double-counting is out of scope for P2 and the schema does not
    // foreclose it: the key is the triple, not `(session_id, idarticulo)`.
    expect(init).toMatch(/primary key \(session_id, idarticulo, counter_id\)/);
  });

  it('has no terminado_local, because the server cannot observe one', () => {
    // The enum line names exactly four states…
    expect(init).toMatch(
      /asignado\|contando\|terminado_confirmado\|terminado_incompleto/,
    );
    // …and the only mention of the fifth is the comment saying why it is absent,
    // which is worth keeping and worth not mistaking for the thing itself.
    const mentions = init.match(/^.*terminado_local.*$/gm) ?? [];
    expect(mentions).toHaveLength(1);
    expect(mentions[0].trim()).toMatch(/^-- There is deliberately no/);
  });

  it('makes idarticulo nullable on events and not on catalog rows', () => {
    // Null only on the session-scoped kinds. A catalogue row without a primary
    // key is not a row.
    expect(init).toMatch(/^\s*idarticulo\s+integer\s+not null,/m); // catalog_rows
    expect(init).toMatch(/^\s*idarticulo\s+integer,$/m); // events
  });
});

describe('the schema says what P2.3.5 decided', () => {
  const admin = migrations.find((m) => m.name === 'admin_actions')!.sql;

  it('gives the admin their own chain rather than a column on `counters`', () => {
    // `counters` carries a token, a bound device, a `final_seq`, a manifest and
    // four counting states. An admin has none of those meanings, and hanging
    // four nullable columns off the entity the sealing gate reads is how a table
    // stops being about one thing.
    expect(admin).toMatch(/create table session_actions/);
    expect(admin).toMatch(/unique \(session_id, seq\)/);
    expect(admin).toMatch(/prev_hash\s+text\s+not null/);
    expect(admin).toMatch(/hash\s+text\s+not null/);
  });

  it('stores the admin’s stamp as text, like an event’s, and for the same reason', () => {
    // A `timestamptz` would be re-rendered on the way out and the hash would
    // stop matching.
    expect(admin).toMatch(/^\s*client_at\s+text\s+not null,/m);
  });

  it('stores the payload as jsonb, and says why that is safe to hash', () => {
    // The one place this differs from `events.cantidad text`: an action payload
    // does not participate in the fold. It is still hashed, so the migration has
    // to point at what makes the round trip byte-stable.
    expect(admin).toMatch(/^\s*payload\s+jsonb\s+not null,/m);
    expect(admin).toMatch(/canonicalJson/);
    expect(admin).toMatch(/key order/);
  });

  it('carries the optimistic-concurrency column, not a lock table', () => {
    expect(admin).toMatch(/alter table sessions add column assignments_version integer not null default 0/);
    // And says what it is for, because «two admins» is the whole reason.
    expect(admin).toMatch(/reverse/);
  });

  it('adds `retirado` without a check constraint, and explains the absence', () => {
    // The state machine lives in `src/domain/sync.ts`, where both the server and
    // the device read it from one definition. A check constraint here would be a
    // second copy that has to be migrated every time a state is added.
    expect(admin).toMatch(/retirado/);
    expect(admin).not.toMatch(/add constraint.*check/i);
  });
});

describe('/api/health does not migrate', () => {
  // Its behaviour is tested properly in `health.test.ts`, against the exported
  // seam. This is the one property that can only be asserted about the source:
  // the endpoint must not carry DDL. A serverless function that migrated on
  // boot would run it from however many concurrent cold starts a deploy
  // produced, against a database several of them are already reading — which is
  // exactly why `tools/migrate.mjs` exists and runs in CI instead.
  const source = readFileSync(join(ROOT, 'api', 'health.ts'), 'utf8');

  it('carries no DDL', () => {
    expect(source).not.toMatch(/create\s+(table|index|type)/i);
    expect(source).not.toMatch(/\balter\s+table\b/i);
    expect(source).not.toMatch(/\bdrop\s+table\b/i);
  });

  it('reads the ledger and nothing else', () => {
    const statements = source.match(/select[\s\S]*?schema_migrations/gi) ?? [];
    expect(statements).toHaveLength(1);
    expect(source).not.toMatch(/\binsert\s+into\b/i);
    expect(source).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
});
