/**
 * A session on the admin's desk, for the P2.4 screens.
 *
 * The monitor and the review both read three things — the session detail, the
 * cheap `/sync` poll and pages of `/events` — so the fake api here answers all
 * three and keeps the action chain in a variable, which is what makes «waive a
 * row and watch the two figures move differently» a test rather than a
 * screenshot.
 */
import { vi } from 'vitest';

import type { CountEvent, EventWire, Item, SessionActionRecord } from '../../src/domain';
import type { Api } from '../../src/ui/api';
import type { Sello, SessionDetail, SyncSnapshot } from '../../src/ui/admin/types';

export const SESSION_ID = 'sesion-1';

export function item(
  idarticulo: number,
  existencia: number,
  costo: number,
  over: Partial<Item> = {},
): Item {
  return {
    idarticulo,
    codigo: String(idarticulo).padStart(7, '0'),
    nombre: `ITEM ${idarticulo}`,
    presentacion: 'KILO',
    existencia,
    ultimoConteo: null,
    costo,
    ...over,
  };
}

/** One event as the admin's pull hands it over: text `cantidad`, and a cursor. */
export function wire(
  event: CountEvent,
  serverSeq: number,
): EventWire & { serverSeq: string; serverAt: string } {
  return {
    id: event.id,
    sessionId: event.sessionId,
    counterId: event.counterId ?? '',
    seq: event.seq,
    kind: event.kind,
    idarticulo: event.idarticulo,
    cantidad: 'qty' in event ? String(event.qty) : null,
    retractsEventId: 'retractsEventId' in event ? (event.retractsEventId ?? null) : null,
    motivo: null,
    texto: 'texto' in event ? event.texto : null,
    finalSeq: 'finalSeq' in event ? event.finalSeq : null,
    headHash: 'headHash' in event ? event.headHash : null,
    usuario: event.usuario,
    zona: event.zona,
    clientAt: event.at,
    deviceId: event.deviceId,
    prevHash: 'p',
    hash: `h-${event.id}`,
    serverSeq: String(serverSeq),
    serverAt: event.at,
  };
}

export interface CounterFixture {
  id: string;
  nombre: string;
  estado: string;
  lastServerAt?: string | null;
  forked?: boolean;
  pendingFetch?: boolean;
  chainComplete?: boolean;
  storedMaxSeq?: number;
  deviceIds?: string[];
  clockSkewMs?: number | null;
}

export function detailFor(input: {
  items: readonly Item[];
  counters: readonly CounterFixture[];
  /** `counterId -> idarticulo[]`. One section per counter, named after them. */
  secciones?: Record<string, number[]>;
}): SessionDetail {
  const sections = input.counters.map((counter) => ({
    id: `sec-${counter.id}`,
    nombre: `SECCION ${counter.nombre}`,
    counterId: counter.id,
  }));
  const assignments = Object.entries(input.secciones ?? {}).flatMap(([counterId, ids]) =>
    ids.map((idarticulo) => ({
      idarticulo,
      counterId,
      sectionId: `sec-${counterId}`,
    })),
  );
  return {
    session: {
      id: SESSION_ID,
      bodega: '01',
      fechaCorte: '2025/04/30',
      nombre: null,
      estado: 'abierto',
      sourceName: 'COMESTIBLES ALMACEN.xls',
      sourceHash: 'a'.repeat(64),
      createdAt: '2026-08-25T09:00:00.000Z',
      dispatchedAt: '2026-08-25T09:30:00.000Z',
      itemCount: input.items.length,
      mostrarMarcaRegistrado: true,
      assignmentsVersion: 0,
      parameters: {
        countTargetColumn: 'toma',
        uncountedPolicy: 'existencia',
        differenceColumn: 'computed',
      },
      parametrosVerificados: true,
      parametrosSinVerificar: [],
    },
    items: [...input.items],
    familias: null,
    counters: input.counters.map((counter) => ({
      id: counter.id,
      nombre: counter.nombre,
      token: `t-${counter.id}`,
      estado: counter.estado,
      fetchedAt: counter.pendingFetch ? null : '2026-08-25T09:40:00.000Z',
      fetchCount: counter.pendingFetch ? 0 : 1,
      lastServerAt: counter.lastServerAt ?? null,
    })),
    sections,
    assignments,
    coverage: {
      assigned: assignments.length,
      unassigned: [],
      duplicated: [],
      foreign: [],
      complete: true,
    },
    huecos: [],
    blockers: [],
  };
}

