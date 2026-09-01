/**
 * Counter tokens.
 *
 * There is no authentication in P2, so unguessability is the only property
 * these have. A test that merely asserted "returns a string" would pass for
 * `counter-1`, which is the shape this file exists to make impossible.
 */
import { describe, expect, it } from 'vitest';

import { isTokenShaped, newToken, TOKEN_LENGTH } from '../src/lib/token';

describe('newToken', () => {
  it('is 22 URL-safe characters — 128 bits at 6 bits each', () => {
    const token = newToken();
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Survives a URL untouched: no percent-encoding, so the link in the QR code
    // and the link on the printed sheet are the same string.
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 20000 }, () => newToken()));
    expect(tokens.size).toBe(20000);
  });

  it('carries the full 128 bits, including the two that do not fit', () => {
    // 128 is not a multiple of 6. Dropping the two left-over bits would make
    // every token 126 bits and would pin the last character to a quarter of the
    // alphabet — visible here as a last position that never varies enough.
    const last = new Set(Array.from({ length: 2000 }, () => newToken()[TOKEN_LENGTH - 1]));
    expect(last.size).toBeGreaterThan(3);
  });

  it('spreads over the alphabet rather than a corner of it', () => {
    const seen = new Set([...Array.from({ length: 500 }, () => newToken()).join('')]);
    expect(seen.size).toBeGreaterThan(60);
  });

  it('uses the platform CSPRNG and does not fall back to anything', () => {
    // A token from `Math.random()` can be predicted from the others, so the
    // correct behaviour with no CSPRNG is to fail loudly rather than to mint
    // something that looks the same.
    const real = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      expect(() => newToken()).toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});

describe('isTokenShaped', () => {
  it('accepts what newToken mints', () => {
    for (let i = 0; i < 100; i++) expect(isTokenShaped(newToken())).toBe(true);
  });

  it('rejects the shapes somebody would reach for instead', () => {
    for (const guess of ['counter-1', '1', 'ana', '', 'a'.repeat(21), 'a'.repeat(23), 'ana+luis/x=']) {
      expect(isTokenShaped(guess)).toBe(false);
    }
  });

  it('says nothing about whether a token exists', () => {
    // Shape only. A well-formed token for a session that was never created is
    // still a 404, and the endpoint is what decides that.
    expect(isTokenShaped('A'.repeat(TOKEN_LENGTH))).toBe(true);
  });
});
