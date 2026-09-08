/**
 * The two users and their tokens — api/_auth.ts and the /api/auth handler.
 *
 * No database anywhere in here: the whole point of the stateless design is
 * that a login is arithmetic, so this suite runs on any laptop, like the
 * domain tests. What needs a real Postgres — that the guarded handlers refuse
 * *before* touching the pool — is asserted here too, precisely because the
 * refusal happens before `dbFromEnv()`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  authConfig,
  checkLogin,
  hmacSha256Hex,
  mintToken,
  requireRole,
  timingSafeEqualStr,
  verifyToken,
} from '../../api/_auth';
import authHandler from '../../api/auth';
import sessionsHandler from '../../api/sessions/index';
import counterHandler from '../../api/c/[token]/index';
import type { ApiRequest, ApiResponse, ApiResult } from '../../api/_http';

const SECRET = 's'.repeat(32);
const ENV = {
  AUTH_SECRET: SECRET,
  ADMIN_PASSWORD: 'clave-admin',
  COUNTER_PASSWORD: 'clave-conteo',
} as NodeJS.ProcessEnv;

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function capture(): { response: ApiResponse; sent: () => ApiResult } {
  let status = 0;
  let body: unknown = null;
  const response: ApiResponse = {
    status(code) {
      status = code;
      return response;
    },
    setHeader() {},
    json(payload) {
      body = payload;
    },
  };
  return { response, sent: () => ({ status, body }) };
}

describe('the HMAC underneath every token', () => {
  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('compares without an early exit, and refuses unequal lengths', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'ab')).toBe(false);
  });
});

describe('mint and verify', () => {
  it('round-trips each role', () => {
    for (const role of ['admin', 'contador'] as const) {
      const minted = mintToken(role, SECRET, () => NOW);
      expect(verifyToken(minted.token, SECRET, () => NOW)).toBe(role);
    }
  });

  it('expires: the admin token in hours, the counter token in weeks', () => {
    const admin = mintToken('admin', SECRET, () => NOW);
    const contador = mintToken('contador', SECRET, () => NOW);
    const nextDay = () => NOW + 24 * 60 * 60 * 1000;
    expect(verifyToken(admin.token, SECRET, nextDay)).toBeNull();
    expect(verifyToken(contador.token, SECRET, nextDay)).toBe('contador');
    const nextMonth = () => NOW + 31 * 24 * 60 * 60 * 1000;
    expect(verifyToken(contador.token, SECRET, nextMonth)).toBeNull();
  });

  it('refuses a re-signed role swap and any tamper', () => {
    const minted = mintToken('contador', SECRET, () => NOW);
    const parts = minted.token.split('.');
    // Same signature, promoted role.
    const promoted = ['v1', 'admin', parts[2], parts[3], parts[4]].join('.');
    expect(verifyToken(promoted, SECRET, () => NOW)).toBeNull();
    // Signature re-minted under the wrong secret.
    const forged = mintToken('admin', 'otro-secreto', () => NOW);
    expect(verifyToken(forged.token, SECRET, () => NOW)).toBeNull();
    // Garbage shapes.
    expect(verifyToken('', SECRET, () => NOW)).toBeNull();
    expect(verifyToken('v1.admin.zzz.aa.bb', SECRET, () => NOW)).toBeNull();
  });
});

describe('the login check', () => {
  const config = authConfig(ENV)!;

  it('accepts each user with its own password and nothing else', () => {
    expect(checkLogin('admin', 'clave-admin', config)).toBe('admin');
    expect(checkLogin('contador', 'clave-conteo', config)).toBe('contador');
    expect(checkLogin('admin', 'clave-conteo', config)).toBeNull();
    expect(checkLogin('contador', 'clave-admin', config)).toBeNull();
    expect(checkLogin('root', 'clave-admin', config)).toBeNull();
    expect(checkLogin('admin', '', config)).toBeNull();
    expect(checkLogin('admin', undefined, config)).toBeNull();
  });

  it('is unconfigured when any of the three variables is missing', () => {
    expect(authConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(authConfig({ ...ENV, ADMIN_PASSWORD: '' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('requireRole, the guard every protected handler runs first', () => {
  const withToken = (token: string): ApiRequest => ({
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });

  it('lets the right role through and refuses the rest', () => {
    const admin = mintToken('admin', SECRET, () => NOW).token;
    const contador = mintToken('contador', SECRET, () => NOW).token;

    expect(requireRole(withToken(admin), ['admin'], ENV, () => NOW)).toBeNull();
    expect(requireRole(withToken(contador), ['contador'], ENV, () => NOW)).toBeNull();
    // The admin passes every door; the shared counter user does not.
    expect(requireRole(withToken(admin), ['contador'], ENV, () => NOW)).toBeNull();
    expect(requireRole(withToken(contador), ['admin'], ENV, () => NOW)?.status).toBe(403);
  });

  it('answers 401 with no token and 401 for an expired one', () => {
    expect(requireRole({ method: 'GET' }, ['admin'], ENV, () => NOW)?.status).toBe(401);
    const stale = mintToken('admin', SECRET, () => NOW - 13 * 60 * 60 * 1000).token;
    expect(requireRole(withToken(stale), ['admin'], ENV, () => NOW)?.status).toBe(401);
  });

  it('fails closed — 503, never 200 — when auth is unconfigured', () => {
    const admin = mintToken('admin', SECRET, () => NOW).token;
    expect(requireRole(withToken(admin), ['admin'], {} as NodeJS.ProcessEnv)?.status).toBe(503);
  });
});

describe('the handlers refuse before they touch anything', () => {
  it('POST /api/auth answers a token for a good login and one sentence for a bad one', () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.stubEnv('ADMIN_PASSWORD', 'clave-admin');
    vi.stubEnv('COUNTER_PASSWORD', 'clave-conteo');
    try {
      const good = capture();
      authHandler(
        { method: 'POST', body: { usuario: 'contador', password: 'clave-conteo' } },
        good.response,
      );
      expect(good.sent().status).toBe(200);
      const payload = good.sent().body as { token: string; role: string };
      expect(payload.role).toBe('contador');
      expect(verifyToken(payload.token, SECRET)).toBe('contador');

      const bad = capture();
      authHandler(
        { method: 'POST', body: { usuario: 'contador', password: 'nope' } },
        bad.response,
      );
      expect(bad.sent()).toEqual({
        status: 401,
        body: { error: 'usuario o contraseña incorrectos' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the sessions and counter handlers answer 401 before reaching for the database', async () => {
    // No DATABASE_URL is set in this suite: reaching the pool would throw a
    // different error, so a clean 401 *is* the proof the guard runs first.
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.stubEnv('ADMIN_PASSWORD', 'clave-admin');
    vi.stubEnv('COUNTER_PASSWORD', 'clave-conteo');
    vi.stubEnv('DATABASE_URL', '');
    try {
      const sessions = capture();
      await sessionsHandler({ method: 'GET' }, sessions.response);
      expect(sessions.sent().status).toBe(401);

      // The shared counter token is not an admin.
      const contador = mintToken('contador', SECRET).token;
      const forbidden = capture();
      await sessionsHandler(
        { method: 'GET', headers: { authorization: `Bearer ${contador}` } },
        forbidden.response,
      );
      expect(forbidden.sent().status).toBe(403);

      const counter = capture();
      await counterHandler(
        { method: 'GET', query: { token: 'A'.repeat(22) } },
        counter.response,
      );
      expect(counter.sent().status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
