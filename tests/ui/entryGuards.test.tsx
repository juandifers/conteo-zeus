// @vitest-environment jsdom
/**
 * The ways a worker new to the tablet gets a wrong number in, closed one by one.
 *
 * Found by the pre-pilot failure-mode pass, each against the real screen:
 *
 *   - a double tap answers the question it raised («Sí» opens under the finger);
 *   - a double tap on a search result types a digit into the card it opened;
 *   - «0» + «Registrar 0» skipped the «¿está vacío?» question;
 *   - a second entry on your own article silently adds (30, then «81» to fix it,
 *     is 111);
 *   - «Corregir» asked nothing, so 8 → 0 or 8 → 81 000 went straight in;
 *   - «0,0000001» and a 22-digit slip were accepted, and made the Zeus writer
 *     throw after the seal;
 *   - the unit was not on the button that gets read before the tap.
 *
 * Here the guard is ON and the clock is held still, so «immediately» means
 * immediately and «after reading it» means after `tapGuard.confirmMs`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryChain, MemoryRepository, type CounterPayload } from '../../src/domain';
import type { AssignmentStore } from '../../src/store';
import type { CounterAssignmentRow } from '../../src/store/db';
import type { Api } from '../../src/ui/api';
import { CounterScreen } from '../../src/ui/counter/CounterScreen';
import { tapGuard } from '../../src/ui/counter/tapGuard';
import { parseQty } from '../../src/ui/format';
import { samplePayload } from './counterHarness';
import { sampleSession } from './harness';

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa';
const DEFAULTS = { ...tapGuard };
let clock = 0;

beforeEach(() => {
  clock = 1_000;
  tapGuard.confirmMs = DEFAULTS.confirmMs;
  tapGuard.openMs = DEFAULTS.openMs;
  tapGuard.now = () => clock;
});
afterEach(() => {
  cleanup();
  Object.assign(tapGuard, DEFAULTS);
});

/** A person reading the question before answering it. */
const read = () => {
  clock += tapGuard.confirmMs + 1;
};

function held(payload: CounterPayload): AssignmentStore {
  const row: CounterAssignmentRow = {
    token: TOKEN,
    sessionId: payload.session.id,
    counterId: payload.counter.id,
    fetchedAt: '2026-08-31T12:00:00.000Z',
    payload,
  };
  return {
    save: async () => {},
    load: async () => row,
    list: async () => [row],
    remove: async () => {},
  };
}

async function openTablet() {
  const payload = samplePayload();
  const repo = new MemoryRepository();
  const chain = new MemoryChain();
  const append = chain.appendChainedBatch.bind(chain);
  chain.appendChainedBatch = async (links) => {
    await append(links);
    for (const link of links) await repo.appendEvent(link.event);
  };
  await repo.createSession(sampleSession());
  const offline = async () => {
    throw new Error('sin red');
  };
  const api: Api = { get: offline, post: offline, patch: offline };
  render(
    <CounterScreen
      token={TOKEN}
      api={api}
      assignments={held(payload)}
      repo={repo}
      chain={chain}
    />,
  );
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Contar' });
  const written = async () =>
    (await chain.unsynced(payload.session.id, payload.counter.id, 100)).map((link) => link.event);
  return { user, written };
}

async function openCard(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.clear(screen.getByLabelText('buscar artículo'));
  await user.type(screen.getByLabelText('buscar artículo'), query);
  await user.click(await screen.findByRole('button', { name: new RegExp(query, 'i') }));
}

describe('a double tap is not an answer', () => {
  it('ignores «Sí, es correcta» in the instant after the question appears', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '80000');
    await user.click(screen.getByRole('button', { name: /^Registrar 80.000 / }));

    // The second tap of the double tap, on the same spot, before anybody read.
    await user.click(screen.getByRole('button', { name: 'Sí, es correcta' }));
    expect(await written()).toEqual([]);

    read();
    await user.click(screen.getByRole('button', { name: 'Sí, es correcta' }));
    expect(await written()).toMatchObject([{ kind: 'add', qty: 80000 }]);
  });

  it('ignores «Sí, está vacío» in the instant after the question appears', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.click(screen.getByRole('button', { name: /Está vacío/ }));
    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    expect(await written()).toEqual([]);

    read();
    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    expect(await written()).toMatchObject([{ kind: 'add', qty: 0 }]);
  });

  it('ignores the keypad in the instant after a search result opens the card', async () => {
    const { user } = await openTablet();
    await openCard(user, 'TAJADO');
    // The second tap of a double tap on the result row lands on a key.
    await user.click(screen.getByRole('button', { name: '5' }));
    expect((screen.getByLabelText(/cantidad contada/) as HTMLInputElement).value).toBe('');

    clock += tapGuard.openMs + 1;
    await user.click(screen.getByRole('button', { name: '5' }));
    expect((screen.getByLabelText(/cantidad contada/) as HTMLInputElement).value).toBe('5');
  });
});

