/**
 * The counting domain — docs/DOMAIN.md.
 *
 * This module owns the vocabulary of a physical count: what an item is, what
 * a counter did, and what a session is. It is deliberately ignorant of Zeus.
 *
 * **Nothing under src/domain/ may import from src/zeus/, not even a type.**
 * Zeus is one way to get inventory in and out; when that channel becomes ODBC,
 * src/zeus/ is replaced and everything here stays as it is. The mapping between
 * the two vocabularies lives in src/app/, which is the only place they meet.
 */

/**
 * One countable line.
 *
 * A subset of the Zeus record, keeping only what a person standing in a
 * storeroom needs plus what the variance report needs. No `rawRow`, no
 * `Grupo1..5`, no `conteo1..3` — those are wire concerns.
 *
 * `idarticulo` is the primary key, never `codigo`: one `codigo` covers several
 * presentations, each with its own balance (ZEUS_FORMAT.md §4). Anything keyed
 * on `codigo` silently merges distinct products.
 */
export interface Item {
  idarticulo: number;
  /** 7-char zero-padded catalogue code. NOT unique (ZEUS_FORMAT.md §4) — informational. */
  codigo: string;
  nombre: string;
  presentacion: string;
  /** What the ERP believes is on hand. Decimal: much of the catalogue sells by weight. */
  existencia: number;
  /**
   * Quantity recorded at the previous count, or `null` if there was none.
   *
   * The only prior available, and of unknown age — DOMAIN.md §5 uses it to
   * estimate exposure, never to value anything. Deliberately not named after
   * the column it comes from: a Zeus column name in the domain is the first
   * step to the domain knowing what a column is.
   */
  ultimoConteo: number | null;
  /**
   * Unit cost at full precision — the full-precision column, not the one Excel
   * truncates to 11 characters (ZEUS_FORMAT.md §3).
   *
   * DOMAIN.md §5 puts a waived value in front of somebody who signs it off;
   * the truncation has no business being in that figure.
   */
  costo: number;
}

/**
 * Whether an item was verified — DOMAIN.md §2.
 *
 * Three states, and a quantity of zero is not one of them. "Counted zero" is a
 * `counted` item whose variance class is `shortage`; an empty shelf confirmed
 * empty is `counted` with class `none`. A single enum spanning both merges
 * them, and every UI that groups by state inherits the merge.
 */
export type ItemState = 'counted' | 'unchanged' | 'untouched';

/**
 * Fields every event carries, whatever its kind.
 *
 * `at` / `deviceId` / `seq` exist for merge, not for display: stage 2 merges
 * logs from several offline devices whose clocks disagree, and the fold has to
 * order them the same way on every device (see fold.ts).
 */
export interface CountEventBase {
  /** UUID, generated on the device. Events are created offline, so no server can allocate it. */
  id: string;
  sessionId: string;
  /** The primary key (ZEUS_FORMAT.md §4). */
  idarticulo: number;
  /** Who. DOMAIN.md §4: a waiver is attributable or it is not a waiver. */
  usuario: string;
  /** Where in the warehouse. Destined for the `ubicacion` column, empty in Zeus today. */
  zona: string;
  /**
   * ISO-8601 instant, normalised to UTC: `2026-08-25T14:03:11.412Z`.
   *
   * The fold compares it as a string, which is chronological only for that
   * exact shape (DOMAIN.md §3). The type cannot say so, so `appendEvent`
   * validates it — see time.ts.
   */
  at: string;
  /** Stable per install. Ties are broken on it, so two devices never fold differently. */
  deviceId: string;
  /** Monotonic per device. Orders events a coarse clock stamps identically. */
  seq: number;
}

/** Replace the running value: what a keypad entry means. */
export interface SetCountEvent extends CountEventBase {
  kind: 'set';
  qty: number;
}

/** Add to the running value: what one tap in tally mode means. */
export interface AddCountEvent extends CountEventBase {
  kind: 'add';
  qty: number;
}

/**
 * "I looked, nothing moved" — an attributable waiver (DOMAIN.md §4).
 *
 * Carries **no quantity**, deliberately. It is not a count of `existencia`; it
 * is a person asserting they did not need to count. The distinction survives
 * all the way to the variance report, which reports no variance for these
 * rather than a zero variance.
 */
export interface UnchangedEvent extends CountEventBase {
  kind: 'unchanged';
  motivo?: string;
}

/**
 * "That was a mistake, nobody counted this" — a withdrawal (DOMAIN.md §3).
 *
 * Exists because the other three kinds are one-way: `set`, `add` and
 * `unchanged` all move an item into a state that posts, so without this one a
 * mis-tap on the wrong row is a write-off that can only be *overwritten* with a
 * number nobody counted. Its fold effect is "as of this event, this item is
 * untouched again".
 *
 * Carries no quantity and no `motivo`. It is still an attributable event, so
 * the log reads "counted 1 at 14:32, withdrawn at 14:35" — nothing is deleted,
 * and the item goes back to blocking a post, which is the point: a withdrawn
 * count should force somebody to deal with it rather than quietly resolving.
 */
