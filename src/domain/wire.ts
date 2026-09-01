/**
 * One stored event as it crosses the wire, and how to read it back.
 *
 * This lived in `api/_store.ts` until P2.4, where it was the shape a Postgres
 * row comes back in and nothing else needed it. The admin's review screen needs
 * it too — `GET /api/sessions/:id/events` hands the browser these rows and the
 * browser has to fold them — and a second `eventFromRow` written in `src/ui/`
 * would be a second definition of what a stored `add` means. So the conversion
 * moved down here, where both sides already share the fold it feeds.
 *
 * It stays deliberately narrow. This is not a general serialisation layer: it is
 * the inverse of one insert statement and one select, and it exists so that
 * exactly one piece of code decides that a `cantidad` of `'8.5'` is the number
 * 8.5.
 */
import type { CountEvent } from './types.js';

/**
 * The columns of `events`, in the names the queries alias them to.
 *
 * `cantidad` is **text**, and that is the load-bearing decision of the whole
 * schema (ZEUS_FORMAT.md §3): a quantity is hashed as its shortest decimal
 * representation, and a `numeric` column round-tripped through a driver's float
 * would break the chain silently.
 */
export interface EventWire {
  id: string;
  sessionId: string;
  counterId: string;
  seq: number;
  kind: string;
  idarticulo: number | null;
  cantidad: string | null;
  retractsEventId: string | null;
  motivo: string | null;
  texto: string | null;
  finalSeq: number | null;
  headHash: string | null;
  usuario: string;
  zona: string;
  clientAt: string;
  deviceId: string;
  prevHash: string;
  hash: string;
}

/**
 * A stored row back as the domain event it was.
 *
 * As narrow as the reading it serves: what comes back is folded, and the fold
 * reads `kind`, `qty`, `retractsEventId` and the ordering keys. `Number(cantidad)`
 * is exact — the stored string is JavaScript's shortest round-tripping
 * representation of the double that was hashed — so it parses back to the value
 * it left as.
 *
 * An unknown `kind` throws rather than being skipped. A row the domain has no
 * shape for is a row a future migration added and this code has not learned
 * about, and quietly dropping it would take a count out of a total with nothing
 * anywhere saying so.
 */
export function eventFromRow(row: EventWire): CountEvent {
  const base = {
    id: row.id,
    sessionId: row.sessionId,
    counterId: row.counterId,
    usuario: row.usuario,
    zona: row.zona,
    at: row.clientAt,
    deviceId: row.deviceId,
    seq: row.seq,
  };
  switch (row.kind) {
    case 'set':
    case 'add':
      return { ...base, kind: row.kind, idarticulo: row.idarticulo!, qty: Number(row.cantidad) };
    case 'unchanged':
      return {
        ...base,
        kind: 'unchanged',
        idarticulo: row.idarticulo!,
        ...(row.motivo === null ? {} : { motivo: row.motivo }),
      };
    case 'retract':
      return {
        ...base,
        kind: 'retract',
        idarticulo: row.idarticulo!,
        ...(row.retractsEventId === null ? {} : { retractsEventId: row.retractsEventId }),
      };
    case 'note':
      return { ...base, kind: 'note', idarticulo: row.idarticulo, texto: row.texto ?? '' };
    case 'finish':
      return {
        ...base,
        kind: 'finish',
        idarticulo: null,
        finalSeq: row.finalSeq ?? 0,
        headHash: row.headHash ?? '',
      };
    case 'reopen':
      return { ...base, kind: 'reopen', idarticulo: null };
    default:
      throw new Error(`event ${row.id} has kind «${row.kind}», which the domain has no shape for`);
  }
}
