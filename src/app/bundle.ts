/**
 * `sesion_<id>.json` — everything needed to recompute the seal without this
 * application (P2.5 §4a).
 *
 * A hash nobody can check is decoration. The acta prints five digests; this is
 * the file that lets somebody who was not there, on a machine that has never
 * heard of this project, arrive at the same five and say so — or say precisely
 * where they diverge.
 *
 * ## Why it lives in `src/app/`
 *
 * It is the one document that pairs the two vocabularies: the chains, which are
 * `src/domain/`, and the catalogue including `rawRow`, which is a Zeus export
 * row and which `src/domain/` deliberately does not hold (`Item` keeps six
 * fields of twenty-four). `src/app/` is where those meet, and it is already
 * where `CatalogueRowWire` is defined.
 *
 * ## Why `rawRow` is in it at all
 *
 * Property 5 of the verifier — «the `.txt` is a correct rendering of the
 * bundle» — cannot be checked against `Item`. The emitted file re-emits 22
 * columns verbatim from `rawRow`, so a bundle without it could confirm the
 * counts and say nothing about the other 90% of every line. Carrying it also
 * makes the bundle a sufficient input to regenerate the file, which is what
 * turns «the hashes match» into «and here is the file they are of».
 *
 * ## Quantities stay strings
 *
 * `existencia`, `costo`, `ultimoConteo` and every event's `cantidad` are text,
 * as they are in the database and on the wire. A JSON number would put each of
 * them through an IEEE-754 double before any verifier saw it, and `21 - 20.8`
 * is `0.20000000000000107` in binary — the exact class of error `cantidad text`
 * exists to prevent (ZEUS_FORMAT.md §3). A verifier is the last place a value
 * should arrive already changed.
 */
import { canonicalJson, type EventWire } from '../domain/index.js';
import type { CatalogueRowWire } from './ingest.js';

/** The bundle's own format tag. A future shape is a different string, not a surprise. */
export const BUNDLE_FORMAT = 'conteo-zeus/bundle/v1';

/** One counter, as the acta and the verifier need them. No token: that is a credential. */
export interface BundleCounter {
  id: string;
  nombre: string;
  /** `asignado | contando | terminado_* | retirado`. */
  estado: string;
  /** The manifest a standing `finish` claimed, or null. */
  finalSeq: number | null;
  headHash: string | null;
  finishReason: string | null;
  fetchedAt: string | null;
  lastServerAt: string | null;
  deviceIds: string[];
  clockSkewMs: number | null;
  forked: boolean;
}

/** One admin action with its chain fields. The wire shape, unmodified. */
export interface BundleAction {
  id: string;
  sessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  usuario: string;
  /** The client's stamp, verbatim, as hashed. */
  at: string;
  serverAt: string;
  prevHash: string;
  hash: string;
}

/** The digests the seal recorded, and the inputs they were taken over. */
export interface BundleSeals {
  sessionHash: string;
  /** Null when the bundle is downloaded from a sealed session that has not exported yet. */
  fileHash: string | null;
  /** What `sessionHash` was computed from, so a verifier can recompute without guessing. */
  contadores: { counterId: string; maxSeq: number; headHash: string }[];
  actionHead: string;
  actionMaxSeq: number;
}

export interface SessionBundle {
  formato: typeof BUNDLE_FORMAT;
  sesion: {
    id: string;
    bodega: string;
    fechaCorte: string;
    nombre: string | null;
    estado: string;
    sourceName: string | null;
    /** The catalogue's digest. Inside `sessionHash`, and the reason it is. */
    sourceHash: string;
    createdAt: string;
    dispatchedAt: string | null;
    sealedAt: string | null;
    exportedAt: string | null;
    /** The triple the file was written under. The acta names it; §7.1 verified one. */
    parameters: {
      countTargetColumn: string;
      uncountedPolicy: string;
      differenceColumn: string;
    };
  };
  catalogo: CatalogueRowWire[];
  contadores: BundleCounter[];
  /** Every event, every chain, in `(counterId, seq)` order. */
  eventos: EventWire[];
  acciones: BundleAction[];
  sellos: BundleSeals;
}

/**
 * The bundle's bytes, canonically.
 *
 * `canonicalJson` rather than `JSON.stringify` — keys sorted, no whitespace,
 * non-safe-integer numbers refused — for the reason the action chain uses it:
 * so that «the same bundle» is a statement about bytes rather than about the
 * object graph a particular runtime happened to build. Two exports of one
 * sealed session are byte-identical, and a verifier can compare files rather
 * than parse trees.
 *
 * It throws on a float, which is the check doing its job: every quantity in
 * here is a string by construction, and a number that is not a whole one means
 * something upstream stopped stringifying and this file would have silently
 * carried a rounded figure into an audit.
 */
export function bundleJson(bundle: SessionBundle): string {
  return canonicalJson(bundle as unknown);
}