export interface RetractEvent extends CountEventBase {
  kind: 'retract';
}

/**
 * The append-only event log.
 *
 * Nothing in this codebase updates or deletes a `CountEvent`. Correcting a
 * count means appending another one; the fold decides which wins. That is what
 * makes offline merge a sort rather than a conflict resolution.
 */
export type CountEvent = SetCountEvent | AddCountEvent | UnchangedEvent | RetractEvent;

/** The events that carry a quantity. */
export type QuantityEvent = SetCountEvent | AddCountEvent;

/**
 * An event minus its identity — what to append, before anything stamps it.
 *
 * `undoLast` returns one of these rather than a finished `CountEvent` because
 * it cannot produce the other half: `id` comes from the device, `at` from the
 * clock, and `seq` is allocated by the store in the same transaction that
 * writes the event (DOMAIN.md §6). A pure function of a log cannot know any of
 * the three, and pretending otherwise would mean the domain minting sequence
 * numbers the store has to overwrite.
 */
export type CountEventDraft =
  | { kind: 'set'; qty: number }
  | { kind: 'add'; qty: number }
  | { kind: 'unchanged'; motivo?: string }
  | { kind: 'retract' };

/**
 * The file a session was imported from, kept whole.
 *
 * **Opaque here.** The domain never reads a byte of it; it holds the file so
 * that generating an adjustment does not depend on somebody still having the
 * original on the machine they are posting from. Two things need it back:
 * `sourceHash` can only be *re-checked* against bytes, and the 22 columns the
 * writer has no business touching are re-emitted from the source row rather
 * than reconstructed.
 *
 * `name` is what the file arrived as. It is the default filename for the
 * adjustment, because matching the habit the hotel already has beats inventing
 * a convention they would have to learn.
 */
export interface SessionSource {
  name: string;
  bytes: Uint8Array;
}

/**
 * One count of one warehouse at one cutoff.
 *
 * `items` is frozen at import. Re-importing a Zeus export creates a **new**
 * session rather than mutating this one: the balances a count was taken
 * against are part of the evidence, and a session whose `existencia` changed
 * underneath its events cannot be reconciled afterwards.
 */
export interface Session {
  id: string;
  /** Zero-padded warehouse code, a string. */
  bodega: string;
  /** Cutoff label in the ERP's own `YYYY/MM/DD` textual form — no timezone meaning. */
  fechaCorte: string;
  /** Hash of the imported bytes, so a posting can be tied to the file it came from. */
  sourceHash: string;
  /** ISO-8601 instant. */
  createdAt: string;
  /**
   * The imported file itself. Optional because a session can be constructed
   * without one — in a test, or by a future channel that is not a file at all
   * — and because sessions imported before this existed do not have one. An
   * adjustment cannot be generated without it, and the screen says so rather
   * than failing at the moment somebody presses the button.
   */
  source?: SessionSource;
  items: readonly Item[];
}

/**
 * A session without its items — what a session list needs.
 *
 * Without its source, too: the file is tens of kilobytes and a list that
 * carried it would read every one of them to draw a row of names.
 */
export type SessionMeta = Omit<Session, 'items' | 'source'> & {
  itemCount: number;
  /** The imported file's name, kept in the list so a session is recognisable. */
  sourceName?: string;
};

/**
 * One adjustment file, generated (DOMAIN.md §4).
 *
 * Not a boolean on the session. People export, count some more, and export
 * again, and the useful question afterwards is *which* file the ERP received —
 * so this carries the digest of the exact bytes and the state of the count at
 * the moment they were written. Two records with the same `sha256` are two
 * downloads of one file; two with different digests are two different files,
 * and something happened in between that can be named.
 *
 * It is a record of an act, not of an intention: it is written after the bytes
 * exist, and it says nothing about whether anybody uploaded them. The app
 * cannot know that.
 */
export interface ExportRecord {
  id: string;
  sessionId: string;
  /** Normalised UTC instant, like an event's `at`. */
  at: string;
  /** Who generated it. The supervisor signing off, not the counter. */
  usuario: string;
  /** The name it was offered under. Whatever the person typed. */
  filename: string;
  /** SHA-256 of the bytes written, lowercase hex. */
  sha256: string;
  byteLength: number;
  /** Verification counts at that moment — the count this file is of. */
  counts: Record<ItemState, number>;
  /**
   * Book-value coverage when the bytes were written, `0..1` (DOMAIN.md §5).
   *
   * Recorded next to the counts because the counts alone cannot answer "was
   * this a real count": 250 of 298 rows is a different file depending on
   * whether those 250 carry 95% of the bodega's value or 30% of it.
   */
  coberturaValor: number;
  /** Row coverage when the bytes were written, `0..1`. Diverges from the above. */
  coberturaFilas: number;
  netVarianceValue: number;
  grossVarianceValue: number;
  /** How many events the log held. Cheap way to say "and then twelve more happened". */
  eventCount: number;
}
