/**
 * The posting parameters a session is counted under, and which triple has
 * actually been verified against the ERP.
 *
 * This lives in `src/app/` because it is Zeus vocabulary — `toma`, `conteo1`,
 * `diferencia` are column names — and `src/domain/` may not hold those. The
 * domain asks `dispatchBlockers` a boolean instead (`parametrosVerificados`),
 * which is the same division of labour as everywhere else here: the adapter
 * knows what a column is, the domain knows what a count is.
 */
import type { WriteTxtOptions } from '../zeus/index.js';

/** The three settings that decide what the posted file says. */
export interface PostingParameters {
  countTargetColumn: NonNullable<WriteTxtOptions['countTargetColumn']>;
  uncountedPolicy: NonNullable<WriteTxtOptions['uncountedPolicy']>;
  differenceColumn: NonNullable<WriteTxtOptions['differenceColumn']>;
}

/**
 * The one triple a session may be dispatched under.
 *
 * `countTargetColumn` and `differenceColumn` are ZEUS_FORMAT.md §7.1's — the
 * combination a file has actually been posted under and confirmed to move
 * balances in Zeus.
 *
 * `uncountedPolicy: 'zero'` is a policy decision, not a §7.1 verification
 * (2026-09: a row nobody counted must post as zero, not as the book figure).
 * A blank row now *zeroes the balance* in Zeus, which is the sharper meaning:
 * the file says what the count found, and the count found nothing there. What
 * pays for it is the same machinery that paid for `'existencia'` — the acta
 * names how many rows were written by policy rather than by a person, and a
 * signed waiver is the one route to keeping a book figure nobody checked.
 * `exportAdjustment` still fixes `'reject'` for itself; the two answer
 * different questions.
 *
 * The other values are implemented but are not what the session flow expects.
 * A session on them is refused at dispatch rather than merely flagged: a
 * session on non-standard parameters has to be an explicit act somebody
 * performed, not a default anybody drifts into.
 */
export const VERIFIED_PARAMETERS: PostingParameters = {
  countTargetColumn: 'toma',
  uncountedPolicy: 'zero',
  differenceColumn: 'computed',
};

/** Which of the three are not what §7.1 verified. Empty means the session is on the verified triple. */
export function unverifiedParameters(
  parameters: PostingParameters,
): (keyof PostingParameters)[] {
  return (Object.keys(VERIFIED_PARAMETERS) as (keyof PostingParameters)[]).filter(
    (key) => parameters[key] !== VERIFIED_PARAMETERS[key],
  );
}

export function isVerifiedTriple(parameters: PostingParameters): boolean {
  return unverifiedParameters(parameters).length === 0;
}
