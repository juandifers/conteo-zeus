/**
 * The arithmetic behind the posting confirmation.
 *
 * Out of the component file so both panels and the tests can reach it without
 * rendering anything. These are the sentences the last screen before an
 * irreversible ERP posting is made of, and they are worth asserting on their
 * own.
 */
import type { ExportRecord, Session, SessionSummary } from '../domain';
import { formatMoney } from './format';

export interface PostFigures {
  /** Rows whose `toma` differs from `existencia` — the ones that move a balance. */
  changed: number;
  /** Counted rows that matched exactly. They post, and they post as no change. */
  matched: number;
  /** Waived rows. They post as `existencia`, with somebody's name in the log. */
  waived: number;
}

export function postFigures(summary: SessionSummary): PostFigures {
  const changed = summary.byMateriality.filter((row) => row.variance!.variance !== 0).length;
  return {
    changed,
    matched: summary.counts.counted - changed,
    waived: summary.counts.unchanged,
  };
}

/** A coverage fraction as a whole percentage. `0.8734` reads `87%`. */
export function formatCoverage(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The name the adjustment is offered under.
 *
 * `<base> - conteo <corte> #<n>.txt`, where `base` is the file the session was
 * imported as. Three decisions in one string:
 *
 * - The imported base is kept, because the hotel already has a habit for what
 *   these files are called and matching it beats teaching them ours.
 * - `.txt`, whatever the source was: the bytes are the `.txt` Zeus ingests, and
 *   offering an `.xls` name over `.txt` content is how a file gets opened in
 *   Excel and saved back through a converter.
 * - The corte and the sequence number, because the default must never name two
 *   different files the same thing. The first version of this returned the
 *   imported name unchanged, and the second export of a session then landed in
 *   the same folder as the first — a collision the browser resolves silently by
 *   appending `(1)`, leaving two adjustments for one bodega distinguishable
 *   only by which one you happened to download second.
 *
 * `n` is one-based: the first file of a session is `#1`.
 */
export function defaultFilename(session: Session, n: number): string {
  const base = session.source
    ? session.source.name.replace(/\.[^.]+$/, '')
    : `bodega ${session.bodega}`;
  // The corte is the ERP's `YYYY/MM/DD` and a slash is a path separator.
  return `${base} - conteo ${session.fechaCorte.replace(/\//g, '-')} #${n}.txt`;
}

/**
 * What moved since the last file was generated.
 *
 * An export record is not a boolean, and this is why: the useful thing to say
 * to somebody about to send a second adjustment is not "you already sent one",
 * it is which numbers are different now. Only the figures that actually
 * changed are named — a list where three of five lines say "igual" is a list
 * nobody reads to the end.
 */
export function describeChanges(
  previous: ExportRecord,
  summary: SessionSummary,
  eventCount: number,
): string[] {
  const lines: string[] = [];
  const events = eventCount - previous.eventCount;
  if (events > 0) lines.push(`${events} registros nuevos en el conteo`);
  const states: Array<[keyof SessionSummary['counts'], string]> = [
    ['counted', 'contados'],
    ['unchanged', 'exentos'],
    ['untouched', 'sin contar'],
  ];
  for (const [key, label] of states) {
    if (previous.counts[key] !== summary.counts[key]) {
      lines.push(`${label} ${previous.counts[key]} → ${summary.counts[key]}`);
    }
  }
  if (previous.netVarianceValue !== summary.netVarianceValue) {
    lines.push(
      `diferencia neta ${formatMoney(previous.netVarianceValue)} → ` +
        `${formatMoney(summary.netVarianceValue)} COP`,
    );
  }
  if (previous.grossVarianceValue !== summary.grossVarianceValue) {
    lines.push(
      `diferencia bruta ${formatMoney(previous.grossVarianceValue)} → ` +
        `${formatMoney(summary.grossVarianceValue)} COP`,
    );
  }
  return lines;
}

