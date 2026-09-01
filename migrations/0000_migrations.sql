-- The ledger the runner keeps, and the one thing `/api/health` reads.
--
-- Applied before every other migration, and idempotent, because it is the
-- table that records whether anything has been applied at all.
create table if not exists schema_migrations (
  version    integer     primary key,
  name       text        not null,
  -- SHA-256 of the file's bytes at the moment it was applied. A migration whose
  -- text changed after the fact is a database nobody can reason about from the
  -- repository, so the runner refuses rather than reapplying or ignoring.
  checksum   text        not null,
  applied_at timestamptz not null default now()
);
