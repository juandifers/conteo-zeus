/**
 * Domain -> Zeus.
 *
 * Turns a folded event log into the counts map the adapter wants, and nothing
 * more. ZEUS_FORMAT.md §9: "The adapter must have no knowledge of *why* a row
 * is uncounted — it receives resolved counts and a policy, nothing more." The
 * waiver reasons, the users, the timestamps all stay in the event log, which is
 * the only place they can live: `Grupo1..5` must stay empty and `Observacion`
 * does not survive the `.txt` at all.
 */
import { writeTxt, type WriteTxtOptions, type ZeusFile } from '../zeus';
import { resolveSession, type CountEvent, type Session } from '../domain';
import { sha256Hex } from '../lib/hash';
import { CatalogueError, catalogueFaults, parseZeusBytes, sourceHashOf } from './importZeus';
import type { PostingParameters } from './parameters';
import { verifyWriteBack } from './verifyWriteBack';

export interface ExportAdjustmentOptions
  extends Pick<WriteTxtOptions, 'countTargetColumn' | 'differenceColumn' | 'numberFormat'> {
  /**
   * The parsed file the session was imported from.
   *
   * The domain threw away `rawRow`, and `rawRow` is what makes the output
   * byte-faithful in the 22 columns we have no business touching — so the file
   * has to come back for the write. It is checked against the session's
   * `sourceHash` rather than trusted.
   */
  file: ZeusFile;
}

/**
 * Build the Zeus `.txt` for a finished count.
 *
 * The counts map is the whole translation (DOMAIN.md §7):
 *
 * - `counted` → the resolved quantity. A count of zero is a real count and
 *   posts as one.
 * - `unchanged` → `existencia`, an explicit no-change. Somebody attested to
 *   this row, so it carries a number that says "unmoved" rather than being
 *   left out.
 * - `untouched` → **omitted**, so `writeTxt`'s reject list is exactly the
 *   untouched set.
 *
 * `uncountedPolicy` is fixed at `'reject'` and is deliberately not exposed.
 * DOMAIN.md §4: the escape hatch is not a flag on this function. Waiving a row means
 * appending an `unchanged` event carrying `usuario`, `zona` and a timestamp.
 * A `'existencia'` policy passed here would post the same bytes with nobody's
 * name on them, which is the difference between a waiver and an omission.
 */
export function exportAdjustment(
  session: Session,
  events: readonly CountEvent[],
  options: ExportAdjustmentOptions,
): Uint8Array {
  const { file, ...writeOptions } = options;

  if (sourceHashOf(file) !== session.sourceHash) {
    throw new Error(
      `this file is not the one session ${session.id} was imported from ` +
        '(sourceHash differs). Posting a count against a different snapshot would ' +
        'write variances computed from balances that are not in the file',
    );
  }

  const resolutions = resolveSession(session, events);
  const counts = new Map<number, number>();
  for (const item of session.items) {
    const resolution = resolutions.get(item.idarticulo);
    if (!resolution) continue; // untouched: omitted, so writeTxt names it
    switch (resolution.state) {
      case 'counted':
        counts.set(item.idarticulo, resolution.qty!);
        break;
      case 'unchanged':
        counts.set(item.idarticulo, item.existencia);
        break;
      case 'untouched':
        break;
    }
  }

  const bytes = writeTxt(file, counts, { ...writeOptions, uncountedPolicy: 'reject' });

  // The write-back check, on the real posting path and not only in a test
  // (verifyWriteBack.ts). It parses what was just emitted and holds it against
  // the file it came from: same articles, same order, every column outside the
  // write set byte-identical, and every count landing as the number the fold
  // produced. It throws rather than returning a verdict, and nothing here
  // catches it — a file that fails this must not exist.
  //
  // Placed after `writeTxt` and before the bytes go anywhere, because the only
  // useful moment for it is the one before somebody has a file in their
  // downloads folder that they believe in.
  verifyWriteBack(file, bytes, counts, {
    countTargetColumn: writeOptions.countTargetColumn,
    uncountedPolicy: 'reject',
  });

  return bytes;
}

