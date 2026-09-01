/**
 * The per-counter hash chain (P2).
 *
 * **This module is imported unchanged by the client and by the serverless
 * functions.** Both sides are TypeScript, and the only defence against the two
 * of them disagreeing about a byte is that there are not two implementations.
 * A second copy on the server — in SQL, in Python, in "equivalent" JS — is the
 * failure mode this file exists to prevent, and it would surface as a counter
 * whose chain the server rejects for reasons nobody can reproduce on the
 * tablet.
 *
 * What the chain is for: with no connectivity in the bodega, a server cannot
 * distinguish a counter who recorded nothing for an hour from a counter whose
 * tablet is holding 200 queued events in a cold room. Absence of data looks
 * identical either way. A `finish` event carries `finalSeq` and `headHash`, and
 * `verifyChain` below is what turns that claim into something checkable before
 * a session is sealed (P2.4).
 *
 * It lives in src/domain/ and imports only src/lib/, like everything here.
 */
import { sha256Hex } from '../lib/hash';
import type { CountEvent } from './types';

/**
 * The domain separator, versioned.
 *
 * Present so that a future change to what is hashed is a *different* chain
 * rather than a silently incompatible one: two versions of this app hashing
 * the same event must either agree or visibly disagree, never coincide by
 * accident on a subset of events.
 */
const EVENT_TAG = 'conteo-zeus/event/v1';
const GENESIS_TAG = 'conteo-zeus/genesis/v1';

/**
 * The record separator (`\u001e`, `0x1E`), between the previous hash and the event.
 *
 * A hex digest cannot contain it, so no `prevHash` can absorb the boundary.
 */
const SEPARATOR = '\u001e';

const utf8 = new TextEncoder();

/**
 * Thrown when an event cannot be hashed at all, rather than being hashed wrong.
 *
 * Separate from a mismatch: a mismatch means somebody's chain is broken, this
 * means the event was never eligible for one.
 */
export class UnchainableEventError extends Error {
  readonly eventId: string;

  constructor(eventId: string, why: string) {
    super(`event ${eventId} cannot be hashed: ${why}`);
    this.name = 'UnchainableEventError';
    this.eventId = eventId;
  }
}

/**
 * The exact bytes an event contributes to its chain.
 *
 * `JSON.stringify` over an **array of strings**, deliberately, for two reasons
 * that are both about `texto`:
 *
 * - JSON string escaping is spec-defined and total, so no separator can be
 *   forged out of free text. A counter typing a tab, a newline or a `\u001e` into
 *   a note cannot move a field boundary. Do not hand-roll a delimiter format
 *   here; that is the whole reason this is not `fields.join('|')`.
 * - An array, not an object: object key order is only *mostly* insertion order
 *   in JavaScript, and "mostly" is not a hash input.
 *
 * Every field is stringified rather than left to JSON's number formatting.
 * `String(qty)` is JavaScript's shortest round-tripping representation of a
 * double and is deterministic across engines — the same rule
 * `ZEUS_FORMAT.md` §3 relies on. Non-finite quantities are rejected at append
 * (`validateEvent`) rather than hashed as `"NaN"`, and rejected again here,
 * because a chain is the last place a value should be able to arrive that no
 * other value can be distinguished from.
 *
 * Absent optional fields hash as `''`, and so does a field explicitly set to
 * the empty string. That collision is deliberate and harmless: the `kind` is
 * inside the hash, and no kind carries two optional fields whose presence a
 * reader would have to tell apart.
 */
