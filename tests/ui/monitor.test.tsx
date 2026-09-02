// @vitest-environment jsdom
/**
 * The live monitor — P2.4 §1.
 *
 * Two things are worth a test here and they are the two the brief argues for.
 *
 * **A bodega with no signal must look normal.** Most of a shift is a tablet
 * nobody has heard from, and a panel that styles that as a warning is a panel
 * the admin stops reading — at which point the line that costs a morning is one
 * more grey row among twelve.
 *
 * **The cursor must overlap.** `server_seq` is a `bigserial`, the value is taken
 * at insert and the row becomes visible at commit, and those are not the same
 * order. A poll that asked strictly forwards would skip an event permanently,
 * and a skipped event is a wrong total on a screen somebody signs.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dispatched } from '../../src/ui/admin/Dispatched';
import { EventFeed } from '../../src/ui/admin/feed';
import { Monitor } from '../../src/ui/admin/Monitor';
import { monitorTier } from '../../src/ui/admin/tiers';
import type { Api } from '../../src/ui/api';
import { addCount, resetFactory } from '../domain/factory';
import { detailFor, item, reviewApi, SESSION_ID, syncFor, wire } from './reviewHarness';

afterEach(cleanup);
beforeEach(resetFactory);

const ITEMS = [item(1, 10, 100), item(2, 20, 50), item(3, 5, 1000)];

/** Three counters, one per tier. */
const COUNTERS = [
  {
    id: 'ana',
    nombre: 'Ana',
    estado: 'contando',
    // Two hours of silence. Normal: she is in the cooler.
    lastServerAt: '2026-08-25T10:14:00.000Z',
    storedMaxSeq: 43,
  },
  {
    id: 'luis',
    nombre: 'Luis',
    estado: 'terminado_incompleto',
    lastServerAt: '2026-08-25T12:05:00.000Z',
    chainComplete: false,
    storedMaxSeq: 147,
  },
  {
    id: 'pedro',
    nombre: 'Pedro',
    estado: 'contando',
    forked: true,
    lastServerAt: '2026-08-25T12:06:00.000Z',
    storedMaxSeq: 12,
  },
];

const DETAIL = detailFor({
  items: ITEMS,
  counters: COUNTERS,
  secciones: { ana: [1, 2], luis: [3] },
});

describe('the three states are visually separate (§1)', () => {
  it('leaves a tablet with no signal neutral, and marks the other two', async () => {
    const { api } = reviewApi({
      counters: COUNTERS,
      events: [addCount(1, 5, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 })],
    });
    render(<Monitor detail={DETAIL} api={api} pollMs={1_000_000} />);
    await screen.findByText(/Ana · contando/);

    const rows = document.querySelectorAll('.rows > .row');
    const [ana, luis, pedro] = [...rows].map((row) => row as HTMLElement);

    // Normal: a chip with no weight on it, and no instruction to act.
    const anaChip = within(ana).getByText('sin señal');
    expect(anaChip.className).toBe('chip');

    // Needs action: the chip is heavier, and it says what to do before people
    // go home.
    expect(within(luis).getByText('terminó y faltan registros suyos').className).toBe(
      'chip chip--action',
    );
    expect(within(luis).getByText(/acerque a la señal antes de irse/)).toBeTruthy();

    // Stopped: heavier still, and nothing about it resolves itself.
    expect(within(pedro).getByText('dos tabletas en un enlace').className).toBe(
      'chip chip--stopped',
    );
    expect(within(pedro).getByText(/No se arregla\s+solo/)).toBeTruthy();
  });

  it('does not reach for colour, which in this product means variance', async () => {
    const { api } = reviewApi({ counters: COUNTERS, events: [] });
    render(<Monitor detail={DETAIL} api={api} pollMs={1_000_000} />);
    await screen.findByText(/Ana · contando/);
    const monitor = document.getElementById('monitor')!;
    // `grid--short` / `grid--over` are the only classes that carry a colour, and
    // a counter's state is not a direction.
    expect(monitor.querySelectorAll('.grid--short, .grid--over')).toHaveLength(0);
  });

  it('shows each counter’s progress, devices and clock, from the log', async () => {
    const { api } = reviewApi({
      counters: COUNTERS,
      events: [
        addCount(1, 5, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 }),
        addCount(1, 2, { counterId: 'ana', sessionId: SESSION_ID, seq: 2 }),
        addCount(2, 0, { counterId: 'ana', sessionId: SESSION_ID, seq: 3 }),
      ],
    });
    render(<Monitor detail={DETAIL} api={api} pollMs={1_000_000} />);
    const ana = (await screen.findByText(/Ana · contando/)).closest('.row') as HTMLElement;
    // Two of her two articles registered, three entries, one of them a zero.
    expect(within(ana).getByText(/2 de 2 artículos · faltan 0 · 3 registros · 1 en cero/)).toBeTruthy();
    expect(within(ana).getByText(/43 en el servidor · 1 tableta ·/)).toBeTruthy();
  });

  it('answers «¿vamos bien?» first, in the largest figures on the page (§4.1)', async () => {
    const { api } = reviewApi({
      counters: COUNTERS,
      events: [addCount(1, 5, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 })],
    });
    render(<Monitor detail={DETAIL} api={api} pollMs={1_000_000} />);
    await screen.findByText(/Ana · contando/);

    // One of three articles registered; the two untouched rows are worth
    // 20×50 + 5×1000 = 6.000 COP, which is the number that decides whether
    // anybody stays late — so it is on the context line, not behind a tab.
    const verdict = document.querySelector('.verdict') as HTMLElement;
    expect(within(verdict).getByText('1')).toBeTruthy();
    expect(within(verdict).getByText(/de 3 artículos/)).toBeTruthy();
    expect(within(verdict).getByText('33 %')).toBeTruthy();
    expect(within(verdict).getByText(/2 sin contar · 6\.000 COP sin verificar/)).toBeTruthy();
  });

  it('keeps the seal blockers standing in the rail, without navigating (§3.2)', async () => {
    // The rail is the persistent answer to «¿ya puedo sellar?» — one line per
    // blocker, beside the monitoring work rather than behind the Sello tab.
    const { api } = reviewApi({
      counters: COUNTERS,
      events: [],
      readyToSeal: [{ kind: 'contador-bifurcado', counterId: 'pedro', nombre: 'Pedro' }],
    });
    render(<Dispatched detail={DETAIL} api={api} onReload={() => {}} />);
    expect(
      await screen.findByText(/Dos tabletas escribieron con el enlace de Pedro/),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Ver →' }).length).toBeGreaterThan(0);
  });
});