/** A generated adjustment: the bytes, and the digest that identifies them. */
export interface Adjustment {
  /** CP850, tab-separated, CRLF. Hand these to a `Blob` unchanged. */
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex. What an `ExportRecord` carries. */
  sha256: string;
}

export type GenerateAdjustmentOptions = Omit<ExportAdjustmentOptions, 'file'>;

/**
 * Generate the adjustment for a session that carries its own source file.
 *
 * The screens call this rather than `exportAdjustment`: a `ZeusFile` is a
 * parsed Zeus record and the UI is not allowed to know what one is
 * (`tests/boundaries.test.ts`). The bytes are re-parsed here, from the copy
 * frozen with the session at import.
 *
 * The digest comes back with the bytes because it identifies *this file*, and
 * the screen has no business computing it — it would need a hash function, and
 * a second implementation of "which bytes did we write" is how an export
 * record ends up describing a file nobody has.
 *
 * It also refuses a session whose catalogue contradicts itself. `importZeusFile`
 * already refuses those, so this can only fire for a session imported before
 * that check existed — which is exactly the session it needs to fire for, since
 * the count on it landed on whatever `idarticulo` shared a line with the name
 * the counter read (ZEUS_FORMAT.md §4.1). The last gate belongs here rather
 * than on the screen: this is the only function in the app that turns a count
 * into bytes an ERP will believe.
 */
export function generateAdjustment(
  session: Session,
  events: readonly CountEvent[],
  options: GenerateAdjustmentOptions = {},
): Adjustment {
  const faults = catalogueFaults(session.items);
  if (faults.length > 0) throw new CatalogueError(faults);
  const bytes = exportAdjustment(session, events, {
    ...options,
    file: parseZeusBytes(requireSource(session)),
  });
  return { bytes, sha256: sha256Hex(bytes) };
}

/**
 * Whether the file frozen with the session still hashes to its `sourceHash`.
 *
 * A precondition on posting, checked before the button enables rather than
 * inside the writer: `exportAdjustment` throws on a mismatch, and a throw at
 * the moment somebody presses `Generar archivo` is a worse way to learn that
 * the snapshot moved than a disabled button that says why.
 *
 * `false` also when there is no source at all — a session imported before the
 * file was kept, which is the same situation from the screen's point of view:
 * this count cannot produce a file.
 */
export function sourceIntact(session: Session): boolean {
  if (!session.source) return false;
  try {
    return sourceHashOf(parseZeusBytes(session.source.bytes)) === session.sourceHash;
  } catch {
    // Unparseable bytes are a mismatch, not a crash: whatever is in there, it
    // is not the file this count was taken against.
    return false;
  }
}

function requireSource(session: Session): Uint8Array {
  if (!session.source) {
    throw new Error(
      `la sesión ${session.id} no guardó el archivo de Zeus del que se importó, ` +
        'así que no se puede generar el ajuste. Vuelve a importar el archivo y ' +
        'cuenta sobre la sesión nueva',
    );
  }
  return session.source.bytes;
}

// --- P2.5: the sealed session's file ----------------------------------------

/**
 * The generated adjustment, with everything the seal record needs about it.
 *
 * The counts are reported back because the acta has to reconcile with the file
 * rather than with a second fold of the same log, and because «298 rows, 12
 * counted, 286 written at their book figure» is the sentence somebody reads
 * before uploading.
 */
export interface SealedAdjustment {
  /** CP850, tab-separated, CRLF. Stored verbatim and served from storage after this. */
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex. `sessions.file_hash`. */
  fileHash: string;
  /** Rows the fold supplied a number for — counted or waived into `unchanged`. */
  resueltas: number;
  /** Rows written from `existencia` because nobody reached them. */
  porPolitica: number;
  filas: number;
}