export function canonicalEvent(e: CountEvent): string {
  if (e.counterId === undefined || e.counterId === '') {
    throw new UnchainableEventError(
      e.id,
      'it carries no counterId. P1 events do not have one, and P1 sessions are ' +
        'not migrated onto the server — they stay local, read-only and unchained. ' +
        'Inventing an id here would mint a chain that never existed ' +
        '(docs/MIGRATION-P1-P2.md)',
    );
  }
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) {
    throw new UnchainableEventError(e.id, `seq is ${String(e.seq)}, not a whole number ≥ 0`);
  }
  if ('qty' in e && !Number.isFinite(e.qty)) {
    throw new UnchainableEventError(e.id, `qty is ${String(e.qty)}, which is not finite`);
  }

  return JSON.stringify([
    EVENT_TAG,
    e.id,
    e.sessionId,
    e.counterId,
    String(e.seq),
    e.kind,
    e.idarticulo === null ? '' : String(e.idarticulo),
    'qty' in e ? String(e.qty) : '',
    'retractsEventId' in e ? (e.retractsEventId ?? '') : '',
    'motivo' in e ? (e.motivo ?? '') : '',
    'texto' in e ? e.texto : '',
    e.usuario,
    e.zona,
    e.at,
    e.deviceId,
  ]);
}

/**
 * Where a counter's chain starts.
 *
 * Anchored to `(sessionId, counterId)` rather than being a constant, so that a
 * counter's chain from one session cannot be replayed into another, and two
 * counters in one session cannot share a prefix.
 */
export function genesisHash(sessionId: string, counterId: string): string {
  return sha256Hex(utf8.encode(JSON.stringify([GENESIS_TAG, sessionId, counterId])));
}

/** `sha256Hex(utf8(prevHash + '\u001e' + canonicalEvent(e)))`. */
export function chainHash(prevHash: string, e: CountEvent): string {
  return sha256Hex(utf8.encode(prevHash + SEPARATOR + canonicalEvent(e)));
}

/** One event and where it sits in the chain. */
export interface ChainLink {
  event: CountEvent;
  prevHash: string;
  hash: string;
}

/**
 * Chain a counter's events onto `prevHash`, in `seq` order.
 *
 * Ordered by `seq` and not by `compareEvents`: the chain is one device's own
 * numbering, which is exactly what `seq` is, and the fold's clock-first order
 * would make the chain depend on a clock the whole design avoids depending on.
 *
 * Does not check contiguity — `verifyChain` does, and reports it rather than
 * throwing, because "the chain has a hole in it" is an answer the server has to
 * record (`counters.estado = 'terminado_incompleto'`) rather than an error.
 */
export function chainEvents(prevHash: string, events: readonly CountEvent[]): ChainLink[] {
  const links: ChainLink[] = [];
  let prev = prevHash;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const hash = chainHash(prev, event);
    links.push({ event, prevHash: prev, hash });
    prev = hash;
  }
  return links;
}

/** The chain head after `events`, starting from this counter's genesis. */
export function headHash(
  sessionId: string,
  counterId: string,
  events: readonly CountEvent[],
): string {
  const links = chainEvents(genesisHash(sessionId, counterId), events);
  return links.length === 0 ? genesisHash(sessionId, counterId) : links[links.length - 1].hash;
}

export type ChainVerdict =
  | {
      ok: true;
      /** The chain head. Compare against a `finish` event's `headHash`. */
      head: string;
      /**
       * The highest `seq` in the chain, and `0` when it is empty.
       *
       * Zero rather than `null` because it is the same figure a `finish`
       * manifest carries, and the manifest's empty case *is* `finalSeq = 0`
       * (P2.2 §2a): a counter who was assigned a section, walked over and found
       * it already counted by receiving finishes with nothing behind them. Two
       * spellings of "nothing" on the two sides of the comparison that decides
       * whether a session may be sealed is an off-by-one waiting for the least
       * suspicious person's tablet.
       */
      finalSeq: number;
      count: number;
    }
  | {
      ok: false;
      problem: 'gap' | 'duplicate-seq' | 'foreign-event' | 'unchainable';
      /** Human-readable, and specific enough to act on. */
      detail: string;
      /** The `seq` the problem was found at, when there is one. */
      atSeq: number | null;
    };

