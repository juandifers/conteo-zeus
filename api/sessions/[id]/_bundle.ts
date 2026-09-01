/**
 * `GET /api/sessions/:id/bundle` — `sesion_<id>.json` (P2.5 §4a).
 *
 * The third artifact, and the one that makes the other two checkable. The acta
 * prints five digests; this is what somebody who was not there feeds to
 * `tools/verificador.html` to arrive at the same five, or at a position where
 * they diverge.
 *
 * It carries everything needed to recompute independently and deliberately
 * carries it **raw**: every event with its `prevHash` and `hash`, every action
 * with its chain fields, the whole catalogue including `rawRow`, and the
 * `sourceHash` the seal was taken over. Nothing here is a summary of anything —
 * a summary is a thing you have to trust, and trust is what this file exists to
 * make unnecessary.
 *
 * Served from `sellado` onwards. Before the seal there is no `sessionHash` to
 * verify against, and a bundle of a live session would be a snapshot of a log
 * that is still growing — a document that invites the reader to check something
 * that was never claimed.
 *
 * **No token is in it.** A counter's link is a bearer credential; the acta
 * identifies people by name and the chain identifies them by `counterId`, and
 * neither needs the string that would let somebody push events as them.
 */
import { bundleJson, type BundleAction, type SessionBundle } from '../../../src/app/index.js';
import { actionGenesisHash, genesisHash } from '../../../src/domain/index.js';
import type { Db } from '../../_db.js';
import { fail, ok, type ApiResult } from '../../_http.js';
import {
  loadCatalogue,
  loadCounterSync,
  loadSessionActions,
  loadSessionEvents,
  loadSessionRow,
} from '../../_store.js';
import { parametersOf } from './index.js';

export async function sessionBundle(db: Db, id: string | null): Promise<ApiResult> {
  if (!id) return fail(400, 'falta el id de la sesión');
  const session = await loadSessionRow(db, id);
  if (!session) return fail(404, 'no existe esa sesión');
  if (session.sessionHash === null) {
    return fail(
      409,
      'esta sesión todavía no está sellada, así que no hay nada que verificar: el ' +
        'paquete de auditoría existe para recomputar un sello.',
      { code: 'NOT_SEALED', estado: session.estado },
    );
  }

  const [catalogue, counters, events, actions] = await Promise.all([
    loadCatalogue(db, id),
    loadCounterSync(db, id),
    loadSessionEvents(db, id),
    loadSessionActions(db, id),
  ]);

  const acciones: BundleAction[] = actions.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    usuario: row.usuario,
    at: row.clientAt,
    serverAt: row.serverAt,
    prevHash: row.prevHash,
    hash: row.hash,
  }));
  const last = acciones[acciones.length - 1];

  const bundle: SessionBundle = {
    formato: 'conteo-zeus/bundle/v1',
    sesion: {
      id: session.id,
      bodega: session.bodega,
      fechaCorte: session.fechaCorte,
      nombre: session.nombre,
      estado: session.estado,
      sourceName: session.sourceName,
      sourceHash: session.sourceHash,
      createdAt: session.createdAt,
      dispatchedAt: session.dispatchedAt,
      sealedAt: session.sealedAt,
      exportedAt: session.exportedAt,
      parameters: parametersOf(session),
    },
    catalogo: catalogue.map((row) => ({
      idarticulo: row.item.idarticulo,
      codigo: row.item.codigo,
      nombre: row.item.nombre,
      presentacion: row.item.presentacion,
      // Strings, as they are in the database and on the wire. A JSON number
      // would put every one of them through a double before a verifier saw it.
      existencia: String(row.item.existencia),
      costo: String(row.item.costo),
      ultimoConteo: row.item.ultimoConteo === null ? null : String(row.item.ultimoConteo),
      rawRow: row.rawRow,
    })),
    contadores: counters.map((counter) => ({
      id: counter.id,
      nombre: counter.nombre,
      estado: counter.estado,
      finalSeq: counter.finalSeq,
      headHash: counter.headHash,
      finishReason: counter.finishReason,
      fetchedAt: counter.fetchedAt,
      lastServerAt: counter.lastServerAt,
      deviceIds: counter.deviceIds,
      clockSkewMs: counter.clockSkewMs,
      forked: counter.forked,
    })),
    eventos: events,
    acciones,
    sellos: {
      sessionHash: session.sessionHash,
      fileHash: session.fileHash,
      // Restated rather than left to be re-derived: the verifier recomputes each
      // chain from genesis and then checks its own heads against these, so a
      // disagreement is reported as «the recorded head for Luis is not the one
      // his events produce» instead of as an unexplained seal mismatch.
      contadores: counters.map((counter) => ({
        counterId: counter.id,
        maxSeq: counter.storedMaxSeq,
        headHash: counter.headHash ?? genesisHash(id, counter.id),
      })),
      actionHead: last ? last.hash : actionGenesisHash(id),
      actionMaxSeq: last ? last.seq : 0,
    },
  };

  return ok({
    filename: `sesion_${session.id}.json`,
    /**
     * The canonical bytes, as a string.
     *
     * The browser saves this verbatim rather than re-serialising the object:
     * `canonicalJson` sorts keys and refuses floats, and a `JSON.stringify` on
     * the way to the disk would undo both. Two downloads of one sealed session
     * are byte-identical, which is a property somebody comparing two files in
     * three years will want.
     */
    canonical: bundleJson(bundle),
  });
}