export function syncFor(
  counters: readonly CounterFixture[],
  acciones: readonly SessionActionRecord[] = [],
  readyToSeal: SyncSnapshot['session']['readyToSeal'] = [],
  /** P2.5. `estado` and the seal record, for the screens that come after it. */
  over: { estado?: string; sello?: Sello | null } = {},
): SyncSnapshot {
  return {
    session: {
      id: SESSION_ID,
      estado: over.estado ?? 'abierto',
      assignmentsVersion: 0,
      readyToSeal,
    },
    counters: counters.map((counter) => ({
      id: counter.id,
      nombre: counter.nombre,
      estado: counter.estado,
      storedMaxSeq: counter.storedMaxSeq ?? 0,
      headHash: null,
      lastServerAt: counter.lastServerAt ?? null,
      deviceIds: counter.deviceIds ?? ['tablet-a'],
      clockSkewMs: counter.clockSkewMs ?? null,
      forked: counter.forked ?? false,
      finishReason: null,
      pendingFetch: counter.pendingFetch ?? false,
      chainComplete: counter.chainComplete ?? true,
    })),
    acciones: [...acciones],
    sello: over.sello ?? null,
  };
}

/** A sealed session's digests, for the acta and the close-out screen. */
export function selloFor(over: Partial<Sello> = {}): Sello {
  return {
    sealedAt: '2026-08-25T17:00:00.000Z',
    sessionHash: 's'.repeat(64),
    exportedAt: null,
    fileHash: null,
    sourceHash: 'a'.repeat(64),
    tardios: [],
    ...over,
  };
}

/**
 * An api that answers the three reads and records what was posted.
 *
 * The action chain lives here so a test can post a waiver and then read the
 * screen again: `acciones` is what the next `/sync` returns, which is exactly
 * how the real thing works — a waiver is on the chain and nowhere else.
 */
export function reviewApi(input: {
  counters: readonly CounterFixture[];
  events: readonly CountEvent[];
  acciones?: SessionActionRecord[];
  readyToSeal?: SyncSnapshot['session']['readyToSeal'];
  /** P2.5: what `/sync` says the session is, and what it was sealed as. */
  estado?: string;
  sello?: Sello | null;
}) {
  const acciones: SessionActionRecord[] = input.acciones ?? [];
  const posted: { path: string; body: unknown }[] = [];
  const api: Api = {
    get: vi.fn(async (path: string) => {
      if (path.includes('/sync')) {
        return syncFor(input.counters, acciones, input.readyToSeal ?? [], {
          ...(input.estado === undefined ? {} : { estado: input.estado }),
          sello: input.sello ?? null,
        }) as never;
      }
      if (path.includes('/events')) {
        return {
          events: input.events.map((event, index) => wire(event, index + 1)),
          nextCursor: String(input.events.length),
        } as never;
      }
      if (path.includes('/exportar')) {
        // The stored bytes, base64. Two ASCII characters is enough: what the
        // screen is asserted on is that it saves what the server sent, not what
        // it could rebuild.
        return { filename: 'AJUSTE_01_2025-04-30_abcd1234.txt', fileHash: 'f'.repeat(64), base64: 'aG9sYQ==', bytes: 4, exportedAt: null } as never;
      }
      if (path.includes('/bundle')) {
        return { filename: `sesion_${SESSION_ID}.json`, canonical: '{"formato":"conteo-zeus/bundle/v1"}' } as never;
      }
      throw new Error(`nobody asked for ${path}`);
    }),
    post: vi.fn(async (path: string, body?: unknown) => {
      posted.push({ path, body });
      // Only `/acciones` writes to the chain. `/sellar` and `/exportar` are
      // recorded and answered, because what a test asserts about them is the
      // request the screen made, not a state machine this harness would have to
      // reimplement.
      if (!path.includes('/acciones')) return {} as never;
      const sent = body as { kind: SessionActionRecord['kind']; usuario: string; motivo: string };
      const seq = acciones.length + 1;
      acciones.push({
        id: `accion-${seq}`,
        sessionId: SESSION_ID,
        seq,
        kind: sent.kind,
        payload: body as SessionActionRecord['payload'],
        usuario: sent.usuario,
        at: `2026-08-25T15:00:0${seq}.000Z`,
        serverAt: `2026-08-25T15:00:0${seq}.000Z`,
        prevHash: 'p',
        hash: `h${seq}`,
      });
      return {} as never;
    }),
    patch: vi.fn(async () => ({}) as never),
  };
  return { api, posted, acciones };
}