/**
 * Is this a complete, gap-free, hash-consistent chain for one counter?
 *
 * The question P2.4 gates sealing on. It answers rather than throws, because
 * every negative answer is a state the server has to record about a counter,
 * not a bug in the request that produced it.
 *
 * **Contiguity is checked from `1`.** A counter's `seq` is allocated by their own
 * device starting at one, so a chain that begins at `7` is a chain missing six
 * events, not a chain with a different origin.
 *
 * One-based, and not by taste. The push protocol resumes from `storedMaxSeq + 1`
 * and the finish manifest states `finish.seq === finalSeq + 1` (P2.2 §1b, §2a);
 * both need a value that means "nothing stored yet", and both spell it `0`.
 * Zero-based numbering would have to spell it `-1` in one place and `null` in
 * the other, and the arithmetic that decides whether a batch is a replay, a gap
 * or a fork is not the place for two spellings of empty.
 */
export function verifyChain(
  sessionId: string,
  counterId: string,
  events: readonly CountEvent[],
): ChainVerdict {
  const genesis = genesisHash(sessionId, counterId);

  for (const event of events) {
    if (event.sessionId !== sessionId || event.counterId !== counterId) {
      return {
        ok: false,
        problem: 'foreign-event',
        detail:
          `event ${event.id} belongs to (${event.sessionId}, ${String(event.counterId)}) ` +
          `and not to (${sessionId}, ${counterId}); a chain is one counter's own numbering`,
        atSeq: Number.isSafeInteger(event.seq) ? event.seq : null,
      };
    }
  }

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const [index, event] of sorted.entries()) {
    if (index > 0 && event.seq === sorted[index - 1].seq) {
      return {
        ok: false,
        problem: 'duplicate-seq',
        detail:
          `events ${sorted[index - 1].id} and ${event.id} both claim seq ${event.seq}. ` +
          'The server enforces `unique (counter_id, seq)` for exactly this reason',
        atSeq: event.seq,
      };
    }
    if (event.seq !== index + 1) {
      return {
        ok: false,
        problem: 'gap',
        detail:
          `seq ${index + 1} is missing: the chain jumps to ${event.seq} at position ` +
          `${index}. ${sorted.length} event(s) received, ${event.seq} expected up ` +
          'to here — the tablet is still holding what falls in the hole',
        atSeq: index + 1,
      };
    }
  }

  let head = genesis;
  try {
    for (const link of chainEvents(genesis, sorted)) head = link.hash;
  } catch (cause) {
    return {
      ok: false,
      problem: 'unchainable',
      detail: cause instanceof Error ? cause.message : String(cause),
      atSeq: null,
    };
  }

  return {
    ok: true,
    head,
    finalSeq: sorted.length === 0 ? 0 : sorted[sorted.length - 1].seq,
    count: sorted.length,
  };
}

/**
 * What a counter's `finish` claims about their own chain.
 *
 * Redundant with the chain, deliberately, and that redundancy is the whole
 * point: it is what lets the server *check* the claim rather than accept it.
 * Absence of data is ambiguous with no connectivity in the bodega — a counter
 * who recorded nothing for an hour and a counter whose tablet is holding 200
 * events in a cold room look identical from the server — so "I am done" has to
 * arrive with something falsifiable attached to it.
 */
export interface FinishManifest {
  /** This counter's last content event, and `0` when they recorded none. */
  finalSeq: number;
  /** This counter's chain head at `finalSeq`; the genesis hash when `finalSeq` is 0. */
  headHash: string;
}

/** One stored link, as the server holds it: a position and the hash at it. */
export interface StoredLink {
  seq: number;
  hash: string;
}

export type ManifestVerdict =
  | { ok: true }
  /** `reason` is what the admin screen prints beside the counter's name. */
  | { ok: false; reason: string };

