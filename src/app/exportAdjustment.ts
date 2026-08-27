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

  return writeTxt(file, counts, { ...writeOptions, uncountedPolicy: 'reject' });
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
