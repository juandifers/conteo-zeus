/**
 * The migration version this build expects the database to be at.
 *
 * A literal rather than a read of `migrations/`, for two reasons. The serverless
 * bundle does not carry the `migrations/` directory — `.vercelignore` keeps
 * repository material off the build host — and a function that inspected the
 * filesystem to decide what "up to date" means would be answering a question
 * about the deploy with a question about the disk.
 *
 * `tests/backend/migrations.test.ts` asserts this equals the highest file in
 * `migrations/`, so the literal cannot drift from the directory. Bump it in the
 * same commit that adds the migration.
 */
export const EXPECTED_MIGRATION_VERSION = 5;
