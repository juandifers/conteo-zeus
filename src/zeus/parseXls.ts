/**
 * Legacy .xls (BIFF, Excel 97-2003) reader — ZEUS_FORMAT.md §1, §2.
 *
 * This is the file the warehouse team receives. It has a header row and a 25th
 * `Observacion` column that is dropped on export to .txt.
 *
 * Columns are mapped by header name, not by position: the .xls is produced by
 * a Zeus report and a column added upstream must not silently shift every
 * field by one.
 */
import * as XLSX from 'xlsx';
import { itemFromRawRow } from './parseTxt';
import { formatExcelGeneral, parseNumber } from './formatNumber';
import {
  BODEGA_WIDTH,
  CODIGO_WIDTH,
  COL,
  XLS_ONLY_COLUMN,
  ZEUS_COLUMNS,
  type ZeusFile,
  type ZeusItem,
} from './types';

/** Columns whose textual form must be preserved verbatim, padding included. */
const STRING_COLUMNS = new Set<number>([
  COL.codigo,
  COL.nombre,
  COL.presentacion,
  COL.lote,
  COL.clasificacion,
  COL.ubicacion,
  COL.serial,
  COL.bodega,
  COL.grupo1,
  COL.grupo2,
  COL.grupo3,
  COL.grupo4,
  COL.grupo5,
]);

const PAD_WIDTHS: Record<number, number> = {
  [COL.codigo]: CODIGO_WIDTH,
  [COL.bodega]: BODEGA_WIDTH,
};

type Cell = XLSX.CellObject | undefined;

/** Zeus writes the cutoff as `YYYY/MM/DD` in the .txt (§2). */
function formatFecha(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}/${pad(month)}/${pad(day)}`;
}

function cellToRawField(cell: Cell, column: number, rowLabel: string): string {
  const name = ZEUS_COLUMNS[column];

  if (cell === undefined || cell.v === undefined || cell.v === null) return '';

  if (column === COL.fecha) {
    if (cell.t === 'n' && typeof cell.v === 'number') {
      // Excel keeps the date as a serial; the .txt carries YYYY/MM/DD.
      const parsed = XLSX.SSF.parse_date_code(cell.v);
      if (!parsed) throw new Error(`${rowLabel} field fecha: cannot read date serial ${cell.v}`);
      return formatFecha(parsed.y, parsed.m, parsed.d);
    }
    if (cell.v instanceof Date) {
      return formatFecha(cell.v.getFullYear(), cell.v.getMonth() + 1, cell.v.getDate());
    }
    const text = String(cell.v).trim();
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(text)) {
      throw new Error(`${rowLabel} field fecha: ${JSON.stringify(text)} is not YYYY/MM/DD`);
    }
    return text;
  }

  if (STRING_COLUMNS.has(column)) {
    // SheetJS hands back a number whenever Excel stored the cell as numeric,
    // which drops the zero padding on codigo ("0108001" -> 108001) and bodega
    // ("01" -> 1). Restore it: these must never be re-serialised as numbers (§3).
    if (cell.t === 'n' && typeof cell.v === 'number') {
      const width = PAD_WIDTHS[column];
      const digits = formatExcelGeneral(cell.v);
      return width ? digits.padStart(width, '0') : digits;
    }
    const text = String(cell.v);
    const width = PAD_WIDTHS[column];
    if (width && text.length < width && /^\d*$/.test(text)) {
      return text.padStart(width, '0');
    }
    return text;
  }

  // Numeric column.
  if (cell.t === 'n' && typeof cell.v === 'number') {
    // Excel's General format is what produced the sample .txt, and it caps at
    // 11 characters — see formatExcelGeneral. Using plain shortest form here
    // would make 54 of the 298 costo values disagree with the .txt.
    return formatExcelGeneral(cell.v);
  }
  if (typeof cell.v === 'boolean') {
    throw new Error(`${rowLabel} field ${name}: expected a number, found a boolean`);
  }
  const text = String(cell.v).trim();
  // costo2 is stored as a text cell in the sample; validate rather than trust.
  parseNumber(text, `${rowLabel} field ${name}`);
  return text;
}

/** Map header names to sheet column indices, tolerating case and stray spaces. */
function mapHeader(header: Cell[], sheetName: string): number[] {
  const byName = new Map<string, number>();
  header.forEach((cell, index) => {
    if (cell?.v === undefined || cell.v === null) return;
    const key = String(cell.v).trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, index);
  });

  const missing: string[] = [];
  const indices = ZEUS_COLUMNS.map((name) => {
    const index = byName.get(name.toLowerCase());
    if (index === undefined) missing.push(name);
    return index ?? -1;
  });
  if (missing.length > 0) {
    throw new Error(
      `sheet "${sheetName}": missing expected column(s) ${missing.join(', ')}; ` +
        `found ${[...byName.keys()].join(', ')}`,
    );
  }
  // Observacion is present in the .xls and deliberately dropped (§2).
  return indices;
}

export interface ParseXlsOptions {
  /** Sheet to read. Defaults to the first sheet in the workbook. */
  sheetName?: string;
}

export function parseXls(bytes: Uint8Array, options: ParseXlsOptions = {}): ZeusFile {
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: false });
  const sheetName = options.sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`workbook has no sheet "${sheetName}"; sheets: ${workbook.SheetNames.join(', ')}`);
  }
  const ref = sheet['!ref'];
  if (!ref) throw new Error(`sheet "${sheetName}" is empty`);

  const range = XLSX.utils.decode_range(ref);
  const cellAt = (row: number, col: number): Cell =>
    sheet[XLSX.utils.encode_cell({ r: row, c: col })] as Cell;

  const headerCells: Cell[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) headerCells[c] = cellAt(range.s.r, c);
  const columnIndices = mapHeader(headerCells, sheetName);

  const items: ZeusItem[] = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const rowLabel = `${sheetName} row ${r + 1}`;
    const fields = columnIndices.map((sheetCol, column) =>
      cellToRawField(cellAt(r, sheetCol), column, rowLabel),
    );
    // Skip a fully blank trailing row rather than failing on it.
    if (fields.every((f) => f === '')) continue;
    items.push(itemFromRawRow(fields, rowLabel));
  }

  const first = items[0];
  const same = (pick: (item: ZeusItem) => string) =>
    first && items.every((item) => pick(item) === pick(first)) ? pick(first) : null;

  return {
    items,
    bodega: same((item) => item.bodega),
    fecha: same((item) => item.fecha),
    source: 'xls',
  };
}

/** Exported for tests: the column the .xls carries and the .txt does not (§2). */
export const DROPPED_XLS_COLUMN = XLS_ONLY_COLUMN;
