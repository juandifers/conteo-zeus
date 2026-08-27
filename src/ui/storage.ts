/**
 * Asking the browser not to delete the count.
 *
 * IndexedDB is *best-effort* by default. Under storage pressure a browser will
 * evict an origin's database without asking and without telling anyone, and
 * for this app that is a whole afternoon's counting gone between one launch
 * and the next. `navigator.storage.persist()` moves the origin to *persistent*,
 * which exempts it from that reclamation.
 *
 * This is the ceiling identified when the outbox was built. The outbox protects
 * a write that has not reached IndexedDB yet; nothing in the app protects
 * IndexedDB itself from the browser, and short of a backend, this request is
 * the only thing that raises that ceiling.
 *
 * Chrome does not prompt: it decides from heuristics, and an *installed* PWA is
 * granted more or less automatically. That is why this runs on every boot
 * rather than once — a tablet used in the browser on Monday and installed to
 * the home screen on Tuesday should be promoted on Tuesday, without anybody
 * knowing there was a thing to re-ask.
 */

/**
 * Whether the browser has promised to keep the database.
 *
 * `unsupported` is a third answer and not a synonym for `denied`: the app can
 * say "this browser will not promise" honestly, and cannot say "the browser
 * refused" about a browser that was never asked.
 */
export type Persistence = 'granted' | 'denied' | 'unsupported';

export interface StorageReport {
  persistence: Persistence;
  /** Bytes this origin is using, or `null` if the browser will not say. */
  usage: number | null;
  /** Bytes it is allowed, or `null`. Chrome reports a share of free disk. */
  quota: number | null;
}

export const UNKNOWN_STORAGE: StorageReport = {
  persistence: 'unsupported',
  usage: null,
  quota: null,
};

/**
 * Request persistence, then report where things stand.
 *
 * Never throws and never blocks the boot: a tablet whose browser has no
 * StorageManager still has to be able to count, it just gets told what it is
 * risking. Every call is wrapped, because these methods reject rather than
 * return false in some embedded webviews.
 */
export async function requestPersistence(
  manager: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<StorageReport> {
  if (!manager || typeof manager.persist !== 'function') return UNKNOWN_STORAGE;

  let persistence: Persistence = 'denied';
  try {
    // Ask what is already true first. `persist()` on an origin that is already
    // persistent is a no-op everywhere, but in the browsers that *do* prompt
    // (Firefox) not asking again is the difference between a dialog on every
    // launch and none.
    const already = typeof manager.persisted === 'function' && (await manager.persisted());
    persistence = already || (await manager.persist()) ? 'granted' : 'denied';
  } catch {
    persistence = 'unsupported';
  }

  return { persistence, ...(await measure(manager)) };
}

/** Usage and quota, or nulls. Split out because it is the part that may be absent. */
async function measure(
  manager: StorageManager,
): Promise<{ usage: number | null; quota: number | null }> {
  if (typeof manager.estimate !== 'function') return { usage: null, quota: null };
  try {
    const { usage, quota } = await manager.estimate();
    return { usage: usage ?? null, quota: quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

const SIZE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

/**
 * Bytes, in the unit a person would use.
 *
 * Decimal MB and GB, not binary: this figure is read next to a tablet's
 * advertised capacity, and that number is decimal.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${SIZE.format(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${SIZE.format(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${SIZE.format(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/**
 * The line the sessions screen prints, or `null` when there is nothing to say.
 *
 * Usage against quota rather than usage alone, because the number that
 * predicts an eviction is the ratio: 40 MB is nothing on a half-empty tablet
 * and the last straw on a full one.
 */
export function describeSpace(report: StorageReport): string | null {
  if (report.usage === null) return null;
  if (report.quota === null || report.quota === 0) return formatBytes(report.usage);
  return `${formatBytes(report.usage)} de ${formatBytes(report.quota)}`;
}

/**
 * True when the browser has made no promise to keep the database.
 *
 * `denied` and `unsupported` are one answer to a person standing in a
 * storeroom, because the consequence is identical: the count can disappear.
 * They stay distinct in the type because only one of them can be improved by
 * installing the app, and the sessions screen says which is which.
 */
export function atRisk(report: StorageReport): boolean {
  return report.persistence !== 'granted';
}

/** True when the tablet is close enough to full that a count is at risk. */
export function spaceIsTight(report: StorageReport): boolean {
  if (report.usage === null || report.quota === null || report.quota === 0) return false;
  return report.usage / report.quota >= 0.9;
}
