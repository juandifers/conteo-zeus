/**
 * The persistence port, run against both implementations.
 *
 * The domain defines `CountRepository` and the store implements it over
 * IndexedDB. Running one contract against both is what stops the port from
 * quietly becoming "whatever Dexie happens to do" — and it is why the domain
 * tests can run with no database at all.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventConflictError,
  MemoryRepository,
  SequenceConflictError,
  type CountRepository,
  type DeviceRepository,
  type ExportRecord,
  type ExportRepository,
  type Item,
  type Session,
} from '../../src/domain';
import { ConteoDb, DexieCountRepository } from '../../src/store';
import { SESSION_ID, markUnchanged, resetFactory, retract, setCount } from '../domain/factory';

function item(idarticulo: number, nombre: string, existencia: number): Item {
  return {
    idarticulo,
    codigo: '0103005',
    nombre,
    presentacion: 'KILO',
    existencia,
    ultimoConteo: 20.8,
    costo: 3990.62686567164,
  };
}

/** Deliberately not in idarticulo order — file order is data, and must survive. */
const ITEMS = [item(2660, 'PANCETA SV', 60), item(330, 'PANCETA SV', 30), item(1181, 'PANCETA SV', 97.5)];

const SESSION: Session = {
  id: SESSION_ID,
  bodega: '01',
  fechaCorte: '2025/04/30',
  sourceHash: 'abc123',
  createdAt: '2026-08-25T09:00:00.000Z',
  items: ITEMS,
};

let dbCounter = 0;
let openDb: ConteoDb | null = null;

type Repo = CountRepository & DeviceRepository & ExportRepository;

const implementations: Array<[string, () => Repo]> = [
  ['MemoryRepository', () => new MemoryRepository()],
  [
    'DexieCountRepository',
    () => {
      openDb = new ConteoDb(`conteo-test-${dbCounter++}`);
      return new DexieCountRepository(openDb);
    },
  ],
];

