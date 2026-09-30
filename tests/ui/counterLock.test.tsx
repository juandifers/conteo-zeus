// @vitest-environment jsdom
/**
 * One writer per counter on a device (src/ui/counter/counterLock.ts).
 *
 * Measured before this existed: the same link open in two tabs of one tablet
 * (or the installed app plus a Chrome tab — one database) lost an entry, broke
 * the local chain, and stranded everything after it, with the admin seeing
 * only «sin señal». The second screen now does not boot the store at all.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryChain, MemoryRepository, type CounterPayload } from '../../src/domain';
import type { AssignmentStore } from '../../src/store';
import type { CounterAssignmentRow } from '../../src/store/db';
import type { Api } from '../../src/ui/api';
import { CounterScreen } from '../../src/ui/counter/CounterScreen';
import type { LockManagerLike } from '../../src/ui/counter/counterLock';
import type { StorageReport } from '../../src/ui/storage';
import { samplePayload } from './counterHarness';
import { sampleSession } from './harness';

afterEach(cleanup);

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa';

/** `navigator.locks`, reduced to what the screen uses: exclusive, ifAvailable. */
function fakeLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

function held(payload: CounterPayload): AssignmentStore {
  const row: CounterAssignmentRow = {
    token: TOKEN,
    sessionId: payload.session.id,
    counterId: payload.counter.id,
    fetchedAt: '2026-08-31T12:00:00.000Z',
    payload,
  };
  return { save: async () => {}, load: async () => row, list: async () => [row], remove: async () => {} };
}

const offline = async () => {
  throw new Error('sin red');
};
const api: Api = { get: offline, post: offline, patch: offline };

async function device() {
  const repo = new MemoryRepository();
  await repo.createSession(sampleSession());
  return { repo, chain: new MemoryChain() };
}

function screenFor(
  shared: Awaited<ReturnType<typeof device>>,
  locks: LockManagerLike,
  persistence: () => Promise<StorageReport> = async () => ({ persistence: 'granted', usage: null, quota: null }),
) {
  return (
    <CounterScreen
      token={TOKEN}
      api={api}
      assignments={held(samplePayload())}
      repo={shared.repo}
      chain={shared.chain}
      locks={locks}
      persistence={persistence}
    />
  );
}

describe('the same counter open twice on one tablet', () => {
  it('lets the first screen count and stops the second before it can write', async () => {
    const shared = await device();
    const locks = fakeLocks();
    const first = render(screenFor(shared, locks));
    await within(first.container).findByRole('button', { name: 'Contar' });

    const second = render(screenFor(shared, locks));
    expect(
      await within(second.container).findByText('Este conteo ya está abierto en esta tableta'),
    ).toBeTruthy();
    expect(within(second.container).queryByLabelText('buscar artículo')).toBeNull();
  });

  it('opens the second once the first is gone and somebody taps «Reintentar»', async () => {
    const shared = await device();
    const locks = fakeLocks();
    const first = render(screenFor(shared, locks));
    await within(first.container).findByRole('button', { name: 'Contar' });
    const second = render(screenFor(shared, locks));
    await within(second.container).findByText('Este conteo ya está abierto en esta tableta');

    first.unmount();
    await userEvent.setup().click(within(second.container).getByRole('button', { name: 'Reintentar' }));
    expect(await within(second.container).findByRole('button', { name: 'Contar' })).toBeTruthy();
  });

  it('counts normally where the browser has no Web Locks', async () => {
    const shared = await device();
    render(screenFor(shared, undefined as unknown as LockManagerLike));
    expect(await screen.findByRole('button', { name: 'Contar' })).toBeTruthy();
  });
});

describe('whether the browser will keep this tablet’s data', () => {
  it('asks, and says on Terminar when there is no guarantee', async () => {
    const shared = await device();
    let asked = 0;
    render(
      screenFor(shared, fakeLocks(), async () => {
        asked++;
        return { persistence: 'denied', usage: null, quota: null };
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Terminar' }));
    expect(asked).toBe(1);
    expect(await screen.findByText(/Almacenamiento de la tableta: sin garantía/)).toBeTruthy();
  });

  it('says so plainly when it is protected', async () => {
    const shared = await device();
    render(screenFor(shared, fakeLocks()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Terminar' }));
    expect(await screen.findByText('Almacenamiento de la tableta: protegido.')).toBeTruthy();
  });
});
