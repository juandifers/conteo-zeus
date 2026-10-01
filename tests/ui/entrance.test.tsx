// @vitest-environment jsdom
/**
 * What the plain address — and so the app icon — opens (Entrance.tsx).
 *
 * The installed app starts at `/`. Before 2026-10 that was always the
 * single-device app, so a tablet prepared from a counter link and reopened
 * from its icon landed on screens that had nothing of its assignment in them.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryChain, MemoryRepository, type CounterPayload } from '../../src/domain';
import type { AssignmentStore } from '../../src/store';
import type { CounterAssignmentRow } from '../../src/store/db';
import type { Api } from '../../src/ui/api';
import { Root } from '../../src/ui/Root';
import { samplePayload } from './counterHarness';

const offline = async () => {
  throw new Error('sin red');
};
const api: Api = { get: offline, post: offline, patch: offline };

function link(token: string, fetchedAt: string, nombre: string): CounterAssignmentRow {
  const base = samplePayload();
  const payload: CounterPayload = {
    ...base,
    session: { ...base.session, id: `s-${token}` },
    counter: { id: `c-${token}`, nombre },
  };
  return { token, sessionId: payload.session.id, counterId: payload.counter.id, fetchedAt, payload };
}

function prepared(rows: CounterAssignmentRow[]): AssignmentStore {
  return {
    save: async () => {},
    load: async (token) => rows.find((row) => row.token === token) ?? null,
    list: async () => rows,
    remove: async () => {},
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function go(hash: string): void {
  globalThis.history.replaceState(null, '', `/${hash}`);
}

function draw(rows: CounterAssignmentRow[]) {
  return render(
    <Root
      repo={new MemoryRepository()}
      assignments={prepared(rows)}
      chain={new MemoryChain()}
      api={api}
    />,
  );
}

beforeEach(() => go(''));
afterEach(() => {
  cleanup();
  go('');
});

describe('the plain address', () => {
  it('is the single-device app when nothing is prepared on the tablet', async () => {
    draw([]);
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
    expect(globalThis.location.hash).toBe('');
  });

  it('opens the one counter link prepared recently, leaving no way «back» into a loop', async () => {
    const before = globalThis.history.length;
    draw([link('tok-hoy', ago(60 * 60 * 1000), 'Ana')]);
    await waitFor(() => expect(globalThis.location.hash).toBe('#/c/tok-hoy'));
    // Replaced, not pushed: «back» from the counter must not land on a screen
    // that sends it straight forward again.
    expect(globalThis.history.length).toBe(before);
    expect(screen.queryByText('Trae un archivo de Zeus y empieza')).toBeNull();
  });

  it('asks about a link from last month instead of walking into a sealed count', async () => {
    const user = userEvent.setup();
    draw([link('tok-viejo', ago(30 * 24 * 60 * 60 * 1000), 'Ana')]);
    expect(await screen.findByText(/hace más de unos días/)).toBeTruthy();
    expect(globalThis.location.hash).toBe('');

    // The single-device app is right there, under its own address.
    await user.click(screen.getByRole('button', { name: 'Conteo de una sola tableta' }));
    expect(globalThis.location.hash).toBe('#/local');
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
  });

  it('lists several prepared links, newest first, and opens the one tapped', async () => {
    const user = userEvent.setup();
    draw([
      link('tok-lunes', ago(3 * 60 * 60 * 1000), 'Luis'),
      link('tok-hoy', ago(60 * 60 * 1000), 'Ana'),
    ]);
    expect(await screen.findByText('Esta tableta está preparada para más de un conteo. Elige el tuyo.'))
      .toBeTruthy();
    const cards = screen.getAllByRole('button', { name: /Bodega/ });
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Ana'),
      expect.stringContaining('Luis'),
    ]);

    await user.click(cards[1]);
    expect(globalThis.location.hash).toBe('#/c/tok-lunes');
  });
});

describe('coming back to the plain address', () => {
  it('shows the chooser again rather than bouncing Back into the link', async () => {
    // Opening a link on wifi refetches it, so an old link is «recent» by the
    // time somebody presses Back. Redirecting then would make Back a loop and
    // «Conteo de una sola tableta» unreachable in an app with no address bar.
    const user = userEvent.setup();
    const rows = [link('tok-viejo', ago(30 * 24 * 60 * 60 * 1000), 'Ana')];
    draw(rows);
    await user.click(await screen.findByRole('button', { name: /Bodega/ }));
    expect(globalThis.location.hash).toBe('#/c/tok-viejo');

    rows[0] = { ...rows[0], fetchedAt: new Date().toISOString() };
    globalThis.history.back();
    expect(
      await screen.findByText('Esta tableta está preparada para este conteo. Ábrelo, o empieza un conteo de una sola tableta.'),
    ).toBeTruthy();
    expect(globalThis.location.hash).toBe('');
    expect(screen.getByRole('button', { name: 'Conteo de una sola tableta' })).toBeTruthy();
  });

  it('falls back to the single-device app when the prepared links cannot be read', async () => {
    render(
      <Root
        repo={new MemoryRepository()}
        assignments={{ ...prepared([]), list: async () => Promise.reject(new Error('IndexedDB')) }}
        chain={new MemoryChain()}
        api={api}
      />,
    );
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
  });
});

describe('#/local', () => {
  it('is always the single-device app, whatever is prepared', async () => {
    go('#/local');
    draw([link('tok-hoy', ago(60 * 60 * 1000), 'Ana')]);
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
    expect(globalThis.location.hash).toBe('#/local');
  });
});
