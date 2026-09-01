/**
 * The counter state machine, and the question P2.5 gates sealing on.
 *
 * **Two state machines, and they are not the same machine.** They do not share
 * an enum and must never be merged into one:
 *
 *     DISPOSITIVO (Dexie)                    SERVIDOR (Postgres)
 *     ────────────────────                    ──────────────────
 *     contando                                asignado           sin eventos
 *        │ toca "Terminar"                     │
 *     terminado_local                          contando           eventos, sin finish
 *        │ ack del servidor                    │
 *     terminado_confirmado                     terminado_incompleto
 *        │ toca "Reabrir"                      │   finish presente, cadena incompleta
 *     contando                                 terminado_confirmado
 *                                              │   finish presente, cadena completa
 *                                             contando  (tras reopen)
 *
 * `terminado_local` exists **only on the device**. The server cannot observe it
 * and must never store it: it is a claim a device makes about itself, and a
 * claim is not a fact the server can assert. With no connectivity in the bodega
 * a counter who recorded nothing looks exactly like a counter whose tablet is
 * holding two hundred events in a cold room, so the server's states are defined
 * entirely by what arrived.
 *
 * Everything here is pure and lives in the domain because both sides read it:
 * the serverless function that ingests a push derives `estado` with
 * `deriveCounterEstado`, and P2.4/P2.5 ask `sessionReadyToSeal` the same
 * question from the other end.
 */
import { checkFinishManifest, type StoredLink } from './chain.js';
import type { CounterEstado } from './assignment.js';

/**
 * What a *device* believes about itself.
 *
 * Deliberately a separate type from `CounterEstado`, with one overlapping
 * spelling (`terminado_confirmado`) that means the same thing on both sides
 * because it is the one state the server told the device about.
 */
export type DeviceEstado = 'contando' | 'terminado_local' | 'terminado_confirmado';

/** One stored event, as much of it as the state machine reads. */
export interface StoredCounterEvent extends StoredLink {
  kind: string;
  /** The hash of the link before this one — what a `finish` has to match. */
  prevHash: string;
  /** Present on a `finish`, null elsewhere. */
  finalSeq: number | null;
  /** Present on a `finish`, null elsewhere. */
  headHash: string | null;
}

export interface CounterVerdict {
  estado: CounterEstado;
  /** Why, when `estado` is `terminado_incompleto`. Printed beside the counter's name. */
  reason: string | null;
  /** The manifest the standing `finish` claimed, when there is one. */
  finalSeq: number | null;
  headHash: string | null;
}

/** The `finish` that is still standing: the last one with no `reopen` after it. */
function standingFinish(
  events: readonly StoredCounterEvent[],
): StoredCounterEvent | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let finish: StoredCounterEvent | null = null;
  for (const event of sorted) {
    if (event.kind === 'finish') finish = event;
    else if (event.kind === 'reopen') finish = null;
  }
  return finish;
}

/**
 * What the server may say about this counter, from what it holds and nothing else.
 *
 * A `finish` that is present but whose manifest does not verify produces
 * `terminado_incompleto` **with the reason attached**, and it is a state rather
 * than an error: the counter really did finish, the events really are missing,
 * and both facts have to reach the admin. The common cause is entirely benign —
 * the finish and forty content events left the tablet in different batches and
 * only one of them made it across the office wifi — so the same push that fills
 * the hole flips this to `terminado_confirmado` with nobody doing anything.
 */
