/**
 * CP850 (MS-DOS Latin-1) codec.
 *
 * Zeus Inventarios exchanges its .txt in CP850 (ZEUS_FORMAT.md §3, §6).
 * The browser's TextEncoder/TextDecoder only speak UTF-8, so the codec is
 * hand-built from the 128-character table in §6.
 */

/**
 * Bytes 0x80-0xFF, in order. Transcribed verbatim from ZEUS_FORMAT.md §6.
 * Two entries are non-printing: U+00AD (soft hyphen) at 0xF0 and
 * U+00A0 (no-break space) at 0xFF.
 */
const HIGH_TABLE =
  'ÇüéâäàåçêëèïîìÄÅ' + // 0x80-0x8F
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + // 0x90-0x9F
  'áíóúñÑªº¿®¬½¼¡«»' + // 0xA0-0xAF
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' + // 0xB0-0xBF
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + // 0xC0-0xCF
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + // 0xD0-0xDF
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + // 0xE0-0xEF
  '­±‗¾¶§÷¸°¨·¹³²■ '; // 0xF0-0xFF

if (HIGH_TABLE.length !== 128) {
  throw new Error(`CP850 high table must hold 128 characters, got ${HIGH_TABLE.length}`);
}

/** char -> byte, for the full 0x00-0xFF range. */
const ENCODE_MAP: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 0x80; byte++) map.set(String.fromCharCode(byte), byte);
  for (let i = 0; i < HIGH_TABLE.length; i++) {
    const char = HIGH_TABLE[i];
    // The table is injective in CP850; guard against a transcription slip.
    if (map.has(char)) {
      throw new Error(`CP850 table defines ${JSON.stringify(char)} twice`);
    }
    map.set(char, 0x80 + i);
  }
  return map;
})();

/** Decode CP850 bytes to a JS string. Every byte 0x00-0xFF is representable. */
export function decodeCp850(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    out[i] = byte < 0x80 ? String.fromCharCode(byte) : HIGH_TABLE[byte - 0x80];
  }
  return out.join('');
}

/**
 * Encode a JS string to CP850 bytes.
 *
 * A character with no CP850 representation is a hard error (§6): silently
 * substituting would corrupt a product name on its way into the ERP.
 */
export function encodeCp850(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const byte = ENCODE_MAP.get(char);
    if (byte === undefined) {
      const codePoint = char.codePointAt(0) ?? 0;
      const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
      throw new Error(
        `Cannot encode ${JSON.stringify(char)} (U+${hex}) at position ${i}: ` +
          'no CP850 representation',
      );
    }
    out[i] = byte;
  }
  return out;
}
