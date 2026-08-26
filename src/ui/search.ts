/**
 * Local search over a session's items.
 *
 * Everything here is pure and synchronous. 298 rows fit in memory many times
 * over, so the repository is never consulted to search — a person walking a
 * shelf types three letters and expects the list before their finger leaves
 * the key, and IndexedDB on a cheap Android tablet does not promise that.
 *
 * Ranking matters more than matching: three letters typically return a dozen
 * rows, and the counter picks by glancing, not by reading.
 */
import type { Item } from '../domain';

/**
 * Fold accents and `ñ`, then uppercase.
 *
 * Nobody types `AJÍ`, and nobody types `ÑAME` either — a tablet keyboard makes
 * both awkward and gloves make it worse. NFD splits a letter from its mark and
 * the range below is exactly the combining-mark block, so `Í` becomes `I` and
 * `Ñ` becomes `N` without a lookup table.
 */
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

/** Whether the character before `offset` ends a word — digits count as letters. */
function atWordStart(blob: string, offset: number): boolean {
  if (offset === 0) return true;
  return !/[0-9A-Z]/.test(blob[offset - 1]);
}

function atWordEnd(blob: string, end: number): boolean {
  if (end >= blob.length) return true;
  return !/[0-9A-Z]/.test(blob[end]);
}

/**
 * One item, prepared for matching.
 *
 * `blob` is `nombre presentacion codigo` as a single normalised string, so
 * `pan 500` narrows to the `NATIPAN X 500 GRS` rows without the caller having
 * to say which field each token belongs to. The concatenation order is also
 * the rank order: an earlier match offset means a match in the name rather
 * than in the packaging, which is what the person was looking at.
 */
export interface IndexedItem {
  item: Item;
  /** Position in the file. Shelf order, and the tie-break of last resort. */
  ord: number;
  blob: string;
}

export type MatchTier = 'prefix' | 'partial';

export interface SearchHit {
  item: Item;
  ord: number;
  tier: MatchTier;
}

export function buildIndex(items: readonly Item[]): IndexedItem[] {
  return items.map((item, ord) => ({
    item,
    ord,
    blob: normalise(`${item.nombre} ${item.presentacion} ${item.codigo}`),
  }));
}

/** Split a query into normalised tokens. Multiple tokens are ANDed. */
export function tokenize(query: string): string[] {
  return normalise(query).split(/\s+/).filter((token) => token.length > 0);
}

interface TokenMatch {
  /** Offset of the occurrence we rank on. */
  offset: number;
  /** The occurrence begins a word. */
  prefix: boolean;
  /** The occurrence is a whole word. */
  whole: boolean;
}

/**
 * Find the best occurrence of `token` in `blob`, or `null`.
 *
 * "Best" is: a whole word beats a word prefix beats a mid-word substring, and
 * among equals the earliest wins. The distinction is the whole point of the
 * two tiers — `EMPANADA DE MAIZ CARNE` genuinely contains `pan`, and a counter
 * looking for bread should not have to read past it.
 */
function bestMatch(blob: string, token: string): TokenMatch | null {
  let best: TokenMatch | null = null;
  for (let from = 0; ; ) {
    const offset = blob.indexOf(token, from);
    if (offset === -1) break;
    const prefix = atWordStart(blob, offset);
    const whole = prefix && atWordEnd(blob, offset + token.length);
    const candidate: TokenMatch = { offset, prefix, whole };
    if (best === null || rankMatch(candidate) < rankMatch(best)) best = candidate;
    if (best.whole && best.offset === 0) break;
    from = offset + 1;
  }
  return best;
}

/** Lower is better. Quality first, then position. */
function rankMatch(match: TokenMatch): number {
  const quality = match.whole ? 0 : match.prefix ? 1 : 2;
  return quality * 100_000 + match.offset;
}

