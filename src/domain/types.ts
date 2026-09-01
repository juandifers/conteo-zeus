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
  /**
   * Which counter this is anchored to — **not** `usuario`.
   *
   * A name is a label a person typed into a box; two counters can type the
   * same one, and one counter can retype theirs differently after lunch. The
   * id is what the hash chain is built over (chain.ts) and what the server's
   * `unique (counter_id, seq)` constraint keys on, so it has to be an identity
   * rather than a label.
   *
   * Optional because **P1 events do not have one**. Those sessions stay local,
   * read-only and unchained; `canonicalEvent` refuses to hash an event without
   * it rather than inventing one, which would mint a chain that never existed.
   * See docs/MIGRATION-P1-P2.md.
   */
  counterId?: string;
  /**
   * The primary key (ZEUS_FORMAT.md §4).
   *
   * `null` only on the three session-scoped kinds — `note` (when the note is
   * not about one article), `finish` and `reopen`. Every kind that asserts
   * something about an item's stock narrows this back to `number`, so the fold
   * never has to ask.
   */
  idarticulo: number | null;
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
  idarticulo: number;
  qty: number;
}

/** Add to the running value: what one tap in tally mode means. */
export interface AddCountEvent extends CountEventBase {
  kind: 'add';
  idarticulo: number;
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
  idarticulo: number;
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
  idarticulo: number;
  /**
   * The event this withdraws. Absent only on events written by P1, whose
   * whole-item semantics are preserved for them and for them alone.
   *
   * **Why this became event-scoped.** Under one counter, "return the item to
   * untouched" is right. Under several it is a data-loss bug: Ana retracting
   * her own mis-tap on article 4471 would silently discard Luis's count of the
   * same article, and neither of them would see a mark that it happened.
   *
   * Scoped retraction is **order-independent** — it names its target rather
   * than relying on position — which is what keeps merging several offline
   * logs a sort rather than a conflict resolution. No event kind may be
   * introduced that breaks this.
   */
  retractsEventId?: string;
}

/**
 * A remark. The one place an observation can go (DOMAIN.md §4).
 *
 * It exists because there is physically nowhere else to put it: `Observacion`
 * is dropped in the `.txt` and `Grupo1..5` are forbidden by ZEUS_FORMAT.md §9,
 * so an article found on the floor that is not in the catalogue can be recorded
 * in the log or not at all.
 *
 * Asserts nothing about stock, so it folds to nothing. `idarticulo` is `null`
 * when the note is not about one article.
 */
export interface NoteEvent extends CountEventBase {
  kind: 'note';
  /** Control characters are rejected at append — see `validateEvent`. */
  texto: string;
  idarticulo: number | null;
}

/**
 * "I am done" — and, crucially, a **manifest** rather than a bare marker.
 *
 * With no connectivity in the bodega, a server cannot distinguish a counter who
 * recorded nothing for an hour from a counter whose tablet is holding 200
 * queued events in a cold room. Absence of data looks identical either way, so
 * a bare marker would let a session be sealed over a chain with a hole in it.
 *
 * `finalSeq` and `headHash` let the server verify it holds a complete,
 * gap-free, hash-consistent chain before believing the claim. That check is
 * what P2.4 gates sealing on — and it is why `counters.estado` has no
 * `terminado_local`: the server knows only what arrived.
 */
export interface FinishEvent extends CountEventBase {
  kind: 'finish';
  idarticulo: null;
  /** This counter's last content event. */
  finalSeq: number;
  /** This counter's chain head at that seq (chain.ts). */
  headHash: string;
}

/** Withdraws a `finish`: this counter is counting again. */
export interface ReopenEvent extends CountEventBase {
  kind: 'reopen';
  idarticulo: null;
}

/**
 * The append-only event log.
 *
 * Nothing in this codebase updates or deletes a `CountEvent`. Correcting a
 * count means appending another one; the fold decides which wins. That is what
 * makes offline merge a sort rather than a conflict resolution.
 */
export type CountEvent =
  | SetCountEvent
  | AddCountEvent
  | UnchangedEvent
  | RetractEvent
  | NoteEvent
  | FinishEvent
  | ReopenEvent;

/** The events that carry a quantity. */
export type QuantityEvent = SetCountEvent | AddCountEvent;

/**
 * The kinds that are about the session rather than about one item.
 *
 * `idarticulo` may be `null` on exactly these. `resolveAll` drops them before
 * grouping, because a fold keyed on the primary key has no bucket for an event
 * that has no key (ZEUS_FORMAT.md §4).
 */
export type SessionScopedEvent = NoteEvent | FinishEvent | ReopenEvent;

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
  /**
   * `retractsEventId` absent is the P1 whole-item withdrawal, kept so that a
   * P1 log folds to the same numbers after the upgrade as before it. New code
   * naming a target is the rule; see `RetractEvent`.
   */
  | { kind: 'retract'; retractsEventId?: string }
  | { kind: 'note'; texto: string; idarticulo: number | null }
  | { kind: 'finish'; finalSeq: number; headHash: string }
  | { kind: 'reopen' };

/**
 * What a **P2 counter** may append. The same union, minus one thing.
 *
 * `retract` requires `retractsEventId`. That is the gate P2.2 opens with, and
 * it is a compile error rather than a review convention because the next person
 * to add a withdrawal button will not have read the document that explains it:
 *
 *     Ana y Luis cuentan secciones distintas.
 *     Por error Ana registra 5 en el artículo 4471, que es de Luis.
 *
 *       Ana  add 5      (4471)
 *       Luis add 8      (4471)   ← su sección, su conteo real
 *       Ana  retract    (4471)   ← sin scope: "este artículo vuelve a untouched"
 *
 *       fold → untouched.  Los 8 de Luis desaparecieron.
 *
 * Nothing catches it downstream. The chain is intact — nothing was tampered
 * with. The export is well-formed. `verifyWriteBack` passes, because the file
 * faithfully reflects a fold that is quietly wrong. It surfaces as a variance
 * nobody can explain, weeks later.
 *
 * So the whole-item withdrawal is not merely discouraged in the P2 path, it is
 * unspellable there. `CountEventDraft` keeps it for the P1 app, whose sessions
 * have one counter and whose logs must fold to the same numbers after the
 * upgrade as before it (docs/MIGRATION-P1-P2.md).
 */
export type CounterEventDraft =
  | { kind: 'set'; qty: number }
  | { kind: 'add'; qty: number }
  | { kind: 'unchanged'; motivo?: string }
  | { kind: 'retract'; retractsEventId: string }
  | { kind: 'note'; texto: string; idarticulo: number | null }
  | { kind: 'finish'; finalSeq: number; headHash: string }
  | { kind: 'reopen' };

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
