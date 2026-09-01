/**
 * Product families, derived from `codigo` — and only proposed, never imposed.
 *
 * The Zeus export carries no location data: `ubicacion`, `serial`, `Grupo1..5`
 * and `Observacion` are empty in all 298 rows of the sample, and `lote` and
 * `clasificacion` are the constant `0`. So there is nothing in the file that
 * says where an article is or who should walk to it, and the admin dividing a
 * bodega between five people starts from a flat list of 298 names.
 *
 * `codigo` is not flat, though. It is a hierarchical key — `BBFFNNN`, where
 * `BB` is the bodega and digits 2–3 are a product family — and over bodega 01
 * that split yields eleven coherent groups: 123 dry goods, 54 fruit and veg, 27
 * dairy, and so on down to 5 rows of beef.
 *
 * **The partition is corroborated from an unrelated direction.** All 31 rows
 * carrying `existencia = 0` fall in prefix `11`, and nowhere else — the
 * perishables group already identified in DOMAIN.md §5 by the fact that Zeus
 * books produce at zero between purchases. Two routes to one split is the only
 * reason to trust a structure inferred from one file.
 *
 * **No family list is hardcoded, here or anywhere.** This returns prefixes,
 * counts and example names; the admin reads those and types a label. The eleven
 * names in the documentation are one person's reading of one bodega's article
 * names and are not in the data at all — a second bodega may be numbered
 * differently, or may not be structured this way, which is what the guards
 * below are for. When they fire this returns `null`, meaning "no proposal,
 * partition by hand", and the screen must be able to say that without treating
 * it as an error.
 */
import type { Item } from './types';
import { addDecimal } from '../lib/decimal';
import { bookValue, exposureValue } from './variance';

/** Where the family digits sit in a `codigo` (ZEUS_FORMAT.md §4: `BBFFNNN`). */
const FAMILY_START = 2;
const FAMILY_END = 4;

/** The length the whole scheme depends on. A catalogue of other lengths is not this scheme. */
const CODIGO_LENGTH = 7;

/**
 * Bounds on a *useful* proposal, not on a valid one.
 *
 * Under two groups there is nothing to divide. Over thirty, the admin is being
 * handed a list longer than the counters they have, which is worse than the
 * flat catalogue they started with. Both are "this bodega is not numbered the
 * way bodega 01 is", said in the only terms this function can see.
 */
const MIN_GROUPS = 2;
const MAX_GROUPS = 30;

/**
 * Above this share of the rows in one group, the split has not split anything.
 *
 * Bodega 01's largest is 123 of 298 — 41% — so this is not near the sample.
 * A catalogue where one prefix holds 90% of the rows is a catalogue whose
 * second digit pair means something other than a family.
 */
const DOMINANT = 0.8;

/** How many names go on screen beside a group before the admin has to expand it. */
const SAMPLE_NAMES = 5;

/**
 * One proposed family: what it is, how big, what it is worth, what is in it.
 *
 * Both money figures, because they answer different questions and this is the
 * one place the difference bites hardest. `valor` is the accounting figure.
 * `exposicion` is DOMAIN.md §5's estimate of what an uncounted row might
 * actually be holding — and the `11` group is 54 rows of which **31 are booked
 * at zero**, so ranking families by `valor` would put the fresh-produce section
 * near the bottom of the list and send the last counter there.
 */
export interface FamilyGroup {
  /** `codigo[2:4]`, the two digits the group is. A string: `'09'` is not `9`. */
  prefix: string;
  /** Every article in the group, in catalogue order. */
  idarticulos: number[];
  /** `idarticulos.length`, named because that is what goes on the screen. */
  rows: number;
  /** Σ `existencia × costo` — the accounting figure. */
  valor: number;
  /** Σ `exposureValue` — what the group might be holding (DOMAIN.md §5). */
  exposicion: number;
  /** Up to five distinct `nombre`s, in catalogue order, so the prefix means something. */
  ejemplos: string[];
}

/** The `codigo` digits an item's family is. Exported so the UI can group without re-deriving. */
export function familyPrefix(codigo: string): string {
  return codigo.slice(FAMILY_START, FAMILY_END);
}

/**
 * A proposed partition of the catalogue, or `null` when there is not one.
 *
 * `null` is a real answer and not a failure: it means the guards say this
 * catalogue is not numbered the way the derivation assumes, and the admin
 * should build sections by hand. The three conditions are listed at the
 * constants above.
 */
export function deriveFamilies(items: readonly Item[]): FamilyGroup[] | null {
  if (items.length === 0) return null;

  // Uniform length first. A catalogue mixing 7- and 8-character codes is not
  // one where `codigo[2:4]` means the same thing on every row, and slicing it
  // anyway would produce groups that look plausible and are not.
  //
  // ZEUS_FORMAT.md §7.5: bodega 22 stores 8-character codes, so this is a
  // condition a real export reaches, not a defensive branch.
  if (items.some((item) => item.codigo.length !== CODIGO_LENGTH)) return null;

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const prefix = familyPrefix(item.codigo);
    const bucket = groups.get(prefix);
    if (bucket) bucket.push(item);
    else groups.set(prefix, [item]);
  }

  if (groups.size < MIN_GROUPS || groups.size > MAX_GROUPS) return null;
  for (const bucket of groups.values()) {
    if (bucket.length > items.length * DOMINANT) return null;
  }

  return [...groups]
    .map(([prefix, bucket]) => ({
      prefix,
      idarticulos: bucket.map((item) => item.idarticulo),
      rows: bucket.length,
      valor: bucket.reduce((total, item) => addDecimal(total, bookValue(item)), 0),
      exposicion: bucket.reduce((total, item) => addDecimal(total, exposureValue(item)), 0),
      ejemplos: [...new Set(bucket.map((item) => item.nombre))].slice(0, SAMPLE_NAMES),
    }))
    // Largest first, ties broken on the prefix so the order is total and the
    // screen does not reshuffle between two renders of the same catalogue.
    .sort((a, b) => b.rows - a.rows || a.prefix.localeCompare(b.prefix));
}
