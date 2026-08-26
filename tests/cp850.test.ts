import { describe, it, expect } from 'vitest';
import { decodeCp850, encodeCp850 } from '../src/zeus/cp850';

describe('cp850', () => {
  it('round-trips every byte 0x00-0xFF', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const text = decodeCp850(all);
    expect(text.length).toBe(256);
    expect(Array.from(encodeCp850(text))).toEqual(Array.from(all));
  });

  it('decodes ASCII unchanged', () => {
    expect(decodeCp850(new Uint8Array([0x41, 0x09, 0x0d, 0x0a]))).toBe('A\t\r\n');
  });

  it('maps the accented characters this catalogue actually uses', () => {
    // §6: only Í Ñ Ó and friends appear in practice.
    expect(decodeCp850(new Uint8Array([0xa5]))).toBe('Ñ');
    expect(decodeCp850(new Uint8Array([0xd6]))).toBe('Í');
    expect(decodeCp850(new Uint8Array([0xe0]))).toBe('Ó');
    expect(decodeCp850(new Uint8Array([0x90]))).toBe('É');
    expect(decodeCp850(new Uint8Array([0xb5]))).toBe('Á');
    expect(decodeCp850(new Uint8Array([0xe9]))).toBe('Ú');
    expect(Array.from(encodeCp850('PIÑA JAMÓN AJÍ'))).toEqual(
      Array.from(encodeCp850('PI')).concat(
        [0xa5],
        Array.from(encodeCp850('A JAM')),
        [0xe0],
        Array.from(encodeCp850('N AJ')),
        [0xd6],
        [],
      ),
    );
  });

  it('handles the two non-printing entries (§6)', () => {
    expect(decodeCp850(new Uint8Array([0xf0]))).toBe('­');
    expect(decodeCp850(new Uint8Array([0xff]))).toBe(' ');
  });

  it('is not Latin-1: the §3 counter-examples hold', () => {
    // Reading CP850 bytes as Latin-1 turns PIÑA into PI¥A and JAMÓN into JAMàN.
    const pina = encodeCp850('PIÑA');
    const asLatin1 = Array.from(pina, (b) => String.fromCharCode(b)).join('');
    expect(asLatin1).toBe('PI¥A');
    const jamon = encodeCp850('JAMÓN');
    expect(Array.from(jamon, (b) => String.fromCharCode(b)).join('')).toBe('JAMàN');
  });

  it('throws, naming the character and its position, when a character has no CP850 form', () => {
    expect(() => encodeCp850('CAFÉ ☕')).toThrowError(/U\+2615.*position 5/s);
    expect(() => encodeCp850('日')).toThrowError(/U\+65E5/);
    // Never substitute silently.
    expect(() => encodeCp850('a€b')).toThrow();
  });
});
