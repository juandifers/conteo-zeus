/**
 * Numbers on screen, and numbers off the keypad.
 *
 * Display is Colombian (`1.234,5`); entry is deliberately *not*, for the
 * reason set out on `parseQty`.
 */

const QTY = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 });
const MONEY = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const SIGNED_QTY = new Intl.NumberFormat('es-CO', {
  maximumFractionDigits: 3,
  signDisplay: 'exceptZero',
});

/** A quantity, as the ERP would print it. Up to 3 dp, no trailing zeros. */
export function formatQty(value: number): string {
  return QTY.format(value);
}

/** A quantity with its sign always shown — a variance is a direction. */
export function formatSignedQty(value: number): string {
  return SIGNED_QTY.format(value);
}

/**
 * Pesos, whole. COP has no subunit in circulation and the third decimal of a
 * unit cost has no business being on a screen somebody reads at arm's length.
 */
export function formatMoney(value: number): string {
  return MONEY.format(Math.round(value));
}

/** Millions, one decimal — for totals that would otherwise be nine digits. */
export function formatMoneyShort(value: number): string {
  const millions = Math.abs(value) >= 1_000_000;
  if (!millions) return formatMoney(value);
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(value / 1e6)} M`;
}

/**
 * Read a typed quantity, or `null` if it is not one.
 *
 * Both `.` and `,` are accepted as *the decimal separator*, and neither is
 * accepted as a thousands separator: `1.234` is one and a bit, never one
 * thousand. The ambiguity is unresolvable from the string alone — Colombia
 * writes `1.234,5` and the tablet's own keyboard offers whichever separator
 * its locale feels like — and resolving it wrongly writes a count off by three
 * orders of magnitude into the ERP. The largest balance in the sample is
 * 29 400, which nobody needs a separator to type.
 *
 * Negative input is rejected here; a negative quantity reaches the log only as
 * an explicit `add(-1)` from the tally, never from the keypad.
 */
export function parseQty(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d*[.,]?\d*$/.test(trimmed)) return null;
  const normalised = trimmed.replace(',', '.');
  if (normalised === '.' || normalised === '') return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

const STAMP = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * An event or export timestamp, in local time.
 *
 * The log stores normalised UTC because the fold compares it as a string
 * (DOMAIN.md §3); nobody reading "who generated this and when" is thinking in
 * UTC, so it is converted on the way to the screen and nowhere else.
 */
export function formatInstant(at: string): string {
  return STAMP.format(new Date(at));
}
