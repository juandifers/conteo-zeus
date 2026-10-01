// @vitest-environment jsdom
/**
 * The ways a worker new to the tablet gets a wrong number in, closed one by one.
 *
 * Found by the pre-pilot failure-mode pass, each against the real screen:
 *
 *   - a double tap answers the question it raised («Sí» opens under the finger);
 *   - a double tap on a search result types a digit into the card it opened;
 *   - «0» + «Registrar 0» skipped the «¿está vacío?» question;
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

describe('every registro is independent', () => {
  it('registers a second quantity on the same article straight away, asking nothing', async () => {
    // 10 tomatoes on the shelf, later 6 in the cold room: two registros, and
    // the counter is never asked about the first while entering the second.
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '10');
    await user.click(screen.getByRole('button', { name: /^Registrar 10 / }));

    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '6');
    await user.click(screen.getByRole('button', { name: /^Registrar 6 / }));

    expect(screen.queryByText(/ya registraste/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sumar/i })).toBeNull();
    expect(await written()).toMatchObject([
      { kind: 'add', qty: 10 },
      { kind: 'add', qty: 6 },
    ]);
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
    expect(parseQty('2,5000')).toBe(2.5); // trailing zeros are not precision
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

describe('«Deshacer» when the list has just moved (found by review)', () => {
  it('ignores the tap that lands in the instant after the rows shift', async () => {
    const { user, written } = await openTablet();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '8');
    await user.click(screen.getByRole('button', { name: /^Registrar 8 / }));
    await user.click(screen.getByRole('button', { name: 'Mis registros' }));

    // The list just gained a row: a tap now is the tail of a double tap.
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(await written()).toHaveLength(1);

    read();
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(await written()).toMatchObject([{ kind: 'add', qty: 8 }, { kind: 'retract' }]);
  });
});

describe('the sync bar after an entry, with no signal (found by review)', () => {
  it('counts the entry as waiting once it is on disk, not on the next tick', async () => {
    const { user } = await openTablet();
    expect(await screen.findByText(/Todo lo que llevas está subido/)).toBeTruthy();
    await openCard(user, 'TAJADO');
    await user.type(screen.getByLabelText(/cantidad contada/), '8');
    await user.click(screen.getByRole('button', { name: /^Registrar 8 / }));
    expect(await screen.findByText(/1 registro sin subir/)).toBeTruthy();
  });
});
