/**
 * `POST /api/c/:token/events` — the push.
 *
 * Counters never see totals, so **counters never pull anybody else's events.**
 * This is the whole of sync on the counting side: the device pushes, the server
 * accumulates, the admin pulls (`/api/sessions/:id/sync`). There is no merge on
 * the device, no conflict resolution and no CRDT, and if a change here starts to
 * need a counter's tablet to know what another counter recorded, something
 * upstream has gone wrong and the answer is to go and find it rather than to
 * build the merge.
 *
 * **All-or-nothing.** Partial acceptance would leave the device guessing which
 * half landed, and the guess would be wrong exactly when it matters: a tablet
 * that concluded it had delivered 200 events when 60 arrived clears 140 out of
 * its outbox and nobody ever finds out.
 *
 * The three failure modes are three distinct answers, because they mean three
 * different things and the device does three different things about them:
 *
 *   **replay** — sequences already stored, hashes identical. Silent, cheap, and
 *   the common case after a dropped response. Treated as success.
 *   **gap** — the batch starts above `storedMaxSeq + 1`. `expectedFrom` tells
 *   the device where to resume. Not an error state: a tablet force-closed
 *   mid-drain lands here routinely.
 *   **fork** — the same `seq` with a different hash. Loud, and the device must
 *   stop. Either two live devices are pushing one token or a local database was
 *   restored from a backup; nothing about it resolves itself, and a retry loop
 *   hammering a fork is worse than a stop.
 */
import {
  chainHash,
  deriveCounterEstado,
  genesisHash,
  validateEvent,
  type ChainedEvent,
  type CountEvent,
  type StoredCounterEvent,
} from '../../../src/domain/index.js';
import { isTokenShaped } from '../../../src/lib/token.js';
import type { Db } from '../../_db.js';
import { fail, messageOf, ok, type ApiResult } from '../../_http.js';
import {
  findByToken,
  insertEventsStatements,
  loadCounterChain,
  loadSessionRow,
  markForked,
  type EventWire,
  type StoredEventRow,
} from '../../_store.js';

/** Sessions a counter may push into. */
const OPEN_TO_PUSH = new Set(['abierto', 'revision']);

/**
 * The largest batch the server will take.
 *
 * The device drains in 200s (P2.2 §1a) and this is the same number, checked
 * rather than assumed: a serverless function has a request body limit and a
 * time limit, and a device that decided to ship its whole 4 000-event afternoon
 * in one request would find out about both at the worst moment.
 */
const MAX_BATCH = 200;

/** How the batch relates to what the server already holds. */
export type PushCode =
  | 'SESSION_SEALED'
  | 'SESSION_NOT_OPEN'
  | 'SEQUENCE_GAP'
  | 'CHAIN_FORK'
  | 'DEVICE_COLLISION'
  | 'CHAIN_INVALID'
  | 'RETRACT_SIN_SCOPE'
  | 'BATCH_INVALID';

export interface PushAck {
  /** The highest `seq` the server now holds for this counter. */
  acceptedThrough: number;
  headHash: string;
  counterEstado: string;
  /** Normalised UTC. The device subtracts its own clock from this (§3c). */
  serverAt: string;
}

/** `{ events: [{ event, prevHash, hash }] }` — one counter, contiguous ascending `seq`. */
export interface PushBody {
  events: ChainedEvent[];
}

function bad(code: PushCode, error: string, extra: Record<string, unknown> = {}): ApiResult {
  return fail(400, error, { code, ...extra });
}

function conflict(code: PushCode, error: string, extra: Record<string, unknown> = {}): ApiResult {
  return fail(409, error, { code, ...extra });
}

/** Structural check on one wire element, before anything reads a field off it. */
function malformed(link: unknown, at: number): string | null {
  if (typeof link !== 'object' || link === null) return `el elemento ${at} no es un objeto`;
  const { event, prevHash, hash } = link as Partial<ChainedEvent>;
  if (typeof prevHash !== 'string' || prevHash.length === 0) return `falta prevHash en ${at}`;
  if (typeof hash !== 'string' || hash.length === 0) return `falta hash en ${at}`;
  if (typeof event !== 'object' || event === null) return `falta el evento en ${at}`;
  const e = event as Partial<CountEvent>;
  for (const field of ['id', 'sessionId', 'counterId', 'kind', 'usuario', 'zona', 'at', 'deviceId']) {
    if (typeof (e as Record<string, unknown>)[field] !== 'string') {
      return `falta ${field} en el evento ${at}`;
    }
  }
  if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 1) {
    return `seq inválido en el evento ${at}: la numeración de un contador empieza en 1`;
  }
  return null;
}

