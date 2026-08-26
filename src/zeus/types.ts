/**
 * Zeus record shape (ZEUS_FORMAT.md §2).
 *
 * Knowledge of tabs, CP850 and column positions lives inside src/zeus/ only.
 * Consumers see `ZeusFile` / `ZeusItem` and nothing else.
 */

/** The .txt carries exactly 24 fields per row (§3). */
export const ZEUS_FIELD_COUNT = 24;

/** Column order, shared by the .txt and the .xls (§2). */
export const ZEUS_COLUMNS = [
  'codigo',
  'nombre',
  'presentacion',
  'existencia',
  'toma',
  'diferencia',
  'costo',
  'lote',
  'clasificacion',
  'ubicacion',
  'serial',
  'idarticulo',
  'bodega',
  'fecha',
  'idconcepto',
  'conteo1',
  'conteo2',
  'conteo3',
  'Grupo1',
  'Grupo2',
  'Grupo3',
  'Grupo4',
  'Grupo5',
  'costo2',
] as const;

/** The 25th .xls column, dropped on export to .txt (§2). */
export const XLS_ONLY_COLUMN = 'Observacion';

/** Index of each field in a raw row. */
export const COL = {
  codigo: 0,
  nombre: 1,
  presentacion: 2,
  existencia: 3,
  toma: 4,
  diferencia: 5,
  costo: 6,
  lote: 7,
  clasificacion: 8,
  ubicacion: 9,
  serial: 10,
  idarticulo: 11,
  bodega: 12,
  fecha: 13,
  idconcepto: 14,
  conteo1: 15,
  conteo2: 16,
  conteo3: 17,
  grupo1: 18,
  grupo2: 19,
  grupo3: 20,
  grupo4: 21,
  grupo5: 22,
  costo2: 23,
} as const;

/** Fixed widths of the zero-padded string fields (§3). */
export const CODIGO_WIDTH = 7;
export const BODEGA_WIDTH = 2;

/** "Not applicable" sentinel, semantically distinct from 0 (§3). */
export const NOT_APPLICABLE = -1;

/** One inventory line. `idarticulo` is the primary key, never `codigo` (§4). */
export interface ZeusItem {
  /** 7 chars, zero-padded, digits only. NOT unique (§4). */
  codigo: string;
  nombre: string;
  presentacion: string;
  /** What Zeus believes is on hand. Decimal — much of the catalogue sells by weight (§3). */
  existencia: number;
  /** The physical count. The field we write (§2). */
  toma: number;
  /** toma - existencia. Recomputed on write. */
  diferencia: number;
  /** Unit cost, up to 6 dp. */
  costo: number;
  lote: string;
  clasificacion: string;
  /** Empty in Zeus today; we plan to populate it. */
  ubicacion: string;
  serial: string;
  /** Unique per row. The real primary key (§4). */
  idarticulo: number;
  /** Zero-padded warehouse code. Must stay a string (§3). */
  bodega: string;
  /** Count date / cutoff, in Zeus's own `YYYY/MM/DD` textual form (§2). */
  fecha: string;
  /** Adjustment reason code; -1 throughout the sample. Passed through (§7.2). */
  idconcepto: number;
  /** Count passes. -1 = unused (§2). */
  conteo1: number;
  conteo2: number;
  conteo3: number;
  grupo1: string;
  grupo2: string;
  grupo3: string;
  grupo4: string;
  grupo5: string;
  /** Same cost at full float precision, up to 13 dp. */
  costo2: number;
  /**
   * All 24 fields verbatim as parsed, in column order.
   *
   * This is what makes the round-trip byte-exact: writeTxt starts from these
   * strings and overwrites only the fields it must, so nothing is reformatted
   * by accident.
   */
  rawRow: string[];
}

/** A parsed Zeus file: the items plus the file-level metadata worth keeping. */
export interface ZeusFile {
  items: ZeusItem[];
  /** Warehouse, when every row agrees on one; null if the file mixes bodegas. */
  bodega: string | null;
  /** Cutoff date `YYYY/MM/DD`, when every row agrees on one; null otherwise. */
  fecha: string | null;
  /** Which representation this came from. */
  source: 'txt' | 'xls';
}
