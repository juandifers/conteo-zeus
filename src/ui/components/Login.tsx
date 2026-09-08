/**
 * The door. One user per face: the desk logs in as `admin`, a tablet as the
 * shared `contador` — so the form asks only for the password, because which
 * user it is was decided by which screen you are standing in front of.
 *
 * The error is whatever the server said, verbatim. It never distinguishes a
 * wrong password from a wrong user (the server refuses to), and a network
 * failure reads as what it is — no señal — rather than as a rejection.
 */
import { useState } from 'react';
import type { Api } from '../api';
import { login, type AuthGate, type Role } from '../auth';

const TITLES: Record<Role, { title: string; body: string }> = {
  admin: {
    title: 'Mesa de conteo',
    body: 'Esta pantalla es del administrador. Inicia sesión para continuar.',
  },
  contador: {
    title: 'Conteo físico',
    body: 'Pide la contraseña de conteo al administrador para preparar esta tableta.',
  },
};

export function Login({
  role,
  api,
  gate,
  onDone,
}: {
  role: Role;
  api: Api;
  gate: AuthGate;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const enter = () => {
    if (busy || password === '') return;
    setBusy(true);
    setProblem(null);
    login(api, gate, role, password).then(
      () => onDone(),
      (cause: unknown) => {
        setBusy(false);
        setProblem(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <div className="screen">
      <div className="masthead">
        <div className="masthead__title">{TITLES[role].title}</div>
      </div>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          enter();
        }}
      >
        <div className="panel__body">
          <p>{TITLES[role].body}</p>
          <label className="field__label" htmlFor="login-password">
            Contraseña
          </label>
          <input
            id="login-password"
            className="field"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {problem && (
            <div className="banner" role="alert">
              {problem}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn--primary" disabled={busy || password === ''}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  );
}