/** An event as the `events` table holds it. Every quantity crosses as a string. */
function toWire(link: ChainedEvent): EventWire {
  const e = link.event;
  return {
    id: e.id,
    sessionId: e.sessionId,
    counterId: e.counterId!,
    seq: e.seq,
    kind: e.kind,
    idarticulo: e.idarticulo,
    // `String(qty)` is JavaScript's shortest round-tripping decimal and is what
    // `canonicalEvent` hashed (ZEUS_FORMAT.md §3). Storing anything else — a
    // `numeric`, a re-rendered float — breaks the chain silently, and a broken
    // chain is indistinguishable from a tampered one.
    cantidad: 'qty' in e ? String(e.qty) : null,
    retractsEventId: e.kind === 'retract' ? (e.retractsEventId ?? null) : null,
    motivo: e.kind === 'unchanged' ? (e.motivo ?? null) : null,
    texto: e.kind === 'note' ? e.texto : null,
    finalSeq: e.kind === 'finish' ? e.finalSeq : null,
    headHash: e.kind === 'finish' ? e.headHash : null,
    usuario: e.usuario,
    zona: e.zona,
    clientAt: e.at,
    deviceId: e.deviceId,
    prevHash: link.prevHash,
    hash: link.hash,
  };
}

function asStored(link: ChainedEvent): StoredCounterEvent {
  const e = link.event;
  return {
    seq: e.seq,
    kind: e.kind,
    hash: link.hash,
    prevHash: link.prevHash,
    finalSeq: e.kind === 'finish' ? e.finalSeq : null,
    headHash: e.kind === 'finish' ? e.headHash : null,
  };
}

function storedToDomain(row: StoredEventRow): StoredCounterEvent {
  return {
    seq: row.seq,
    kind: row.kind,
    hash: row.hash,
    prevHash: row.prevHash,
    finalSeq: row.finalSeq,
    headHash: row.headHash,
  };
}

export interface PushOptions {
  now?: () => string;
  /** Guards the one retry after a lost race; not a caller's concern. */
  attempt?: number;
}

