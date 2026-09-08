// @vitest-environment jsdom
/**
 * The door in front of the two networked faces.
 *
 * What is asserted here is the client's half only — which screen is drawn, and
 * that a login travels through the port and is stored. The server's half (the
 * guard on every route, the token arithmetic) lives in
 * `tests/backend/auth.test.ts`; a UI gate is a convenience, and these tests
 * would prove nothing about security if that suite did not exist.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminApp } from '../../src/ui/admin/AdminApp';
import { ApiError, reauthOn401, type Api } from '../../src/ui/api';
import { storageAuth, type AuthSession } from '../../src/ui/auth';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SESSION: AuthSession = {
  token: 'v1.admin.9999999999.aa.bb',
  role: 'admin',
  expiresAt: '2286-11-20T17:46:39.000Z',
};

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    get: vi.fn(async () => ({ sessions: [] }) as never),
    post: vi.fn(async () => ({}) as never),
    patch: vi.fn(async () => ({}) as never),
    del: vi.fn(async () => ({}) as never),
    ...over,
  };
}

describe('the admin door', () => {
  it('asks for the admin password before drawing anything about sessions', () => {
    render(<AdminApp api={fakeApi()} hash="#/admin" navigate={() => {}} auth={storageAuth()} />);
    expect(screen.getByText(/Esta pantalla es del administrador/)).toBeTruthy();
    expect(screen.getByLabelText('Contraseña')).toBeTruthy();
    expect(screen.queryByText(/Conteos/)).toBeNull();
  });

  it('logs in through /api/auth, stores the session, and opens the desk', async () => {
    const post = vi.fn(async () => SESSION as never);
    const api = fakeApi({ post });
    render(<AdminApp api={api} hash="#/admin" navigate={() => {}} auth={storageAuth()} />);

    await userEvent.type(screen.getByLabelText('Contraseña'), 'clave-admin');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(post).toHaveBeenCalledWith('/api/auth', {
      usuario: 'admin',
      password: 'clave-admin',
    });
    // The stored login is what the next launch reads.
    expect(storageAuth().current()).toEqual(SESSION);
    // And the desk is drawn: the list fetch ran.
    expect(api.get).toHaveBeenCalledWith('/api/sessions');
  });

  it('shows the server’s sentence when the password is wrong, and stores nothing', async () => {
    const post = vi.fn(async () => {
      throw new Error('usuario o contraseña incorrectos');
    });
    render(
      <AdminApp api={fakeApi({ post })} hash="#/admin" navigate={() => {}} auth={storageAuth()} />,
    );
    await userEvent.type(screen.getByLabelText('Contraseña'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'usuario o contraseña incorrectos',
    );
    expect(storageAuth().current()).toBeNull();
    expect(screen.getByLabelText('Contraseña')).toBeTruthy();
  });

  it('refuses a stored counter login: the desk is the admin’s', () => {
    storageAuth().save({ ...SESSION, role: 'contador' });
    render(<AdminApp api={fakeApi()} hash="#/admin" navigate={() => {}} auth={storageAuth()} />);
    expect(screen.getByText(/Esta pantalla es del administrador/)).toBeTruthy();
  });

  it('opens straight through with a stored admin login', () => {
    storageAuth().save(SESSION);
    const api = fakeApi();
    render(<AdminApp api={api} hash="#/admin" navigate={() => {}} auth={storageAuth()} />);
    expect(screen.queryByLabelText('Contraseña')).toBeNull();
    expect(api.get).toHaveBeenCalledWith('/api/sessions');
  });

  it('drops a login the server refuses and shows the form again — the reported dead end', async () => {
    // The stored login looks fine to the client (`current()` never judges
    // expiry — offline tablets must render), but the server answers 401.
    // Before `reauthOn401` this was a banner with no door: the token stayed
    // in storage and every refresh replayed the same refusal.
    storageAuth().save(SESSION);
    const get = vi.fn(async () => {
      throw new ApiError(401, 'la sesión caducó o no es válida; inicia sesión otra vez', null);
    });
    render(
      <AdminApp api={fakeApi({ get })} hash="#/admin" navigate={() => {}} auth={storageAuth()} />,
    );
    expect(await screen.findByText(/Esta pantalla es del administrador/)).toBeTruthy();
    expect(screen.getByLabelText('Contraseña')).toBeTruthy();
    expect(storageAuth().current()).toBeNull();
  });
});

describe('reauthOn401, the wrapper both faces route every request through', () => {
  const expired = async () => {
    throw new ApiError(401, 'la sesión caducó o no es válida; inicia sesión otra vez', null);
  };

  it('a 401 from a guarded route drops the login, tells the screen, and still rethrows', async () => {
    storageAuth().save(SESSION);
    const onExpired = vi.fn();
    const door = reauthOn401(fakeApi({ get: vi.fn(expired) }), storageAuth(), onExpired);
    await expect(door.get('/api/sessions')).rejects.toMatchObject({ status: 401 });
    expect(onExpired).toHaveBeenCalledOnce();
    expect(storageAuth().current()).toBeNull();
  });

  it('leaves the login alone for anything that is not a 401 — offline above all', async () => {
    storageAuth().save(SESSION);
    const onExpired = vi.fn();
    const offline = async () => {
      throw new ApiError(0, 'No hay conexión con el servidor (falló).', null);
    };
    const door = reauthOn401(fakeApi({ get: vi.fn(offline) }), storageAuth(), onExpired);
    await expect(door.get('/api/sessions')).rejects.toMatchObject({ status: 0 });
    expect(onExpired).not.toHaveBeenCalled();
    expect(storageAuth().current()).toEqual(SESSION);
  });

  it('a 401 from /api/auth itself is a wrong password, not an expired session', async () => {
    storageAuth().save(SESSION);
    const onExpired = vi.fn();
    const wrong = async () => {
      throw new ApiError(401, 'usuario o contraseña incorrectos', null);
    };
    const door = reauthOn401(fakeApi({ post: vi.fn(wrong) }), storageAuth(), onExpired);
    await expect(door.post('/api/auth', { usuario: 'admin', password: 'nope' })).rejects.toThrow();
    expect(onExpired).not.toHaveBeenCalled();
    expect(storageAuth().current()).toEqual(SESSION);
  });
});
