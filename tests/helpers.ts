import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

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

/** One line of the verifier's verdict: a claim, whether it held, and where. */
export interface Check {
  ok: boolean;
  titulo: string;
  where: string;
}

export interface Verificador {
  verify(bundle: unknown, txtBytes: Uint8Array | null): Check[];
  sha256Hex(bytes: Uint8Array): string;
  codigoSello(sessionHash: string): string;
}

/**
 * Load the verifier's script out of `tools/verificador.html` and run it.
 *
 * The script, not a re-export: what is under test is the file somebody opens in
 * a browser in 2029, and a test that exercised anything else would be testing a
 * copy. `runInNewContext` gives it a global object with no `document`, which is
 * why the page-wiring half of the file is guarded on `getElementById`.
 *
 * Here rather than beside its own suite because two suites need it, and for the
 * same reason: `tests/verificador.test.ts` holds the second implementation
 * against the domain, and `tests/backend/sellar.pg.test.ts` holds it against a
 * bundle the real handlers produced from a real database. Only the second one
 * can tell you the seal was computed over the right inputs.
 */
export function loadVerificador(): Verificador {
  const html = readFileSync(join(here, '..', 'tools', 'verificador.html'), 'utf8');
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('tools/verificador.html has no <script> block');
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder, console };
  sandbox.globalThis = sandbox;
  runInNewContext(match[1], sandbox, { filename: 'verificador.html' });
  const api = sandbox.__verificador as Verificador | undefined;
  if (!api) throw new Error('verificador.html did not expose __verificador');
  return api;
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
