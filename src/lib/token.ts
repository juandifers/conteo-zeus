/**
 * Bearer tokens for counter links.
 *
 * **This is not authentication and nothing here should be read as if it were.**
 * A counter's link is a URL somebody opens on a shared tablet; whoever holds it
 * gets that counter's view of one session, and P2 has no accounts, no
 * passwords and no way to revoke one. That limitation is deliberate, written
 * down in `docs/BACKEND.md`, and the reason this module exists at all is that
 * *unguessable* is the one property still available once *authenticated* has
 * been given up.
 *
 * So: 128 bits from the platform CSPRNG, and nothing else. No sequential ids,
 * no name-derived slugs, no six-character codes somebody can read out over the
 * phone. A short code is exactly the thing that turns "you would have to guess
 * a token" into "you would have to try a few million times", and there is no
 * rate limiter in front of this.
 *
 * Bottom of the dependency graph like the rest of `src/lib/`: it imports
 * nothing, and `crypto` is a platform global on both sides — the browser that
 * never mints one and the serverless function that does.
 */

/** 16 bytes. The whole point; do not make it configurable. */
const TOKEN_BYTES = 16;

/** Characters that survive a URL, a QR code and a printed sheet unchanged. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * How long a token is, so a validator does not have to recompute it.
 *
 * 128 bits at 6 bits per character: 22 characters, the last carrying 2 bits.
 */
export const TOKEN_LENGTH = 22;

/** Whether a string could be one of ours. Shape only — says nothing about existence. */
export function isTokenShaped(value: string): boolean {
  return value.length === TOKEN_LENGTH && [...value].every((ch) => ALPHABET.includes(ch));
}

/**
 * A fresh token: 128 CSPRNG bits, base64url, no padding.
 *
 * Encoded by hand rather than through `btoa` — `btoa` does not exist in every
 * runtime this may end up in, its output needs three characters substituted
 * afterwards anyway, and a token is not the place to find out that a polyfill
 * disagreed about padding.
 */
export function newToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  // Throws where there is no CSPRNG, which is the correct outcome: a token
  // from `Math.random()` is a token that can be predicted from the others.
  globalThis.crypto.getRandomValues(bytes);

  let bits = 0;
  let held = 0;
  let out = '';
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(held >> bits) & 0b111111];
    }
  }
  // 128 is not a multiple of 6: two bits are left over and become the last
  // character's high bits. Dropping them would make the token 126 bits.
  if (bits > 0) out += ALPHABET[(held << (6 - bits)) & 0b111111];
  return out;
}