describe('a zero always takes the zero question', () => {
  it('asks «¿está vacío?» for a zero typed on the keypad, too', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    clock += tapGuard.openMs + 1;
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: /^Registrar 0 / }));

    expect(screen.getByText(/¿Confirmas que este lugar está vacío\?/)).toBeTruthy();
    expect(await written()).toEqual([]);
    read();
    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    expect(await written()).toMatchObject([{ kind: 'add', qty: 0 }]);
  });
});

describe('a second entry on your own article says it will add', () => {
  it('asks before adding, and «Volver» writes nothing', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '30');
    await user.click(screen.getByRole('button', { name: /^Registrar 30 / }));
    expect(await written()).toHaveLength(1);

    // Later: the paper habit — write the total again «to fix it».
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '81');
    await user.click(screen.getByRole('button', { name: /^Registrar 81 / }));
    expect(screen.getByText(/Ya registraste este artículo/)).toBeTruthy();
    expect(screen.getByText(/corrígelo en Mis registros/)).toBeTruthy();
    // No number but the one being typed: the sentence says «se suma», not a total.
    expect(document.body.textContent).not.toContain('111');

    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(await written()).toHaveLength(1);
  });

  it('adds when the counter says it is another place', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '30');
    await user.click(screen.getByRole('button', { name: /^Registrar 30 / }));
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '12');
    await user.click(screen.getByRole('button', { name: /^Registrar 12 / }));
    read();
    await user.click(screen.getByRole('button', { name: 'Sí, sumar 12' }));
    expect(await written()).toMatchObject([
      { kind: 'add', qty: 30 },
      { kind: 'add', qty: 12 },
    ]);
  });

  it('does not stack a second question on a zero', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '30');
    await user.click(screen.getByRole('button', { name: /^Registrar 30 / }));
    await openCard(user, 'TAJADO');
    await user.click(screen.getByRole('button', { name: /Está vacío/ }));
    read();
    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    expect(screen.queryByText(/Ya registraste este artículo/)).toBeNull();
    expect(await written()).toHaveLength(2);
  });
});

describe('«Corregir» asks what the entry card asks', () => {
  async function corregirA(user: ReturnType<typeof userEvent.setup>, qty: string) {
    await user.click(screen.getByRole('button', { name: 'Mis registros' }));
    await user.click(screen.getByRole('button', { name: 'Corregir' }));
    await user.type(screen.getByLabelText(/nueva cantidad/), qty);
    await user.click(screen.getByRole('button', { name: 'Guardar corrección' }));
  }

  it('asks before correcting to zero', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '8');
    await user.click(screen.getByRole('button', { name: /^Registrar 8 / }));
    await corregirA(user, '0');

    expect(screen.getByText(/¿Confirmas que este lugar está vacío\?/)).toBeTruthy();
    expect(await written()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Sí, guardar 0' }));
    expect(await written()).toHaveLength(1); // the double tap
    read();
    await user.click(screen.getByRole('button', { name: 'Sí, guardar 0' }));
    expect(await written()).toMatchObject([
      { kind: 'add', qty: 8 },
      { kind: 'retract' },
      { kind: 'add', qty: 0 },
    ]);
  });

  it('asks before correcting to an unusual quantity', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '8');
    await user.click(screen.getByRole('button', { name: /^Registrar 8 / }));
    await corregirA(user, '81000');
    expect(screen.getByText(/Es una cantidad poco común/)).toBeTruthy();
    expect(await written()).toHaveLength(1);
  });
});

describe('what the button says is what gets written', () => {
  it('carries the unit, not only the number', async () => {
    const { user } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '3');
    const unit = sampleSession().items.find((item) => /TAJADO/.test(item.nombre))!.presentacion;
    expect(screen.getByRole('button', { name: `Registrar 3 ${unit}` })).toBeTruthy();
  });

  it('refuses a quantity the Zeus file cannot carry, and the keypad refuses its key', async () => {
    // Three decimals is what every screen prints; past nine whole digits
    // `String(qty)` turns exponential and the writer throws after the seal.
    expect(parseQty('0,0000001')).toBeNull();
    expect(parseQty('2,0005')).toBeNull();
    expect(parseQty('1234567890')).toBeNull();
    expect(parseQty('2,125')).toBe(2.125);
    expect(parseQty('123456789')).toBe(123456789);

    const { user } = await openTablet();
    await openCard(user, 'TAJADO');
    clock += tapGuard.openMs + 1;
    for (const key of ['2', 'coma decimal', '1', '2', '5', '7']) {
      await user.click(screen.getByRole('button', { name: key }));
    }
    expect((screen.getByLabelText(/cantidad contada/) as HTMLInputElement).value).toBe('2,125');
  });
});