/**
 * Write the file for a **sealed** session, under the parameters it was counted
 * under, and refuse to return bytes that do not match their source.
 *
 * ## Why this is not `exportAdjustment`
 *
 * The two differ in exactly one place and it is the important one.
 * `exportAdjustment` fixes `uncountedPolicy: 'reject'` — in P1 the only route to
 * posting an incomplete count was a signed `unchanged` event, so a row with no
 * count was a bug and the writer threw on it. That is still the right answer for
 * that path and it has not changed.
 *
 * A sealed P2 session is a different situation. Zeus's format requires every row
 * and has no way to say «we did not look» (ZEUS_FORMAT.md §9), so a bodega where
 * 1 800 of 2 400 rows were never reached still has to produce 2 400 lines. The
 * session's own `uncountedPolicy` — `'existencia'` in the verified triple — is
 * what those lines carry, which writes them as though counted and found to
 * match.
 *
 * **That is a false statement about those rows, and it is made deliberately.**
 * What makes it defensible is not this function; it is that the acta's §8 says
 * so in as many words, that `sinVerificar` on the review screen never falls when
 * rows are waived, and that the bundle carries the events so anybody can see
 * which lines came from a person and which from a policy. A file that carries
 * the truth is not available. A file that carries the fiction *plus a document
 * that names it* is, and that pairing is the whole design of this task.
 *
 * ## `verifyWriteBack` aborts
 *
 * It re-parses the emitted bytes against the source they came from and throws on
 * any mismatch. Nothing here catches it. It is the check that catches the P1
 * defect class — the sheared file that would have posted wrong balances to
 * nearly every row — and there is no version of «export it anyway» that is
 * correct: a file that fails this is not a file whose counts landed on the
 * articles they were taken on.
 */
export function writeAdjustment(
  file: ZeusFile,
  // A `Map` and not a `ReadonlyMap` because `writeTxt` takes one, and
  // `src/zeus/` is frozen for this task (the golden files are what freeze it).
  // Widening the adapter's signature to satisfy a caller is exactly the kind of
  // change the zero-diff rule exists to keep out of a task like this one.
  counts: Map<number, number>,
  parameters: PostingParameters,
): SealedAdjustment {
  const bytes = writeTxt(file, counts, {
    countTargetColumn: parameters.countTargetColumn,
    uncountedPolicy: parameters.uncountedPolicy,
    differenceColumn: parameters.differenceColumn,
  });

  // Before the bytes are stored, hashed, or seen by anybody. The only useful
  // moment for this check is the one before a file exists that somebody
  // believes in.
  verifyWriteBack(file, bytes, counts, {
    countTargetColumn: parameters.countTargetColumn,
    uncountedPolicy: parameters.uncountedPolicy,
  });

  const resueltas = file.items.filter((item) => counts.has(item.idarticulo)).length;
  return {
    bytes,
    fileHash: sha256Hex(bytes),
    resueltas,
    porPolitica: file.items.length - resueltas,
    filas: file.items.length,
  };
}

/**
 * `AJUSTE_<bodega>_<fechaCorte>_<8 primeros del fileHash>.txt`.
 *
 * Zeus probably does not care what the file is called. The person with four
 * `.txt` files in a Downloads folder at five o'clock does, and the hash prefix
 * is what makes «which one did I upload» a question with an answer — it is on
 * the acta and it is the first eight characters of the digest the verifier
 * recomputes.
 *
 * The cutoff's slashes come out: `2026/08/28` is a label in the ERP's own form
 * (ZEUS_FORMAT.md §2) and a filename is not a place for a path separator.
 */
export function adjustmentFilename(
  bodega: string,
  fechaCorte: string,
  fileHash: string,
): string {
  const fecha = fechaCorte.replaceAll('/', '-');
  return `AJUSTE_${bodega}_${fecha}_${fileHash.slice(0, 8)}.txt`;
}
