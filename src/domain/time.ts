/**
 * The `at` contract — DOMAIN.md §3.
 *
 * The fold orders events by comparing `at` as a string, which is chronological
 * only for ISO-8601 instants normalised to UTC with milliseconds. Every other
 * shape a `Date` will happily produce sorts wrongly and does so silently:
 *
 *   '2026-08-25T10:00:00Z'          // no ms — sorts after '...T10:00:00.001Z'
 *   '2026-08-25T12:00:00.000+02:00' // same instant as 10:00Z, sorts after it
 *   '2026-08-25 10:00:00.000Z'      // space separator sorts before 'T'
 *
 * The type system cannot express this, so the write path enforces it: an event
 * that reaches the log with a malformed stamp is one that folds differently on
 * two devices, and by then there is nothing to detect it against.
 */

/** `YYYY-MM-DDTHH:MM:SS.mmmZ` — exactly what `Date#toISOString` emits. */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True when `value` is a normalised UTC instant.
 *
 * The round trip through `Date` is the second half of the check: the pattern
 * alone accepts `2026-13-45T99:99:99.999Z`, which `Date` silently rolls over
 * into a different instant.
 */
export function isNormalisedInstant(value: string): boolean {
  if (!INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** Throw unless `value` is a normalised UTC instant. */
export function assertNormalisedInstant(value: string, context: string): void {
  if (isNormalisedInstant(value)) return;
  throw new Error(
    `${context}: ${JSON.stringify(value)} is not a normalised UTC instant. ` +
      'Events are ordered by comparing this field as a string, so it must be ' +
      'exactly what Date#toISOString() emits (YYYY-MM-DDTHH:MM:SS.mmmZ) — ' +
      'DOMAIN.md §3.',
  );
}

/** The current instant in the form the log requires. */
export function nowInstant(): string {
  return new Date().toISOString();
}