export async function pushEvents(
  db: Db,
  token: string | null,
  body: unknown,
  options: PushOptions = {},
): Promise<ApiResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const serverAt = now();

  // 1. Resolve the token. A malformed and an unknown token get the identical
  //    answer: telling them apart tells somebody their guess had the right form.
  if (!token || !isTokenShaped(token)) return fail(404, 'ese enlace no existe');
  const found = await findByToken(db, token);
  if (!found) return fail(404, 'ese enlace no existe');
  const counter = found.counter;

  // 2. The session has to be open.
  const session = await loadSessionRow(db, found.sessionId);
  if (!session) return fail(404, 'ese enlace no existe');
  if (session.estado === 'sellado' || session.estado === 'cerrado') {
    // The ugliest case in the system, and it gets an honest answer rather than
    // a discard. The device keeps every event, marks them
    // `rechazado_sesion_sellada` and says so without blaming the counter: their
    // work exists, it did not make it into the file, and the admin needs to
    // know. P2.5's sealing gate makes this rare; it cannot make it impossible,
    // because a tablet can be lost for a day.
    return conflict(
      'SESSION_SEALED',
      'esta sesión ya está sellada: lo que contaste no entra en el archivo. ' +
        'Guarda la tableta y avisa al administrador — tus registros siguen aquí.',
      { estado: session.estado },
    );
  }
  if (!OPEN_TO_PUSH.has(session.estado)) {
    return conflict('SESSION_NOT_OPEN', `esta sesión está en «${session.estado}»`, {
      estado: session.estado,
    });
  }

  // 3. The batch, structurally.
  const links = (body as Partial<PushBody> | null)?.events;
  if (!Array.isArray(links)) return bad('BATCH_INVALID', 'falta `events`');
  if (links.length === 0) return bad('BATCH_INVALID', '`events` llegó vacío');
  if (links.length > MAX_BATCH) {
    return bad('BATCH_INVALID', `un lote no puede traer más de ${MAX_BATCH} eventos`, {
      max: MAX_BATCH,
    });
  }
  for (const [at, link] of links.entries()) {
    const problem = malformed(link, at);
    if (problem) return bad('BATCH_INVALID', problem);
  }
  const batch = links as ChainedEvent[];

  // 4. Every event belongs to this counter and this session, and is a legal
  //    event at all. `validateEvent` is the domain's own check — the normalised
  //    instant, the control characters in a note, the null `idarticulo` on a
  //    kind that asserts something about an article — run here because the
  //    server is where an event arrives from a device nobody controls.
  for (const link of batch) {
    const event = link.event;
    if (event.counterId !== counter.id) {
      return bad('BATCH_INVALID', `el evento ${event.id} es de otro contador`);
    }
    if (event.sessionId !== session.id) {
      return bad('BATCH_INVALID', `el evento ${event.id} es de otra sesión`);
    }
    try {
      validateEvent(event);
    } catch (cause) {
      return bad('BATCH_INVALID', messageOf(cause));
    }
    // **The gate** (P2.2). A withdrawal with no target retires the whole
    // article, including whatever another counter recorded against it, and the
    // chain stays intact while it happens. It does not exist in the P2 path and
    // the server is the place that makes that true for every client, including
    // the cached PWA build from three weeks ago.
    if (event.kind === 'retract' && event.retractsEventId === undefined) {
      return fail(
        422,
        'una retractación sin `retractsEventId` retira el artículo completo, ' +
          'incluido lo que contó otra persona: no existe en una sesión con varios ' +
          'contadores',
        { code: 'RETRACT_SIN_SCOPE' satisfies PushCode, eventId: event.id },
      );
    }
  }

  // 5. Contiguous and ascending within the batch.
  for (let i = 1; i < batch.length; i++) {
    if (batch[i].event.seq !== batch[i - 1].event.seq + 1) {
      return bad(
        'BATCH_INVALID',
        `el lote no es contiguo: seq ${batch[i - 1].event.seq} y luego ${batch[i].event.seq}`,
      );
    }
  }

  // 6. Where the batch sits against what the server holds.
  const storedRows = await loadCounterChain(db, counter.id);
  const stored = storedRows.map(storedToDomain);
  const storedBySeq = new Map(stored.map((row) => [row.seq, row]));
  const storedMax = stored.reduce((max, row) => Math.max(max, row.seq), 0);
  const storedHead =
    storedMax === 0
      ? genesisHash(session.id, counter.id)
      : storedBySeq.get(storedMax)!.hash;

  const first = batch[0].event.seq;
  const last = batch[batch.length - 1].event.seq;

  if (first > storedMax + 1) {
    return conflict(
      'SEQUENCE_GAP',
      `faltan eventos antes de seq ${first}; reanuda desde ${storedMax + 1}`,
      { expectedFrom: storedMax + 1, storedMaxSeq: storedMax },
    );
  }

  // The overlap: everything in the batch the server already holds. Identical
  // hashes make it a replay, which is silent and cheap because it is the common
  // case after a dropped response. A different hash at the same seq is a fork.
  for (const link of batch) {
    const already = storedBySeq.get(link.event.seq);
    if (!already) continue;
    if (already.hash === link.hash) continue;

    await markForked(db, counter.id);
    // Two live devices on one token is a real scenario — two counters scanning
    // the same QR by mistake — and it deserves its own message, because
    // `unique (counter_id, seq)` makes it fail in a way the counter reads as
    // bad wifi. The discriminator is whether the counter is already bound to a
    // *different* device.
    const collision =
      counter.deviceId !== null &&
      counter.deviceId !== undefined &&
      counter.deviceId !== batch[0].event.deviceId;
    return conflict(
      collision ? 'DEVICE_COLLISION' : 'CHAIN_FORK',
      collision
        ? 'Otra tableta está usando este mismo enlace. No sigas contando — avisa al ' +
          'administrador.'
        : 'la cadena de este contador se bifurcó: el servidor guarda otro evento en ' +
          `seq ${link.event.seq}. No sigas contando y avisa al administrador.`,
      {
        atSeq: link.event.seq,
        storedHash: already.hash,
        submittedHash: link.hash,
        ...(collision ? { boundDeviceId: counter.deviceId, pushingDeviceId: batch[0].event.deviceId } : {}),
      },
    );
  }

  if (last <= storedMax) {
    // A pure replay. Everything already here, byte for byte.
    return ok(ackFor(session.id, counter.id, stored, storedMax, storedHead, serverAt));
  }

  const fresh = batch.filter((link) => link.event.seq > storedMax);

  // 7. The chain, recomputed with the same module the device used.
  //
  //    Same module and not an equivalent one: the client and the functions are
  //    both TypeScript and the only defence against them disagreeing about a
  //    byte is that there is one implementation (`src/domain/chain.ts`).
  if (fresh[0].prevHash !== storedHead) {
    await markForked(db, counter.id);
    return conflict(
      'CHAIN_FORK',
      `el primer evento del lote engancha con otra cadena (seq ${fresh[0].event.seq})`,
      { atSeq: fresh[0].event.seq, expectedPrevHash: storedHead, submittedPrevHash: fresh[0].prevHash },
    );
  }
  let prev = storedHead;
  for (const link of fresh) {
    if (link.prevHash !== prev) {
      return conflict('CHAIN_INVALID', `el lote se rompe en seq ${link.event.seq}`, {
        atSeq: link.event.seq,
      });
    }
    let recomputed: string;
    try {
      recomputed = chainHash(link.prevHash, link.event);
    } catch (cause) {
      return conflict('CHAIN_INVALID', messageOf(cause), { atSeq: link.event.seq });
    }
    if (recomputed !== link.hash) {
      return conflict(
        'CHAIN_INVALID',
        `el hash de seq ${link.event.seq} no corresponde a su contenido`,
        { atSeq: link.event.seq },
      );
    }
    prev = link.hash;
  }

  // 8. Insert, and derive the counter's state from the chain the server will
  //    then hold — never from what the device claimed about itself.
  const after = [...stored, ...fresh.map(asStored)];
  const verdict = deriveCounterEstado(session.id, counter.id, after);
  const pushingDevice = fresh[fresh.length - 1].event.deviceId;
  const skew = maxSkew(fresh, serverAt);

  const result = await db.transaction(
    insertEventsStatements(counter.id, storedMax, fresh.map(toWire), {
      estado: verdict.estado,
      finishReason: verdict.reason,
      finalSeq: verdict.finalSeq,
      headHash: verdict.headHash,
      deviceId: pushingDevice,
      clockSkewMs: skew,
      serverAt,
      headSeq: last,
      chainHead: fresh[fresh.length - 1].hash,
    }),
  );

  // The guard declined: another push moved the chain between the read above and
  // the lock. Decide again from what is there now — once, so a pathological
  // loop cannot form. The second attempt sees the new state and answers replay,
  // gap or fork accordingly, all of which the device knows what to do with.
  if (result[result.length - 1].length === 0) {
    if ((options.attempt ?? 0) >= 1) {
      return conflict('SEQUENCE_GAP', 'otra tableta escribió al mismo tiempo; reintenta', {
        expectedFrom: storedMax + 1,
      });
    }
    return pushEvents(db, token, body, { ...options, attempt: (options.attempt ?? 0) + 1 });
  }

  return ok({
    acceptedThrough: last,
    headHash: fresh[fresh.length - 1].hash,
    counterEstado: verdict.estado,
    serverAt,
  } satisfies PushAck);
}

