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
import type { Api } from '../../src/ui/api';
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
});
