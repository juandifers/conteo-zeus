/**
 * Base64, by hand.
 *
 * Not `btoa`/`atob` and not `Buffer`: this runs in a browser, in a Vercel
 * function and in Node under Vitest, and exactly one of those has each of
 * those. `btoa` also takes a string, so using it means a byte array through a
 * latin-1 round trip — which is the kind of thing that works on every file
 * until the one with a `0xFF` in it.
 *
 * The file being encoded here is the imported `.xls`, stored verbatim because
 * an export months later has to be built from it (DOMAIN.md §6). It has to
 * survive this unchanged, byte for byte, or nothing downstream means anything.
 *
 * Bottom of the dependency graph like the rest of `src/lib/`: imports nothing.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0b11) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b & 0b1111) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[c & 0b111111] : '=';
  }
  return out;
}

/** The inverse. Rejects a character that is not base64 rather than skipping it. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const bytes = new Uint8Array((clean.length * 6) >> 3);
  let held = 0;
  let bits = 0;
  let out = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`«${ch}» no es base64`);
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (held >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, out);
}
