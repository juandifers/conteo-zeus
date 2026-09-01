/**
 * Zeus .txt ("Texto MSDOS") reader — ZEUS_FORMAT.md §3.
 *
 * CP850, tab-delimited, CRLF-terminated including the final row, no header,
 * no trailer, exactly 24 fields per row.
 */
import { decodeCp850 } from './cp850.js';
import { parseNumber } from './formatNumber.js';
import { COL, ZEUS_FIELD_COUNT, type ZeusFile, type ZeusItem } from './types.js';

/** Build a ZeusItem from 24 already-split raw fields. Shared with parseXls. */
export function itemFromRawRow(fields: string[], rowLabel: string): ZeusItem {
  if (fields.length !== ZEUS_FIELD_COUNT) {
    throw new Error(
      `${rowLabel}: expected ${ZEUS_FIELD_COUNT} fields, found ${fields.length}`,
    );
  }
  const num = (index: number, name: string) =>
    parseNumber(fields[index], `${rowLabel} field ${name}`);

  return {
    // codigo and bodega stay strings: parsing them to a number would drop the
    // zero padding and they could never be re-serialised correctly (§3).
    codigo: fields[COL.codigo],
    nombre: fields[COL.nombre],
    presentacion: fields[COL.presentacion],
    existencia: num(COL.existencia, 'existencia'),
    toma: num(COL.toma, 'toma'),
    diferencia: num(COL.diferencia, 'diferencia'),
    costo: num(COL.costo, 'costo'),
    lote: fields[COL.lote],
    clasificacion: fields[COL.clasificacion],
    ubicacion: fields[COL.ubicacion],
    serial: fields[COL.serial],
    idarticulo: num(COL.idarticulo, 'idarticulo'),
    bodega: fields[COL.bodega],
    fecha: fields[COL.fecha],
    idconcepto: num(COL.idconcepto, 'idconcepto'),
    conteo1: num(COL.conteo1, 'conteo1'),
    conteo2: num(COL.conteo2, 'conteo2'),
    conteo3: num(COL.conteo3, 'conteo3'),
    grupo1: fields[COL.grupo1],
    grupo2: fields[COL.grupo2],
    grupo3: fields[COL.grupo3],
    grupo4: fields[COL.grupo4],
    grupo5: fields[COL.grupo5],
    costo2: num(COL.costo2, 'costo2'),
    rawRow: fields,
  };
}

/** The single value shared by every item, or null when they disagree. */
function commonValue(items: ZeusItem[], pick: (item: ZeusItem) => string): string | null {
  if (items.length === 0) return null;
  const first = pick(items[0]);
  return items.every((item) => pick(item) === first) ? first : null;
}

export function parseTxt(bytes: Uint8Array): ZeusFile {
  const text = decodeCp850(bytes);
  if (text.length === 0) {
    throw new Error('Zeus .txt is empty');
  }
  if (!text.endsWith('\r\n')) {
    throw new Error('Zeus .txt must end with CRLF (§3)');
  }

  // Split on CRLF and drop the empty tail the final CRLF produces.
  const lines = text.slice(0, -2).split('\r\n');

  const items = lines.map((line, index) => {
    const rowLabel = `row ${index + 1}`;
    if (line.includes('\n') || line.includes('\r')) {
      throw new Error(`${rowLabel}: contains a bare CR or LF; line endings must be CRLF (§3)`);
    }
    return itemFromRawRow(line.split('\t'), rowLabel);
  });

  return {
    items,
    bodega: commonValue(items, (item) => item.bodega),
    fecha: commonValue(items, (item) => item.fecha),
    source: 'txt',
  };
}
