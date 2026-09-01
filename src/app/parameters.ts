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
import type { WriteTxtOptions } from '../zeus';

/** The three settings that decide what the posted file says. */
export interface PostingParameters {
  countTargetColumn: NonNullable<WriteTxtOptions['countTargetColumn']>;
  uncountedPolicy: NonNullable<WriteTxtOptions['uncountedPolicy']>;
  differenceColumn: NonNullable<WriteTxtOptions['differenceColumn']>;
}

/**
 * The triple in ZEUS_FORMAT.md §7.1 — the one combination a file has actually
 * been posted under and confirmed to move balances in Zeus.
 *
 * `uncountedPolicy: 'existencia'` rather than the library's `'reject'`: at the
 * session level this is what an *uncounted row means*, and the verified run
 * carried explicit no-change rows. `exportAdjustment` still fixes `'reject'`
 * for itself, because the only route to posting an incomplete count is a signed
 * waiver (DOMAIN.md §4) — the two are not in conflict, they answer different
 * questions.
 *
 * The other values are implemented and untested against the ERP. That is why a
 * session on them is refused at dispatch rather than merely flagged: a session
 * created on untested parameters has to be an explicit act somebody performed,
 * not a default anybody drifts into.
 */
export const VERIFIED_PARAMETERS: PostingParameters = {
  countTargetColumn: 'toma',
  uncountedPolicy: 'existencia',
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
