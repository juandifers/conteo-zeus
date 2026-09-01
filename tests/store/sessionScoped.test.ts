/**
 * Session-scoped events through the real IndexedDB adapter.
 *
 * `countEvents` is indexed on `[sessionId+idarticulo]`, and IndexedDB will not
 * accept `null` as a key component: a record whose `idarticulo` is null is
 * silently *absent from that index*, though still present in the store. That
 * happens to be exactly the behaviour wanted — a `finish` is not an item's
 * event — but "happens to be" is not a guarantee, so it is asserted here rather
 * than relied on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { ConteoDb } from '../../src/store/db';
import { DexieCountRepository } from '../../src/store/repository';
import type { CountEvent, Session } from '../../src/domain';

const SESSION: Session = {
  id: 'session-p2',
  bodega: '01',
  fechaCorte: '2026/08/28',
  sourceHash: 'a'.repeat(64),
  createdAt: '2026-08-28T12:00:00.000Z',
  items: [
    {
      idarticulo: 1181,
      codigo: '0103005',
      nombre: 'PANCETA SV',
      presentacion: 'KILO',
      existencia: 97.5,
      ultimoConteo: 66.5,
      costo: 1,
    },
  ],
};

const base = {
  sessionId: SESSION.id,
  counterId: 'counter-ana',
  usuario: 'ana',
  zona: 'CAVA',
  deviceId: 'tablet-a',
};

const EVENTS: CountEvent[] = [
  { ...base, id: 'e0', idarticulo: 1181, seq: 0, at: '2026-08-28T12:01:00.000Z', kind: 'set', qty: 96 },
  { ...base, id: 'e1', idarticulo: 1181, seq: 1, at: '2026-08-28T12:02:00.000Z', kind: 'note', texto: 'caja abierta' },
  { ...base, id: 'e2', idarticulo: null, seq: 2, at: '2026-08-28T12:03:00.000Z', kind: 'note', texto: 'dos cajas sin código en el piso' },
  { ...base, id: 'e3', idarticulo: null, seq: 3, at: '2026-08-28T12:04:00.000Z', kind: 'finish', finalSeq: 1, headHash: 'b'.repeat(64) },
  { ...base, id: 'e4', idarticulo: null, seq: 4, at: '2026-08-28T12:05:00.000Z', kind: 'reopen' },
  { ...base, id: 'e5', idarticulo: 1181, seq: 5, at: '2026-08-28T12:06:00.000Z', kind: 'retract', retractsEventId: 'e0' },
];

let repo: DexieCountRepository;

beforeEach(async () => {
  repo = new DexieCountRepository(new ConteoDb(`test-${crypto.randomUUID()}`));
  await repo.createSession(SESSION);
  for (const event of EVENTS) await repo.appendEvent(event);
});

describe('the store accepts every P2 event kind', () => {
  it('returns all of them from eventsForSession, null idarticulo included', async () => {
    const stored = await repo.eventsForSession(SESSION.id);
    expect(stored.map((e) => e.id).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);

    const finish = stored.find((e) => e.kind === 'finish')!;
    expect(finish).toMatchObject({ idarticulo: null, finalSeq: 1, headHash: 'b'.repeat(64) });
    const withdrawal = stored.find((e) => e.kind === 'retract')!;
    expect(withdrawal).toMatchObject({ retractsEventId: 'e0' });
  });

  it('keeps the session-scoped ones out of eventsForItem', () => {
    // The compound index cannot hold a null component, which is why this works.
    // Asserted rather than assumed: it is the difference between a `finish`
    // being invisible to the item fold and it reaching `resolve`, which throws.
    return repo.eventsForItem(SESSION.id, 1181).then((stored) => {
      expect(stored.map((e) => e.id).sort()).toEqual(['e0', 'e1', 'e5']);
    });
  });

  it('preserves counterId, so a chain can be rebuilt from the store', async () => {
    const stored = await repo.eventsForSession(SESSION.id);
    expect(stored.every((e) => e.counterId === 'counter-ana')).toBe(true);
  });

  it('rejects a note carrying a control character, at the write path', async () => {
    const bad: CountEvent = {
      ...base,
      id: 'bad',
      idarticulo: null,
      seq: 9,
      at: '2026-08-28T12:09:00.000Z',
      kind: 'note',
      texto: `antes${String.fromCharCode(0x1e)}despues`,
    };
    await expect(repo.appendEvent(bad)).rejects.toThrow(/control character/);
  });

  it('rejects a non-finite quantity, at the write path', async () => {
    const bad = {
      ...base,
      id: 'bad2',
      idarticulo: 1181,
      seq: 10,
      at: '2026-08-28T12:10:00.000Z',
      kind: 'set',
      qty: Number.POSITIVE_INFINITY,
    } as CountEvent;
    await expect(repo.appendEvent(bad)).rejects.toThrow(/non-finite/);
  });
});
