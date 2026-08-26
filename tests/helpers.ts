import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The real files from the hotel. Note the names use spaces, not the
 * underscores ZEUS_FORMAT.md writes them with.
 */
export const SAMPLE_TXT = join(here, '..', 'samples', 'COMESTIBLES ALMACEN.txt');
export const SAMPLE_XLS = join(here, '..', 'samples', 'COMESTIBLES ALMACEN.xls');

export function readSample(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * Describe the first byte at which two buffers diverge, with surrounding
 * context. The diff is the diagnostic — a bare boolean tells you nothing about
 * whether the cause was number formatting or encoding.
 */
export function firstDifference(actual: Uint8Array, expected: Uint8Array): string | null {
  const limit = Math.min(actual.length, expected.length);
  let offset = -1;
  for (let i = 0; i < limit; i++) {
    if (actual[i] !== expected[i]) {
      offset = i;
      break;
    }
  }
  if (offset === -1) {
    if (actual.length === expected.length) return null;
    offset = limit;
  }

  // Locate the divergence in the file: which row, which field.
  let row = 1;
  let lineStart = 0;
  for (let i = 0; i < Math.min(offset, expected.length); i++) {
    if (expected[i] === 0x0a) {
      row++;
      lineStart = i + 1;
    }
  }
  let field = 0;
  for (let i = lineStart; i < Math.min(offset, expected.length); i++) {
    if (expected[i] === 0x09) field++;
  }

  const show = (buf: Uint8Array) => {
    const from = Math.max(0, offset - 24);
    const to = Math.min(buf.length, offset + 24);
    const slice = Array.from(buf.slice(from, to), (b) => {
      if (b === 0x09) return '\\t';
      if (b === 0x0d) return '\\r';
      if (b === 0x0a) return '\\n';
      return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, '0')}>`;
    }).join('');
    const byte = offset < buf.length ? `0x${buf[offset].toString(16).padStart(2, '0')}` : '<eof>';
    return `${byte}  …${slice}…`;
  };

  return [
    `First difference at byte offset ${offset} (row ${row}, field index ${field})`,
    `  expected: ${show(expected)}`,
    `  actual:   ${show(actual)}`,
    `  lengths: actual ${actual.length}, expected ${expected.length}`,
  ].join('\n');
}