export function deriveCounterEstado(
  sessionId: string,
  counterId: string,
  events: readonly StoredCounterEvent[],
): CounterVerdict {
  if (events.length === 0) {
    return { estado: 'asignado', reason: null, finalSeq: null, headHash: null };
  }

  const finish = standingFinish(events);
  if (!finish) return { estado: 'contando', reason: null, finalSeq: null, headHash: null };

  // A `finish` row with no manifest is a row the ingest path should have
  // refused. Reported rather than thrown: this function is asked about rows
  // that are already in the database, and "this cannot be trusted" is an answer
  // the admin needs, not an exception a monitor endpoint should die on.
  if (finish.finalSeq === null || finish.headHash === null) {
    return {
      estado: 'terminado_incompleto',
      reason: 'el finish llegó sin manifiesto (finalSeq / headHash)',
      finalSeq: finish.finalSeq,
      headHash: finish.headHash,
    };
  }

  const verdict = checkFinishManifest({
    sessionId,
    counterId,
    manifest: { finalSeq: finish.finalSeq, headHash: finish.headHash },
    finishSeq: finish.seq,
    finishPrevHash: finish.prevHash,
    stored: events,
  });

  return {
    estado: verdict.ok ? 'terminado_confirmado' : 'terminado_incompleto',
    reason: verdict.ok ? null : verdict.reason,
    finalSeq: finish.finalSeq,
    headHash: finish.headHash,
  };
}

/**
 * Every event a counter wrote **after** their first `finish`.
 *
 * The amendment log: a counter who finished, found a stray box and reopened has
 * a second pass that the admin has to be able to see separately from the first.
 *
 * Derived from the log — the position of the first `kind === 'finish'` within
 * this counter's own sequence — and deliberately not stored as a boolean on the
 * row. A stored flag is a second copy of a fact the events already carry, and
 * the two drift the first time a batch arrives out of order: an event pushed
 * late, written before the finish and inserted after it, would be stamped
 * post-finish for ever on the strength of when it happened to arrive.
 */
export function postFinishSeqs(events: readonly StoredCounterEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const first = sorted.find((event) => event.kind === 'finish');
  if (!first) return [];
  return sorted.filter((event) => event.seq > first.seq).map((event) => event.seq);
}

/** What `sessionReadyToSeal` needs to know about one counter. */
export interface CounterSyncState {
  id: string;
  nombre: string;
  estado: CounterEstado;
  /** Set when two chains claim one `seq`. Nothing about this resolves itself. */
  forked: boolean;
  /** When this counter's device pulled its assignment; `null` is P2.1's `pendiente`. */
  fetchedAt: string | null;
  /** Why `terminado_incompleto`, when it is. */
  finishReason: string | null;
  /**
   * The stored chain has no hole in it: every `seq` from 1 to the highest is here.
   *
   * What a **retired** counter is gated on (P2.3.5 §5a), and the only completeness
   * question the server can answer without a `finish` manifest. It is exact for
   * the case it is asked about — a hole is visible, `unique (counter_id, seq)`
   * makes `count(*) = max(seq)` equivalent to contiguity — and it is **silent
   * about a tail**: a tablet holding seq 61 to 83 and nothing after leaves a
   * chain that is contiguous 1..60 and looks complete.
   *
   * That limit is not a defect to be fixed here; it is the reason `finish`
   * carries a manifest at all, and the reason `retirar_contador` requires a
   * reason a person typed. What the gate catches is the case that is actually
   * common — some of a counter's later events arrived and the ones in between
   * did not — and `sellar_sin_registros` is what an admin uses when the answer
   * is «wait for the tablet» and the tablet is not coming.
   */
  chainComplete: boolean;
}

/**
 * A counter whose missing work the admin has explicitly sealed over (§5b).
 *
 * Derived from `session_actions` rather than stored on `counters`, because a
 * flag on the row would be a second copy of a fact the action chain already
 * carries — and a state an admin could reach by editing a row by hand is
 * exactly what the sealing gate exists to make impossible.
 */
export interface SealOverride {
  counterId: string;
  /** The sequence range known missing, as it will be printed on the acta. */
  faltan: string;
}

