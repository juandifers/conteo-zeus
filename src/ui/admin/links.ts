/**
 * Where a counter's link points.
 *
 * A hash route rather than a path: the service worker precaches `index.html`
 * and serves it for any navigation, so `#/c/<token>` opens offline on a tablet
 * that has already been prepared, and a path would need the network to answer
 * the navigation before the app could tell the device it already has the data.
 */
export function counterLink(token: string, origin = globalThis.location?.origin ?? ''): string {
  return `${origin}/#/c/${token}`;
}

/** The token in a hash route, or `null`. */
export function tokenInHash(hash: string): string | null {
  const match = /^#\/c\/([^/?#]+)/.exec(hash);
  return match ? match[1] : null;
}

/** Whether the hash asks for the admin app, and which session if it names one. */
export function adminRoute(hash: string): { name: 'list' } | { name: 'session'; id: string } | null {
  if (!hash.startsWith('#/admin')) return null;
  const match = /^#\/admin\/([^/?#]+)/.exec(hash);
  return match ? { name: 'session', id: match[1] } : { name: 'list' };
}