/**
 * Rank one item against one query.
 *
 * The sort key, in order:
 *
 * 1. **tier** — every token starting a word, or not. Rendered as two visually
 *    separated groups, so the boundary is a thing the counter can see rather
 *    than a weight they have to infer.
 * 2. **the first token's offset** — the first thing typed is the thing they
 *    were thinking of, so `PAN TAJADO` sorts above `HARINA PAN AMARILLA`.
 * 3. **whole word before prefix** — `PAN PERRO` above `PANCETA SV`.
 * 4. **nombre, presentacion, ord** — alphabetical, then file order. Arbitrary
 *    but *stable*: a list that reshuffles between two identical searches is a
 *    list nobody learns the shape of.
 */
interface Scored extends SearchHit {
  firstOffset: number;
  allWhole: boolean;
}

function score(entry: IndexedItem, tokens: string[]): Scored | null {
  const matches: TokenMatch[] = [];
  for (const token of tokens) {
    const match = bestMatch(entry.blob, token);
    if (!match) return null;
    matches.push(match);
  }
  const tier: MatchTier = matches.every((match) => match.prefix) ? 'prefix' : 'partial';
  return {
    item: entry.item,
    ord: entry.ord,
    tier,
    firstOffset: matches[0].offset,
    allWhole: matches.every((match) => match.whole),
  };
}

const TIER_ORDER: Record<MatchTier, number> = { prefix: 0, partial: 1 };

export function searchItems(index: readonly IndexedItem[], query: string): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: Scored[] = [];
  for (const entry of index) {
    const hit = score(entry, tokens);
    if (hit) scored.push(hit);
  }

  scored.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      a.firstOffset - b.firstOffset ||
      Number(b.allWhole) - Number(a.allWhole) ||
      a.item.nombre.localeCompare(b.item.nombre, 'es') ||
      a.item.presentacion.localeCompare(b.item.presentacion, 'es') ||
      a.ord - b.ord,
  );

  return scored.map(({ item, ord, tier }) => ({ item, ord, tier }));
}

/** Width of a Zeus `codigo` (ZEUS_FORMAT.md §3), used to pad a scanned one. */
const CODIGO_WIDTH = 7;

/**
 * Group a session's items by `codigo`, in file order.
 *
 * One `codigo` covers up to five presentations, each with its own balance
 * (ZEUS_FORMAT.md §4). 188 of 232 codes have exactly one, which is why inline
 * entry is the default path — but the other 44 are the reason entry can never
 * be *only* inline.
 */
export function groupByCodigo(items: readonly Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const group = groups.get(item.codigo);
    if (group) group.push(item);
    else groups.set(item.codigo, [item]);
  }
  return groups;
}

export interface EnterTarget {
  codigo: string;
  /** Every presentation under that codigo, in file order. */
  items: Item[];
  /** The presentation to open on. */
  active: Item;
  /** How the target was chosen — the scanner path, or the ranking. */
  via: 'codigo' | 'ranking';
}

/**
 * What Enter selects: the exact `codigo` match if there is one, else the top
 * result.
 *
 * This is the keyboard-wedge hook. An industrial scanner is a keyboard that
 * types a code and presses Enter, so honouring an exact code here means the
 * scanning workflow arrives later with no native code and no change to this
 * screen. A leading zero is restored first, because a wedge configured to
 * strip them is the normal case rather than the exception.
 *
 * When the code covers several presentations there is no single item to
 * select, so the group opens on its **first row in file order** — deliberately
 * not on the top-ranked row, which is alphabetical and would route a scan to
 * one of five balances by accident. That is ZEUS_FORMAT.md §4's failure mode
 * with a scanner attached to it.
 */
export function resolveEnter(
  index: readonly IndexedItem[],
  groups: ReadonlyMap<string, Item[]>,
  query: string,
): EnterTarget | null {
  const digits = query.trim();
  if (/^\d{1,7}$/.test(digits)) {
    const codigo = digits.padStart(CODIGO_WIDTH, '0');
    const items = groups.get(codigo);
    if (items && items.length > 0) {
      return { codigo, items: items.slice(), active: items[0], via: 'codigo' };
    }
  }

  const [top] = searchItems(index, query);
  if (!top) return null;
  const items = groups.get(top.item.codigo) ?? [top.item];
  return { codigo: top.item.codigo, items: items.slice(), active: top.item, via: 'ranking' };
}