export type SealBlocker =
  | { kind: 'sin-contadores' }
  | {
      kind: 'contador-sin-terminar';
      counterId: string;
      nombre: string;
      estado: CounterEstado;
      /** The manifest failure, when the counter finished and the chain did not verify. */
      detalle: string | null;
    }
  | { kind: 'contador-bifurcado'; counterId: string; nombre: string }
  | { kind: 'contador-sin-descargar'; counterId: string; nombre: string }
  /**
   * Retired, and the server is holding a chain with a hole in it (§5a).
   *
   * A separate blocker from `contador-sin-terminar` because the resolutions are
   * different and only one of them is a button. This one is resolved by the
   * tablet coming back and draining — which is the answer the screen should push
   * toward — or, when it is not coming, by `sellar_sin_registros`, which is an
   * admin putting their name on a count that is missing a named person's work.
   */
  | { kind: 'contador-retirado-incompleto'; counterId: string; nombre: string };

/**
 * Why this session cannot be sealed yet. Empty means it can.
 *
 * **The gate is `terminado_confirmado` and nothing weaker.** Not "everyone
 * clicked done", which is a claim; `terminado_confirmado` is a proof — the
 * server holds a complete, gap-free, hash-consistent chain for every counter,
 * checked against a manifest the device could not have written without the
 * events behind it. A device sitting in `terminado_local` has made the claim and
 * the proof has not arrived, and the difference between those two is the entire
 * reason `FinishEvent` carries a manifest at all.
 *
 * All reasons are returned, never the first: an admin chasing tablets at five
 * o'clock needs the list, not the head of it.
 *
 * P2.5 gates on this; P2.4 displays it. It is built here, in P2.2, because this
 * task owns the states it reads.
 */
export function sessionReadyToSeal(input: {
  counters: readonly CounterSyncState[];
  /**
   * The `sellar_sin_registros` actions standing on this session (P2.3.5 §5b).
   *
   * Optional so every existing caller is unchanged, and so that "no overrides"
   * is spelled the same way as "none were signed".
   */
  overrides?: readonly SealOverride[];
}): SealBlocker[] {
  const blockers: SealBlocker[] = [];

  // A session with no counters is not a finished count, it is a session nobody
  // was dispatched for. Not one of the three conditions named in the brief
  // because dispatch already refuses it (P2.1 §4b) — but sealing must not
  // depend on another gate having run, and an empty list would otherwise read
  // as "ready".
  if (input.counters.length === 0) return [{ kind: 'sin-contadores' }];

  const sealedOver = new Set((input.overrides ?? []).map((override) => override.counterId));

  for (const counter of input.counters) {
    // A retired counter is a decision, not a chain state, and it is the one
    // resolution that lets a session with somebody missing from it be sealed at
    // all. Everything below is scoped by it.
    const retired = counter.estado === 'retirado';

    // `fetchedAt === null` on a retired counter is P2.3.5 §5c — «María fue
    // asignada y nunca llegó». Their articles were reassigned and they were
    // retired, which *is* the resolution; blocking on the tablet they never
    // opened would leave the session unsealable for ever.
    if (counter.fetchedAt === null && !retired) {
      blockers.push({
        kind: 'contador-sin-descargar',
        counterId: counter.id,
        nombre: counter.nombre,
      });
    }
    // A fork is never waived by retirement. Two chains claiming one `seq` means
    // the server is holding events it cannot order, and no admin decision about
    // who is still counting changes that.
    if (counter.forked) {
      blockers.push({
        kind: 'contador-bifurcado',
        counterId: counter.id,
        nombre: counter.nombre,
      });
    }
    if (retired) {
      // Their sixty counts are real data and they belong in the file, so the
      // gate is on the chain being whole rather than on the counter having
      // finished — they did not finish, that is what retirement records.
      if (!counter.chainComplete && !sealedOver.has(counter.id)) {
        blockers.push({
          kind: 'contador-retirado-incompleto',
          counterId: counter.id,
          nombre: counter.nombre,
        });
      }
      continue;
    }
    if (counter.estado !== 'terminado_confirmado') {
      blockers.push({
        kind: 'contador-sin-terminar',
        counterId: counter.id,
        nombre: counter.nombre,
        estado: counter.estado,
        detalle: counter.finishReason,
      });
    }
  }

  return blockers;
}