/** The ack for a replay: nothing was written, so it describes what is already there. */
function ackFor(
  sessionId: string,
  counterId: string,
  stored: readonly StoredCounterEvent[],
  storedMax: number,
  storedHead: string,
  serverAt: string,
): PushAck {
  return {
    acceptedThrough: storedMax,
    headHash: storedHead,
    counterEstado: deriveCounterEstado(sessionId, counterId, stored).estado,
    serverAt,
  };
}

/**
 * The largest signed skew in the batch, `client_at` minus `server_at`, in ms.
 *
 * Signed, and kept at its largest magnitude rather than its latest value: a
 * tablet that was nine minutes fast at eleven and correct at four was still nine
 * minutes fast in the log the acta is read from. It changes no total — the fold
 * is commutative under P2 rules — so it is surfaced and never corrected.
 * Rewriting a device's timestamps would change the hashes and break the chain to
 * fix a cosmetic problem.
 */
function maxSkew(batch: readonly ChainedEvent[], serverAt: string): number {
  const server = Date.parse(serverAt);
  let worst = 0;
  for (const link of batch) {
    const client = Date.parse(link.event.at);
    if (Number.isNaN(client)) continue;
    const skew = client - server;
    if (Math.abs(skew) > Math.abs(worst)) worst = skew;
  }
  return worst;
}