describe.each(implementations)('CountRepository contract: %s', (_name, create) => {
  let repo: Repo;

  beforeEach(() => {
    resetFactory();
    repo = create();
  });

  afterEach(async () => {
    if (openDb) {
      await openDb.delete();
      openDb = null;
    }
  });

  it('round-trips a session with its items in file order', async () => {
    await repo.createSession(SESSION);
    const loaded = await repo.getSession(SESSION.id);

    expect(loaded).toBeDefined();
    expect(loaded!.bodega).toBe('01');
    expect(loaded!.fechaCorte).toBe('2025/04/30');
    expect(loaded!.sourceHash).toBe('abc123');
    // Not sorted by idarticulo: the count sheet follows the file, not the key.
    expect(loaded!.items.map((i) => i.idarticulo)).toEqual([2660, 330, 1181]);
    expect(loaded!.items[2].existencia).toBe(97.5);
    // The prior survives; DOMAIN.md §5's exposure figure is computed from it.
    expect(loaded!.items[2].ultimoConteo).toBe(20.8);
  });

  it('returns undefined for a session that does not exist', async () => {
    expect(await repo.getSession('nope')).toBeUndefined();
  });

  it('refuses to overwrite a session — a re-import is a new session', async () => {
    await repo.createSession(SESSION);
    await expect(repo.createSession(SESSION)).rejects.toThrow(/already exists/);
  });

  describe('the file the session was imported from', () => {
    const BYTES = new Uint8Array([0x0d, 0x0a, 0xa5, 0x00, 0xff, 0x41]);

    it('comes back byte for byte, including the bytes that are not text', async () => {
      // 0xA5 is `Ñ` in CP850 and 0x00 is not text at all. Anything that put
      // this through a string on the way in or out would come back mangled,
      // and the file it produces would reach Zeus mangled with it.
      await repo.createSession({
        ...SESSION,
        source: { name: 'COMESTIBLES ALMACEN.txt', bytes: BYTES },
      });
      const loaded = await repo.getSession(SESSION.id);
      expect(loaded!.source!.name).toBe('COMESTIBLES ALMACEN.txt');
      expect(Array.from(loaded!.source!.bytes)).toEqual(Array.from(BYTES));
    });

    it('is absent, not empty, on a session that never carried one', async () => {
      await repo.createSession(SESSION);
      expect((await repo.getSession(SESSION.id))!.source).toBeUndefined();
    });

    it('stays out of the session list, which only needs the name', async () => {
      await repo.createSession({
        ...SESSION,
        source: { name: 'COMESTIBLES ALMACEN.txt', bytes: BYTES },
      });
      const [meta] = await repo.listSessions();
      expect(meta.sourceName).toBe('COMESTIBLES ALMACEN.txt');
      expect(meta).not.toHaveProperty('source');
    });
  });

  it('lists sessions with their item count', async () => {
    await repo.createSession(SESSION);
    const listed = await repo.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(SESSION.id);
    expect(listed[0].itemCount).toBe(3);
  });

  it('appends events and reads them back per item', async () => {
    await repo.createSession(SESSION);
    await repo.appendEvent(setCount(1181, 90));
    await repo.appendEvent(setCount(1181, 97.5));
    await repo.appendEvent(markUnchanged(330));

    const forItem = await repo.eventsForItem(SESSION.id, 1181);
    expect(forItem).toHaveLength(2);
    expect(forItem.every((e) => e.idarticulo === 1181)).toBe(true);

    // The correction is an append, not an overwrite: both survive.
    expect(await repo.eventsForSession(SESSION.id)).toHaveLength(3);
    expect(await repo.eventsForItem(SESSION.id, 2660)).toEqual([]);
  });

  it('is idempotent on re-delivery of the same event, which merge depends on', async () => {
    await repo.createSession(SESSION);
    const event = setCount(1181, 90);
    await repo.appendEvent(event);
    await repo.appendEvent({ ...event });
    expect(await repo.eventsForSession(SESSION.id)).toHaveLength(1);
  });

  it('rejects an id re-used for different content — that would be an edit', async () => {
    await repo.createSession(SESSION);
    const event = setCount(1181, 90);
    await repo.appendEvent(event);
    await expect(repo.appendEvent({ ...event, qty: 91 })).rejects.toThrow(EventConflictError);
    const stored = await repo.eventsForItem(SESSION.id, 1181);
    expect(stored).toHaveLength(1);
    expect(stored[0].kind === 'set' && stored[0].qty).toBe(90);
  });

  it('exposes no way to update or delete an event', () => {
    // DOMAIN.md §3: the log is the audit trail. If this ever gains a method,
    // the waiver attribution stops being evidence.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(surface.filter((name) => /update|delete|remove|clear/i.test(name))).toEqual([]);
  });

  describe('the at contract (§3)', () => {
    /**
     * The fold orders events by comparing `at` as a string, so a stamp in any
     * other shape sorts wrongly on some device and there is nothing downstream
     * to catch it. This is the last point at which it can be stopped, and both
     * implementations have to stop it — a rule one adapter enforces and the
     * other does not holds only until persistence changes.
     */
    const REJECTED: Array<[string, string]> = [
      ['no milliseconds', '2026-08-25T10:00:00Z'],
      ['an offset instead of Z', '2026-08-25T12:00:00.000+02:00'],
      ['local time, no zone', '2026-08-25T10:00:00.000'],
      ['a space separator', '2026-08-25 10:00:00.000Z'],
      ['microseconds', '2026-08-25T10:00:00.000000Z'],
      ['a date only', '2026-08-25'],
      ['not a date at all', 'ayer por la tarde'],
      ['a month and day that roll over', '2026-13-45T00:00:00.000Z'],
    ];

    for (const [label, at] of REJECTED) {
      it(`rejects ${label}`, async () => {
        await repo.createSession(SESSION);
        await expect(repo.appendEvent(setCount(1181, 1, { at }))).rejects.toThrow(
          /normalised UTC instant/,
        );
        expect(await repo.eventsForSession(SESSION.id)).toEqual([]);
      });
    }

    it('accepts exactly what Date#toISOString emits', async () => {
      await repo.createSession(SESSION);
      const at = new Date(Date.UTC(2026, 7, 25, 14, 3, 11, 412)).toISOString();
      expect(at).toBe('2026-08-25T14:03:11.412Z');
      await repo.appendEvent(setCount(1181, 1, { at }));
      expect(await repo.eventsForSession(SESSION.id)).toHaveLength(1);
    });

    it('rejects a bad stamp on a waiver too, not only on a count', async () => {
      await repo.createSession(SESSION);
      await expect(
        repo.appendEvent(markUnchanged(330, { at: '2026-08-25T10:00:00Z' })),
      ).rejects.toThrow(/normalised UTC instant/);
    });
  });

  it('keeps two sessions’ logs apart', async () => {
    await repo.createSession(SESSION);
    await repo.createSession({ ...SESSION, id: 'session-2' });
    await repo.appendEvent(setCount(1181, 1));
    await repo.appendEvent(setCount(1181, 2, { sessionId: 'session-2' }));

    expect(await repo.eventsForSession(SESSION.id)).toHaveLength(1);
    expect(await repo.eventsForItem('session-2', 1181)).toHaveLength(1);
  });

  it('preserves the unchanged event’s motivo — it lives nowhere else (§4)', async () => {
    await repo.createSession(SESSION);
    await repo.appendEvent(markUnchanged(330, { motivo: 'nevera sellada', usuario: 'luz' }));
    const [stored] = await repo.eventsForItem(SESSION.id, 330);
    expect(stored.kind).toBe('unchanged');
    expect(stored.kind === 'unchanged' && stored.motivo).toBe('nevera sellada');
    expect(stored.usuario).toBe('luz');
    expect('qty' in stored).toBe(false);
  });

  describe('one device, one sequence number (§3)', () => {
    it('rejects a second event at a slot this device already used', async () => {
      await repo.createSession(SESSION);
      const first = setCount(1181, 5, { id: 'ev-a', deviceId: 'tablet-1', seq: 4 });
      await repo.appendEvent(first);

      const stray = markUnchanged(1181, { id: 'ev-b', deviceId: 'tablet-1', seq: 4 });
      await expect(repo.appendEvent(stray)).rejects.toBeInstanceOf(SequenceConflictError);

      // The log is untouched — a rejected append is not a partial one.
      const stored = await repo.eventsForItem(SESSION.id, 1181);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('ev-a');
    });

    it('carries both ids, so the stray write is identifiable', async () => {
      await repo.createSession(SESSION);
      await repo.appendEvent(setCount(1181, 5, { id: 'ev-a', deviceId: 'tablet-1', seq: 4 }));

      const error = await repo
        .appendEvent(setCount(1181, 9, { id: 'ev-b', deviceId: 'tablet-1', seq: 4 }))
        .then(
          () => null,
          (cause: unknown) => cause as SequenceConflictError,
        );

      expect(error).toBeInstanceOf(SequenceConflictError);
      expect(error!.existingId).toBe('ev-a');
      expect(error!.incomingId).toBe('ev-b');
      expect(error!.deviceId).toBe('tablet-1');
      expect(error!.seq).toBe(4);
    });

    it('still lets a byte-identical re-append through, as a no-op', async () => {
      // The merge path re-delivers events it already has. That is idempotence,
      // not a collision, and the id check has to answer first.
      await repo.createSession(SESSION);
      const event = setCount(1181, 5, { id: 'ev-a', deviceId: 'tablet-1', seq: 4 });
      await repo.appendEvent(event);
      await expect(repo.appendEvent({ ...event })).resolves.toBeUndefined();
      expect(await repo.eventsForItem(SESSION.id, 1181)).toHaveLength(1);
    });

    it('leaves other devices alone — seq is monotonic per device, not global', async () => {
      await repo.createSession(SESSION);
      await repo.appendEvent(setCount(1181, 5, { id: 'ev-a', deviceId: 'tablet-1', seq: 4 }));
      await repo.appendEvent(setCount(1181, 6, { id: 'ev-b', deviceId: 'tablet-2', seq: 4 }));
      expect(await repo.eventsForItem(SESSION.id, 1181)).toHaveLength(2);
    });

    it('scopes the slot to the session', async () => {
      await repo.createSession(SESSION);
      await repo.createSession({ ...SESSION, id: 'session-2' });
      await repo.appendEvent(setCount(1181, 5, { id: 'ev-a', deviceId: 'tablet-1', seq: 4 }));
      await repo.appendEvent(
        setCount(1181, 6, { id: 'ev-b', sessionId: 'session-2', deviceId: 'tablet-1', seq: 4 }),
      );
      expect(await repo.eventsForItem('session-2', 1181)).toHaveLength(1);
    });
  });

  it('stores a retraction as an event like any other (§3)', async () => {
    await repo.createSession(SESSION);
    await repo.appendEvent(setCount(330, 12));
    await repo.appendEvent(retract(330, { usuario: 'luz' }));

    // Two rows, not zero: withdrawing a count adds to the log, and the log is
    // the only record of who withdrew it and when.
    const stored = await repo.eventsForItem(SESSION.id, 330);
    expect(stored).toHaveLength(2);
    const withdrawal = stored.find((event) => event.kind === 'retract')!;
    expect(withdrawal.usuario).toBe('luz');
    expect('qty' in withdrawal).toBe(false);
    expect('motivo' in withdrawal).toBe(false);
  });
});

