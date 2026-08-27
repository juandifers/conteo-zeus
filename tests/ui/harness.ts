/**
 * Shared setup for the counting-surface tests.
 *
 * Everything runs against the real 298-row bodega, not a fixture: the ranking
 * rules are only interesting where three letters return a dozen rows, and no
 * hand-built fixture reproduces `EMPANADA DE MAIZ CARNE`.
 */
import { importZeusFile, sourceHashOf, toItems } from '../../src/app';
import { localOutbox } from '../../src/ui/outbox';
import { MemoryRepository, type CountRepository, type Session } from '../../src/domain';
import { parseTxt, parseXls } from '../../src/zeus';
import { SAMPLE_TXT, SAMPLE_XLS, readSample } from '../helpers';

const XLS_BYTES = readSample(SAMPLE_XLS);
const TXT_BYTES = readSample(SAMPLE_TXT);
const SOURCE = parseXls(XLS_BYTES);
const TXT_SOURCE = parseTxt(TXT_BYTES);

export const SESSION_ID = 'session-ui';
export const SOURCE_NAME = 'COMESTIBLES ALMACEN.xls';

/**
 * The bodega as imported, carrying the file it came from.
 *
 * The source travels with the session because posting needs it back: the hash
 * can only be re-checked against bytes, and the writer re-emits 22 columns
 * from the source row. A session built without one is a session that cannot
 * generate an adjustment, which is a state the review screen has to handle and
 * therefore a state worth constructing on purpose — see `sourcelessSession`.
 */
export function sampleSession(): Session {
  return importZeusFile(SOURCE, {
    id: SESSION_ID,
    createdAt: '2026-08-25T09:00:00.000Z',
    source: { name: SOURCE_NAME, bytes: XLS_BYTES },
  });
}

/**
 * The same session carrying the *other* sample as its source.
 *
 * A different export of the same bodega (ZEUS_FORMAT.md §5), so it parses
 * cleanly and hashes to something else entirely: the shape of "the snapshot
 * under this count moved", without needing a corrupt file to produce it.
 */
export function mismatchedSession(): Session {
  return {
    ...sampleSession(),
    source: { name: 'COMESTIBLES ALMACEN.txt', bytes: TXT_BYTES },
  };
}

/**
 * The other sample — a different export of the same bodega (ZEUS_FORMAT.md §5).
 *
 * Its `nombre`, `presentacion` and `existencia` columns were sorted away from
 * its keys, so 43 `codigo`s carry more than one `nombre` and 297 of 298 rows
 * describe one article while being keyed to another (§4.1).
 *
 * **Built by hand, because `importZeusFile` refuses it now** — which is the
 * point of the fixture. Sessions in this state exist only because they were
 * imported before the check did, they are sitting in somebody's IndexedDB, and
 * the screens still have to say so and refuse to post them.
 */
export function txtSession(): Session {
  return {
    id: SESSION_ID,
    bodega: TXT_SOURCE.bodega!,
    fechaCorte: TXT_SOURCE.fecha!,
    sourceHash: sourceHashOf(TXT_SOURCE),
    createdAt: '2026-08-25T09:00:00.000Z',
    source: { name: 'COMESTIBLES ALMACEN.txt', bytes: TXT_BYTES },
    items: Object.freeze(toItems(TXT_SOURCE)),
  };
}

export async function seededRepository(): Promise<CountRepository> {
  const repo = new MemoryRepository();
  await repo.createSession(sampleSession());
  return repo;
}

/** 2026-08-25T10:00:00.000Z, advancing one second per event. */
const EPOCH = Date.UTC(2026, 7, 25, 10, 0, 0);

/**
 * A `Storage` that lives in a Map.
 *
 * The outbox is exercised for real in every test rather than stubbed: the
 * durability guarantee is the point of it, and a stub would assert that a stub
 * works. This also lets the node-environment tests run it without jsdom.
 */
export function memoryStorage(): Storage {
  const cells = new Map<string, string>();
  return {
    get length() {
      return cells.size;
    },
    clear: () => cells.clear(),
    getItem: (key: string) => cells.get(key) ?? null,
    key: (index: number) => [...cells.keys()][index] ?? null,
    removeItem: (key: string) => {
      cells.delete(key);
    },
    setItem: (key: string, value: string) => {
      cells.set(key, String(value));
    },
  } as Storage;
}

/** A `Storage` that refuses everything — private mode, or a blocked origin. */
export function deadStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: () => null,
    key: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  } as unknown as Storage;
}

/** A clock and an id generator that make an event log readable in a diff. */
export function fakeIdentity(storage: Storage = memoryStorage()) {
  let tick = 0;
  let id = 0;
  return {
    usuario: 'ana',
    deviceId: 'tablet-1',
    zona: 'ALMACEN',
    nextSeq: 0,
    outbox: localOutbox(storage),
    clock: () => new Date(EPOCH + tick++ * 1000).toISOString(),
    newId: () => `ev-${id++}`,
  };
}

/** Items worth naming, from the real file. */
export const ID = {
  /** PANCETA SV — three presentations under codigo 0103005 (ZEUS_FORMAT.md §4). */
  pancetaKilo: 1181,
  pancetaPorcion300: 330,
  pancetaPorcion350: 2660,
  /** PESCADO TILAPIA ROJA — four presentations under 0106001. */
  tilapia600: 1595,
  tilapia200: 2104,
  /** MELON / KILO — booked at zero, last counted at 234,8 (DOMAIN.md §5). */
  melon: 77,
  /** PAN TAJADO / NATIPAN X 500 GRS. */
  panTajado: 2165,
  /** ÑAME / KILO. */
  name: 67,
  /** AJÍ CHIPOTLE AMAZON / 167 ML. */
  ajiChipotle: 1926,
  /** EMPANADA DE MAIZ CARNE — contains "pan", mid-word. */
  empanada: 1195,
} as const;
