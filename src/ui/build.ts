/**
 * Which build this is.
 *
 * Substituted at build time by `define` (vite.config.ts). The `typeof` guard
 * is not defensive padding: under Vitest the app is imported without going
 * through a production build, so the constants genuinely are not defined, and
 * a bare reference would throw a `ReferenceError` on any screen that shows the
 * footer.
 */

export interface BuildStamp {
  /** Short commit hash, or `sin-git` if the build host had no repository. */
  commit: string;
  /** ISO-8601 instant the bundle was built. */
  at: string;
}

export const BUILD: BuildStamp = {
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev',
  at: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '',
};

/**
 * One line, for a footer and for the top of the debug export.
 *
 * Date only, not the instant: the person reading it off a tablet is answering
 * "which build are you on", and to the minute is more precision than that
 * question has ever needed.
 */
export function buildLabel(stamp: BuildStamp = BUILD): string {
  const day = stamp.at.slice(0, 10);
  return day ? `${stamp.commit} · ${day}` : stamp.commit;
}