/**
 * Compact a set of missing sequence numbers into `88–91, 97`.
 *
 * The admin has to act on this — go and find the tablet holding seq 88 to 91 —
 * so it is a range list rather than a count. A count is a number nobody can do
 * anything with.
 */
function missingRanges(missing: readonly number[]): string {
  const parts: string[] = [];
  let start = missing[0];
  let prev = missing[0];
  for (const seq of missing.slice(1)) {
    if (seq === prev + 1) {
      prev = seq;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = seq;
    prev = seq;
  }
  parts.push(start === prev ? String(start) : `${start}–${prev}`);
  return parts.join(', ');
}

/**
 * The four rules a `finish` has to satisfy before a counter is `terminado_confirmado`.
 *
 * All four, separately, because they fail for different reasons and the admin
 * needs to be told which:
 *
 *   1. `finish.seq === finalSeq + 1` — the manifest is about the events *before*
 *      it. A finish that numbers itself anywhere else is describing a chain
 *      other than its own.
 *   2. the finish's own `prevHash` equals the claimed `headHash` — the claim and
 *      the link agree.
 *   3. the server holds every seq `1..finalSeq`, with no hole. This is the rule
 *      that catches the real case: the finish reached the server over the office
 *      wifi and forty content events did not.
 *   4. the stored hash at `finalSeq` equals `headHash` — the chain the server
 *      holds is the chain the device was describing, not merely one of the right
 *      length.
 *
 * Rule 3 alone would pass a chain of the right shape holding somebody else's
 * events; rule 4 alone would pass a chain with a hole in the middle that
 * happened to end where it said. Both, always.
 *
 * `stored` may contain the `finish` itself and anything after it; only
 * `1..finalSeq` is considered, so a counter who reopened and carried on is
 * checked against the manifest they actually wrote.
 */
export function checkFinishManifest(input: {
  sessionId: string;
  counterId: string;
  manifest: FinishManifest;
  /** The `finish` event's own position and the hash of the link before it. */
  finishSeq: number;
  finishPrevHash: string;
  stored: readonly StoredLink[];
}): ManifestVerdict {
  const { manifest, finishSeq, finishPrevHash } = input;

  if (!Number.isSafeInteger(manifest.finalSeq) || manifest.finalSeq < 0) {
    return { ok: false, reason: `el manifiesto declara finalSeq ${String(manifest.finalSeq)}` };
  }
  if (finishSeq !== manifest.finalSeq + 1) {
    return {
      ok: false,
      reason:
        `el finish llegó con seq ${finishSeq} y declara finalSeq ${manifest.finalSeq}; ` +
        `debería ser seq ${manifest.finalSeq + 1}`,
    };
  }
  if (finishPrevHash !== manifest.headHash) {
    return {
      ok: false,
      reason: 'el finish no engancha con la cadena que declara (prevHash ≠ headHash)',
    };
  }

  const bySeq = new Map<number, string>();
  for (const link of input.stored) {
    if (link.seq >= 1 && link.seq <= manifest.finalSeq) bySeq.set(link.seq, link.hash);
  }
  const missing: number[] = [];
  for (let seq = 1; seq <= manifest.finalSeq; seq++) {
    if (!bySeq.has(seq)) missing.push(seq);
  }
  if (missing.length > 0) {
    return { ok: false, reason: `faltan seq ${missingRanges(missing)}` };
  }

  // The empty case is not a special case in the arithmetic, only in where the
  // head comes from: with nothing stored, the head *is* the genesis hash.
  const head =
    manifest.finalSeq === 0
      ? genesisHash(input.sessionId, input.counterId)
      : bySeq.get(manifest.finalSeq)!;
  if (head !== manifest.headHash) {
    return {
      ok: false,
      reason:
        `la cadena guardada termina en ${head.slice(0, 12)}… y el manifiesto declara ` +
        `${manifest.headHash.slice(0, 12)}…`,
    };
  }

  return { ok: true };
}
