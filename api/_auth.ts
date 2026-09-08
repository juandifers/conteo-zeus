/**
 * Two users, and the guard every protected handler runs first.
 *
 * The model is exactly what the department asked for and no more: one **admin**
 * user for the desk — sessions, dispatch, review, seal, export — and one
 * general **contador** user shared by every counter. Counters are still told
 * apart by their links (`counters.token`); the shared user is the outer door,
 * the link is which room. Neither user lives in the database: two passwords
 * and a signing secret are deployment configuration, set beside `DATABASE_URL`
 * on the Vercel project, because a users *table* whose only rows would be
 * `admin` and `contador` is a migration and an admin screen for a thing that
 * changes at deployment cadence.
 *
 * A login answers with a stateless bearer token: `v1.<role>.<exp>.<nonce>` plus
 * an HMAC-SHA256 signature under `AUTH_SECRET`. Stateless because serverless —
 * there is no session store to consult on a cold start, and the seal/export
 * path must not gain a second database dependency. The cost is that a token
 * cannot be revoked before it expires; the TTLs are chosen with that in mind,
 * and rotating `AUTH_SECRET` revokes everything at once.
 *
 * Fail closed, loudly: with the three variables unset, every guarded route
 * answers 503 naming the configuration rather than 401 blaming the caller —
 * and never lets anybody through. An unset password must not mean «no door».
 */
import { sha256Hex } from '../src/lib/hash.js';
import { fail, type ApiRequest, type ApiResult } from './_http.js';

// --- HMAC-SHA256 over the synchronous SHA-256 in src/lib ---------------------
//
// Here rather than in `src/lib/` because that layer is a leaf whose files
// import nothing, each other included (tests/boundaries.test.ts), and this is
// its only caller. RFC 2104, not `sha256(secret + message)` — a keyed hash
// built by concatenation inherits SHA-256's length-extension property, which
// is exactly the trap HMAC exists to close.

const BLOCK = 64;

function utf8(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** HMAC-SHA256(key, message), lowercase hex. */
export function hmacSha256Hex(key: string | Uint8Array, message: string | Uint8Array): string {
  let k = utf8(key);
  if (k.length > BLOCK) k = hexToBytes(sha256Hex(k));

  const inner = new Uint8Array(BLOCK);
  const outer = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = (k[i] ?? 0) ^ 0x36;
    outer[i] = (k[i] ?? 0) ^ 0x5c;
  }

  const body = utf8(message);
  const innerInput = new Uint8Array(BLOCK + body.length);
  innerInput.set(inner);
  innerInput.set(body, BLOCK);
  const innerDigest = hexToBytes(sha256Hex(innerInput));

  const outerInput = new Uint8Array(BLOCK + innerDigest.length);
  outerInput.set(outer);
  outerInput.set(innerDigest, BLOCK);
  return sha256Hex(outerInput);
}

/**
 * Constant-time string equality, for secrets and signatures. Length is allowed
 * to leak — both inputs are fixed-length digests or passwords whose length an
 * attacker can already bound — but no byte position is.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export type Role = 'admin' | 'contador';

/** How long a login lasts. The counter's is long because tablets drain late. */
const TTL_SECONDS: Record<Role, number> = {
  admin: 12 * 60 * 60,
  contador: 30 * 24 * 60 * 60,
};

interface AuthConfig {
  secret: string;
  passwords: Record<Role, string>;
}

/** The deployment's auth material, or `null` when any piece is missing. */
export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const secret = env.AUTH_SECRET;
  const admin = env.ADMIN_PASSWORD;
  const contador = env.COUNTER_PASSWORD;
  if (!secret || !admin || !contador) return null;
  return { secret, passwords: { admin, contador } };
}

const UNCONFIGURED = fail(
  503,
  'autenticación sin configurar: faltan AUTH_SECRET, ADMIN_PASSWORD o COUNTER_PASSWORD',
);

function signable(role: Role, expires: number, nonce: string): string {
  return `v1.${role}.${expires}.${nonce}`;
}

/** Mint a signed token for `role`, valid for that role's TTL from `now`. */
export function mintToken(
  role: Role,
  secret: string,
  now: () => number = Date.now,
): { token: string; role: Role; expiresAt: string } {
  const expires = Math.floor(now() / 1000) + TTL_SECONDS[role];
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const head = signable(role, expires, nonce);
  return {
    token: `${head}.${hmacSha256Hex(secret, head)}`,
    role,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

/** The role a token proves, or `null` — expired, malformed, or forged alike. */
export function verifyToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Role | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, role, expiresRaw, nonce, signature] = parts;
  if (role !== 'admin' && role !== 'contador') return null;
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires)) return null;
  const expected = hmacSha256Hex(secret, signable(role, expires, nonce));
  if (!timingSafeEqualStr(signature, expected)) return null;
  if (expires * 1000 <= now()) return null;
  return role;
}

/** The bearer token on the request, or `null`. */
export function bearerOf(request: ApiRequest): string | null {
  const raw = request.headers?.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : null;
}

/**
 * The refusal to send, or `null` when the request may proceed.
 *
 * Called first in every guarded handler — before `param`, before the database
 * — so an unauthenticated request costs nothing and learns nothing, not even
 * whether a session id exists. An admin token passes every door; the shared
 * counter token passes only the doors that name it.
 */
export function requireRole(
  request: ApiRequest,
  roles: readonly Role[],
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): ApiResult | null {
  const config = authConfig(env);
  if (!config) return UNCONFIGURED;
  const token = bearerOf(request);
  if (!token) return fail(401, 'hace falta iniciar sesión');
  const role = verifyToken(token, config.secret, now);
  if (!role) return fail(401, 'la sesión caducó o no es válida; inicia sesión otra vez');
  if (!roles.includes(role) && role !== 'admin') {
    return fail(403, 'esta pantalla es del administrador');
  }
  return null;
}

/**
 * Check a login attempt. The error is the same sentence whichever half was
 * wrong: naming which of user/password failed is a free oracle.
 */
export function checkLogin(
  usuario: unknown,
  password: unknown,
  config: AuthConfig,
): Role | null {
  if (usuario !== 'admin' && usuario !== 'contador') return null;
  if (typeof password !== 'string' || password.length === 0) return null;
  return timingSafeEqualStr(password, config.passwords[usuario]) ? usuario : null;
}