describe.each(implementations)('device identity contract (§6): %s', (_name, create) => {
  let repo: Repo;

  beforeEach(() => {
    resetFactory();
    repo = create();
  });

  it('answers with the same id every time it is asked', async () => {
    const first = await repo.identify();
    const second = await repo.identify();
    expect(first.deviceId).toBe(second.deviceId);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('starts the sequence at zero', async () => {
    expect((await repo.identify()).nextSeq).toBe(0);
  });

  it('advances the watermark in the same breath as the event', async () => {
    const device = await repo.identify();
    await repo.createSession(SESSION);
    await repo.appendEvent(setCount(1181, 5, { deviceId: device.deviceId, seq: 7 }));

    // 8, not 1: the watermark is "the first seq not used", so a device that
    // resumes from it can never reissue a number the log already holds.
    expect((await repo.identify()).nextSeq).toBe(8);
  });

  it('never moves the watermark backwards', async () => {
    const device = await repo.identify();
    await repo.createSession(SESSION);
    await repo.appendEvent(setCount(1181, 5, { deviceId: device.deviceId, seq: 9 }));
    await repo.appendEvent(setCount(1181, 6, { deviceId: device.deviceId, seq: 2 }));
    expect((await repo.identify()).nextSeq).toBe(10);
  });

  it('ignores another tablet\'s sequence numbers entirely', async () => {
    await repo.identify();
    await repo.createSession(SESSION);
    await repo.appendEvent(setCount(1181, 5, { deviceId: 'some-other-tablet', seq: 400 }));
    // `seq` is monotonic *per device* (§3); borrowing another tablet's count
    // would waste 400 numbers and mean nothing.
    expect((await repo.identify()).nextSeq).toBe(0);
  });
});

describe.each(implementations)('export record contract (§4): %s', (_name, create) => {
  let repo: Repo;

  beforeEach(async () => {
    resetFactory();
    repo = create();
    await repo.createSession(SESSION);
  });

  afterEach(async () => {
    if (openDb) {
      await openDb.delete();
      openDb = null;
    }
  });

  function record(over: Partial<ExportRecord> = {}): ExportRecord {
    return {
      id: 'export-1',
      sessionId: SESSION_ID,
      at: '2026-08-26T14:02:00.000Z',
      usuario: 'marta',
      filename: 'COMESTIBLES ALMACEN.txt',
      sha256: 'a'.repeat(64),
      byteLength: 61_234,
      counts: { counted: 250, unchanged: 48, untouched: 0 },
      coberturaValor: 0.8734,
      coberturaFilas: 0.8389,
      netVarianceValue: -3_482_109,
      grossVarianceValue: 9_771_043,
      eventCount: 412,
      ...over,
    };
  }

  it('round-trips everything a later reader needs to identify the file', async () => {
    await repo.recordExport(record());
    const [stored] = await repo.exportsForSession(SESSION_ID);
    expect(stored).toEqual(record());
  });

  it('keeps every export, because a session is exported more than once', async () => {
    await repo.recordExport(record({ id: 'export-1', sha256: 'a'.repeat(64) }));
    await repo.recordExport(
      record({ id: 'export-2', at: '2026-08-26T16:40:00.000Z', sha256: 'b'.repeat(64) }),
    );
    const rows = await repo.exportsForSession(SESSION_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sha256).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('does not let a record be rewritten — the file it describes already left', async () => {
    await repo.recordExport(record());
    await expect(repo.recordExport(record({ usuario: 'otra' }))).rejects.toThrow();
    const [stored] = await repo.exportsForSession(SESSION_ID);
    expect(stored.usuario).toBe('marta');
  });

  it('keeps two sessions’ exports apart', async () => {
    await repo.createSession({ ...SESSION, id: 'session-2' });
    await repo.recordExport(record());
    await repo.recordExport(record({ id: 'export-2', sessionId: 'session-2' }));
    expect(await repo.exportsForSession(SESSION_ID)).toHaveLength(1);
    expect(await repo.exportsForSession('session-2')).toHaveLength(1);
  });

  it('answers with nothing for a session that has generated no file', async () => {
    expect(await repo.exportsForSession(SESSION_ID)).toEqual([]);
  });

  it('hands back a copy: the counts on a stored record are not live', async () => {
    await repo.recordExport(record());
    const [first] = await repo.exportsForSession(SESSION_ID);
    first.counts.counted = 0;
    const [second] = await repo.exportsForSession(SESSION_ID);
    expect(second.counts.counted).toBe(250);
  });
});

describe('DexieCountRepository — device identity survives a reload', () => {
  it('reads back the same id and watermark from a fresh connection', async () => {
    const name = `conteo-reload-${dbCounter++}`;
    const first = new DexieCountRepository(new ConteoDb(name));
    const device = await first.identify();
    await first.createSession(SESSION);
    await first.appendEvent(setCount(1181, 5, { deviceId: device.deviceId, seq: 0 }));
    first.db.close();

    // A new tab, a new Dexie connection, nothing in memory.
    const second = new DexieCountRepository(new ConteoDb(name));
    const reloaded = await second.identify();
    expect(reloaded.deviceId).toBe(device.deviceId);
    expect(reloaded.nextSeq).toBe(1);
    second.db.close();
  });
});

describe('DexieCountRepository — indexes', () => {
  it('reads one item’s events through the compound index, not the whole log', async () => {
    const db = new ConteoDb(`conteo-index-${dbCounter++}`);
    const repo = new DexieCountRepository(db);
    await repo.createSession(SESSION);
    for (let i = 0; i < 50; i++) await repo.appendEvent(setCount(1181, i));
    await repo.appendEvent(setCount(330, 1));

    const schema = db.countEvents.schema.indexes.map((index) => index.name);
    expect(schema).toContain('[sessionId+idarticulo]');
    expect(await repo.eventsForItem(SESSION.id, 330)).toHaveLength(1);
    await db.delete();
  });
});
