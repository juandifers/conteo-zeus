/**
 * The event log, as a spreadsheet.
 *
 * This is the pilot's entire instrumentation. There is no backend, no
 * analytics and nothing phoning home — but the log already records who did
 * what, to which item, where in the warehouse and at what instant, and that
 * turns out to be enough to answer almost everything worth asking after a real
 * count: seconds per item, how often people corrected themselves, how much got
 * waived rather than counted, whether tally mode is used at all, and which
 * zones took the afternoon.
 *
 * **Raw rows, not summaries.** One line per event, every field it carries, no
 * aggregation. The questions worth asking after the first real count are not
 * knowable before it, and a summary computed now answers the ones we happened
 * to think of today.
 *
 * Not the adjustment file, and nothing like it: that one is CP850 and goes to
 * Zeus (ZEUS_FORMAT.md §3). This is UTF-8 and goes to whoever is reading the
 * pilot. Keeping them in separate modules keeps a well-meaning edit to one from
 * reaching the other.
 */
import { compareEvents, type CountEvent, type Item } from '../domain';
import { BUILD, type BuildStamp } from './build';

/** One session's log, with the items needed to name what was counted. */
export interface SessionLog {
  sessionId: string;
  bodega: string;
  fechaCorte: string;
  items: readonly Item[];
  events: readonly CountEvent[];
}

const COLUMNS = [
  'sessionId',
  'bodega',
  'fechaCorte',
  'at',
  'usuario',
  'deviceId',
  'seq',
  'eventId',
  'zona',
  'idarticulo',
  'codigo',
  'nombre',
  'kind',
  'qty',
  'motivo',
  'buildCommit',
  'buildTime',
] as const;

/**
 * RFC 4180 quoting.
 *
 * Applied to every field rather than only the ones that look dangerous: the
 * catalogue is full of names like `AJI CHIPOTLE, AMAZON` and `PAN "TAJADO"`,
 * and a rule that fires conditionally is a rule that gets tested on the day it
 * does not fire.
 */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * A number for a machine, not for a person.
 *
 * Dot decimal and no thousands separator — the opposite of format.ts, on
 * purpose. Everything else in the product prints `1.234,5` for somebody
 * standing in a storeroom; this file is read by a script or a pivot table, and
 * the Colombian form is ambiguous to both.
 */
function number(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * The log of every session on this tablet, oldest event first.
 *
 * Every session, not the current one: the interesting comparisons in a pilot
 * are across counts, and asking somebody to remember to export before starting
 * the next bodega is asking to lose the first one.
 *
 * Sorted with the fold's own comparator, so the rows are in the order the app
 * itself resolves them (DOMAIN.md §3) rather than in whatever order IndexedDB
 * returned. Anyone measuring time-per-item is reading consecutive rows, and
 * they should be consecutive in the same sense the app means.
 */
export function eventLogCsv(
  logs: readonly SessionLog[],
  stamp: BuildStamp = BUILD,
): string {
  const lines = [COLUMNS.map(quote).join(',')];

  for (const log of logs) {
    const named = new Map(log.items.map((item) => [item.idarticulo, item]));
    for (const event of log.events.slice().sort(compareEvents)) {
      // An event whose item is not in the session is not a reason to fail an
      // export: it means a session was imported, counted, and re-imported, and
      // the row is more useful with empty name columns than absent.
      const item = named.get(event.idarticulo);
      lines.push(
        [
          log.sessionId,
          log.bodega,
          log.fechaCorte,
          event.at,
          event.usuario,
          event.deviceId,
          number(event.seq),
          event.id,
          event.zona,
          number(event.idarticulo),
          item?.codigo ?? '',
          item?.nombre ?? '',
          event.kind,
          // Only `set` and `add` carry one. Empty is not zero: a waiver with a
          // zero in this column would read as "counted nothing" (§2).
          'qty' in event ? number(event.qty) : '',
          event.kind === 'unchanged' ? (event.motivo ?? '') : '',
          stamp.commit,
          stamp.at,
        ]
          .map(quote)
          .join(','),
      );
    }
  }

  // Trailing newline: a POSIX text file, and one fewer thing for a parser to
  // disagree about.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The bytes to hand the browser.
 *
 * UTF-8 with a byte-order mark. The BOM is there for exactly one reader:
 * Excel, which opens a `.csv` without one as the system's legacy codepage and
 * renders every `Ñ` in the catalogue as mojibake. Everything else ignores it.
 */
export function encodeCsv(csv: string): Uint8Array {
  const body = new TextEncoder().encode(csv);
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return bytes;
}

/** `conteo-log-2026-08-27-a1b2c3d.csv` — sortable, and says which build wrote it. */
export function debugExportName(day: string, stamp: BuildStamp = BUILD): string {
  return `conteo-log-${day}-${stamp.commit}.csv`;
}
