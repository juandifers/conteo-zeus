/**
 * POST /api/auth   — a login. `{ usuario: 'admin' | 'contador', password }` in,
 *                    `{ token, role, expiresAt }` out, or 401 with one sentence
 *                    that never says which half was wrong.
 * GET  /api/auth   — what the presented token proves: `{ role, expiresAt? }`,
 *                    or 401. The screens use it to decide whether a stored
 *                    login is still worth trusting before drawing anything.
 *
 * The tenth serverless function (of Hobby's twelve — see BACKEND.md on why
 * that number is watched). No database: the two users are deployment
 * configuration and the token is stateless, so this handler is arithmetic.
 * There is deliberately no logout endpoint — a stateless token cannot be
 * revoked server-side, so logout is the client forgetting it, and pretending
 * otherwise here would be theatre.
 */
import { authConfig, bearerOf, checkLogin, mintToken, verifyToken } from './_auth.js';
import { fail, ok, send, type ApiRequest, type ApiResponse } from './_http.js';

export default function handler(request: ApiRequest, response: ApiResponse): void {
  const config = authConfig();
  if (!config) {
    send(
      response,
      fail(503, 'autenticación sin configurar: faltan AUTH_SECRET, ADMIN_PASSWORD o COUNTER_PASSWORD'),
    );
    return;
  }

  if (request.method === 'POST') {
    const body = (request.body ?? {}) as { usuario?: unknown; password?: unknown };
    const role = checkLogin(body.usuario, body.password, config);
    if (!role) {
      send(response, fail(401, 'usuario o contraseña incorrectos'));
      return;
    }
    send(response, ok(mintToken(role, config.secret)));
    return;
  }

  if (request.method === 'GET') {
    const token = bearerOf(request);
    const role = token ? verifyToken(token, config.secret) : null;
    if (!role) {
      send(response, fail(401, 'la sesión caducó o no es válida; inicia sesión otra vez'));
      return;
    }
    send(response, ok({ role }));
    return;
  }

  send(response, fail(405, 'method not allowed'));
}