describe('monitorTier, without a browser', () => {
  const base = syncFor(COUNTERS).counters;
  const now = '2026-08-25T12:10:00.000Z';

  it('is normal for somebody who has been quiet all morning', () => {
    expect(monitorTier(base[0], now)).toMatchObject({ tier: 'normal', titulo: 'sin señal' });
  });

  it('says nothing at all about somebody who pushed a minute ago', () => {
    expect(
      monitorTier({ ...base[0], lastServerAt: '2026-08-25T12:09:00.000Z' }, now),
    ).toMatchObject({ tier: 'normal', titulo: '' });
  });

  it('asks for action when a tablet never downloaded its assignment', () => {
    expect(
      monitorTier({ ...base[0], estado: 'asignado', pendingFetch: true }, now).tier,
    ).toBe('accion');
  });

  it('asks for action for a retirement the server holds a hole for', () => {
    expect(
      monitorTier({ ...base[0], estado: 'retirado', chainComplete: false }, now).tier,
    ).toBe('accion');
  });

  it('puts a fork above everything else, because nothing else matters until it is resolved', () => {
    expect(
      monitorTier({ ...base[1], forked: true }, now).tier,
    ).toBe('detenido');
  });
});

describe('the cursor overlaps and the merge is by id (§1, P2.2 §4a)', () => {
  /**
   * The trap, staged: a page whose highest `server_seq` is 10, and then a row
   * at `server_seq` 7 that was in flight while 10 committed.
   *
   * A client polling `where server_seq > 10` never sees it. This one hands the
   * cursor back and the endpoint re-reads from `cursor - 400`, so the row comes
   * with the next pull — and everything it already holds arrives again, which is
   * the mechanism working rather than waste.
   */
  it('delivers an event that committed after a higher one', async () => {
    const early = addCount(1, 4, { counterId: 'ana', sessionId: SESSION_ID, seq: 1, id: 'late-7' });
    const later = addCount(2, 9, { counterId: 'luis', sessionId: SESSION_ID, seq: 1, id: 'seq-10' });

    let call = 0;
    const api: Api = {
      get: vi.fn(async (path: string) => {
        call++;
        expect(path).toContain('since=');
        // First pull: only the row that committed first is visible.
        if (call === 1) return { events: [wire(later, 10)], nextCursor: '10' } as never;
        // Second pull, from the same cursor: the endpoint's overlap re-reads
        // the window and the straggler is there, beside the row we already have.
        return { events: [wire(early, 7), wire(later, 10)], nextCursor: '10' } as never;
      }),
      post: vi.fn(),
      patch: vi.fn(),
    };

    const feed = new EventFeed();
    expect(await feed.pull(api, SESSION_ID)).toBe(1);
    expect(feed.cursor).toBe('10');

    // The second pull brings one new event and re-delivers one we had. Merging
    // by id makes the redelivery free.
    expect(await feed.pull(api, SESSION_ID)).toBe(1);
    expect(feed.size).toBe(2);
    expect(feed.events.map((event) => event.id).sort()).toEqual(['late-7', 'seq-10']);
  });

  it('asks for events only when /sync says something moved', async () => {
    const events = [addCount(1, 5, { counterId: 'ana', sessionId: SESSION_ID, seq: 1 })];
    let sync = 0;
    let pulls = 0;
    const api: Api = {
      get: vi.fn(async (path: string) => {
        if (path.includes('/sync')) {
          sync++;
          return syncFor(COUNTERS) as never;
        }
        pulls++;
        return {
          events: events.map((event, index) => wire(event, index + 1)),
          nextCursor: '1',
        } as never;
      }),
      post: vi.fn(),
      patch: vi.fn(),
    };

    render(<Monitor detail={DETAIL} api={api} pollMs={5} />);
    await screen.findByText(/Ana · contando/);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Several polls of the cheap endpoint…
    expect(sync).toBeGreaterThan(2);
    // …and exactly one pull of the log, because nothing moved after the first.
    expect(pulls).toBe(1);
  });
});
