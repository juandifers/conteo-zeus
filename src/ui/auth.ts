/**
 * The device's memory of who logged in, and the port the screens gate on.
 *
 * Two users exist (api/_auth.ts): `admin` for the desk and one shared
 * `contador` for every tablet. What this module holds is only the *client's*
 * copy of that fact — a bearer token in `localStorage` — because the real
 * door is the server's: every guarded route re-verifies the signature on
 * every request, and a device that lies to itself here gets a 401 there.
 *
 * `current()` returns the stored login even when its `expiresAt` has passed.
 * That is deliberate, for the counting side: a tablet reopened offline in a
 * corridor must still render from Dexie (DOMAIN.md §6.3), and an expiry gate
 * that needed the network to re-login would blank exactly the screen that
 * exists to work without one. The server is the judge of expiry; the screens
 * treat a stored login as «worth trying» and a 401 as the answer.
 *
 * A port with two implementations, like `Updates` beside it: `storageAuth()`
 * is the browser's, `openAuth()` is the always-authenticated null object the
 * tests and the local P1 app get, so no fixture has to fake a login to render
 * a screen about counting.
 */
import type { Api } from './api';

export type Role = 'admin' | 'contador';

export interface AuthSession {
  token: string;
  role: Role;
  expiresAt: string;
}

export interface AuthGate {
  /** The stored login, expired or not — see the module note. `null` = never logged in. */
  current(): AuthSession | null;
  save(session: AuthSession): void;
  clear(): void;
}

const KEY = 'conteo.auth';

/** The browser's gate. Storage failures read as «not logged in», never as a crash. */
export function storageAuth(): AuthGate {
  return {
    current() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AuthSession>;
        if (
          typeof parsed.token !== 'string' ||
          (parsed.role !== 'admin' && parsed.role !== 'contador') ||
          typeof parsed.expiresAt !== 'string'
        ) {
          return null;
        }
        return parsed as AuthSession;
      } catch {
        return null;
      }
    },
    save(session) {
      try {
        localStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // A full or blocked storage costs re-login on the next launch, nothing else.
      }
    },
    clear() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Same trade as above.
      }
    },
  };
}

/** Always authenticated: the tests' and the local P1 app's answer. */
export function openAuth(): AuthGate {
  return {
    current: () => ({
      token: '',
      role: 'admin',
      expiresAt: '9999-12-31T00:00:00.000Z',
    }),
    save: () => {},
    clear: () => {},
  };
}

/** POST the login and store what came back. Throws `ApiError` upward for the form. */
export async function login(
  api: Api,
  gate: AuthGate,
  usuario: Role,
  password: string,
): Promise<AuthSession> {
  const session = await api.post<AuthSession>('/api/auth', { usuario, password });
  gate.save(session);
  return session;
}

/**
 * The `Authorization` header for the stored login, for the fetch wrapper.
 * Empty when nobody has logged in — the server answers 401 and the screen
 * shows the form, which is the same conversation with fewer special cases.
 */
export function authHeader(gate: AuthGate): Record<string, string> {
  const session = gate.current();
  return session && session.token !== '' ? { Authorization: `Bearer ${session.token}` } : {};
}
