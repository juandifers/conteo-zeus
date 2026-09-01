/**
 * Session summary — the numbers a supervisor sees before deciding to post
 * (DOMAIN.md §5, §6).
 */
import { addDecimal } from '../lib/decimal.js';
import { resolveAll, type Resolution } from './fold.js';
import { bookValue, exposureValue, itemVariance, type Variance } from './variance.js';
import type { CountEvent, Item, ItemState, Session } from './types.js';

/** How many unverified items are named alongside the waived total, by default. */
const DEFAULT_TOP_N = 10;

export interface ItemSummary {
  item: Item;
  state: ItemState;
  /** Present only for `counted`. */
  qty?: number;
  /** `null` for `unchanged` and `untouched` — not zero (see variance.ts). */
  variance: Variance | null;
}

export interface UnverifiedItem {
  item: Item;
  /** `existencia x costo` — book value. What finance is owed (§5). */
  valor: number;
  /** `max(existencia, ultimoConteo) x costo` — what the row might be holding (§5). */
  exposicion: number;
}

/**
 * A set of items that nobody counted, measured two ways (DOMAIN.md §5).
 *
 * The measures are the same two as ever — book value and exposure. What this
 * type adds is that a figure is meaningless without its **scope**: the same
 * arithmetic over `untouched` and over `untouched u unchanged` answers two
 * different questions, and §5 used to leave the scope implicit in a name.
 */
export interface Exposure {
  /** How many items are in this set. */
  items: number;
  /** `sum(existencia x costo)`. The accounting figure. */
  valor: number;
  /** `sum(max(existencia, ultimoConteo) x costo)`. An estimate, never a valuation. */
  exposicion: number;
}

/**
 * How much of the bodega was actually counted — by money and by rows.
 *
 * Only `counted` items count towards it. A waiver is a decision *not* to
 * count, so it moves nothing here; that is the whole difference between
 * coverage and completeness, and `canPost` already answers completeness.
 *
 * Both fractions are reported because they come apart, and the gap between
 * them is the useful reading: 40% of the rows carrying 90% of the value is a
 * good afternoon's work, and 90% of the rows carrying 40% of the value means
 * somebody counted the easy shelves.
 */
export interface Coverage {
  /** Book value of `counted` items. */
  valor: number;
  /** Book value of every item in the session, whatever its state. */
  valorTotal: number;
  /** `valor / valorTotal`, `0..1`. Zero when the whole book is worth nothing. */
  fraccionValor: number;
  /** How many items are `counted`. */
  filas: number;
  filasTotal: number;
  /** `filas / filasTotal`, `0..1`. */
  fraccionFilas: number;
}

export interface SessionSummary {
  itemCount: number;
  /** How many items are in each state. The three always sum to `itemCount`. */
  counts: Record<ItemState, number>;
  /**
   * Signed sum of `valorVariance` over counted items — the P&L hit.
   *
   * Net and gross answer different questions and both belong on the screen: a
   * net near zero can hide a shelf where half the lines are wrong in each
   * direction, which is a control failure even when the money nets out.
   */
  netVarianceValue: number;
  /** Sum of `materialidad` — how much value moved in total, direction ignored. */
  grossVarianceValue: number;
  /** Every item, in session order. */
  items: ItemSummary[];
  /** Counted items only, by `materialidad` descending, `idarticulo` breaking ties. */
  byMateriality: ItemSummary[];
  /**
   * Counted at exactly zero against a non-zero book figure — derived, per §2.
   *
   * Two things at once, which is why they get their own list rather than a
   * position in the ranking: each one writes off a whole line, and each one is
   * what a mis-tap produces. A supervisor should read them as a set and by
   * name, because "sixty rows moved" and "sixty rows went to zero" are not the
   * same file.
   *
   * A zero-book row counted at zero is **not** one of these. Nothing is lost —
   * the ERP already believed the shelf was empty and somebody confirmed it.
   * Ordered like `byMateriality`: by what each one costs.
   */
  writeOffs: ItemSummary[];
  /** `sum(materialidad)` over `writeOffs` — the whole book value being written off. */
  writeOffValue: number;
  /**
   * Over **untouched** items — what is still to do (§5).
   *
   * The work figure. It falls as a count progresses *and* when a supervisor
   * signs a waiver, because both remove an item from the list of things
   * somebody still has to walk to. That makes it the right number to rank the
   * count route on and the wrong number to sign off against.
   */
  pendiente: Exposure;
  /**
   * Over **untouched u unchanged** items — what nobody counted (§5).
   *
   * The evidence figure, and the one the review screen and the posting
   * confirmation lead with. Its property is that it **falls only when an item
   * is genuinely counted**: waiving moves a row from `untouched` to
   * `unchanged`, and both are inside this scope, so signing two hundred
   * waivers does not move it by a peso. Which is correct — a waiver accepts
   * the exposure, it does not retire it.
   */
  sinVerificar: Exposure;
  /** How much of the bodega was counted, by money and by rows. */
  cobertura: Coverage;
  /** The highest **book value** untouched items, named, descending. Capped at `topN`. */
  pendienteTop: UnverifiedItem[];
  /**
   * Every untouched item by **exposure**, descending.
   *
   * Not capped, because this is the count route: ranking the walk by book value
   * sends everyone past the produce cooler last (§5). `pendienteTop` is a
   * display list; this is a work list, and it is scoped to `pendiente` for
   * that reason: a waived row is not somewhere anybody still has to go.
   */
  byExposicion: UnverifiedItem[];
  /** True when no item is `untouched`. §2: only the other two states may post. */
  canPost: boolean;
}

export interface SummaryOptions {
  /** How many unverified items to name in `pendienteTop`. Default 10. */
  topN?: number;
}

/**
 * Resolve every item in a session against its event log.
 *
 * Items with no events resolve to `untouched`; the map returned by the fold is
 * keyed on `idarticulo`, so an item nobody opened simply misses.
 */
export function resolveSession(
  /**
   * The session. Typed to the two fields this reads so P2.4's review can fold a
   * catalogue it holds without a `SessionSource` or a `fechaCorte` — the wire
   * shape the admin screens receive is not a `Session`, and inventing one to
   * satisfy a parameter would be a second, emptier copy of the real thing.
   */
  session: Pick<Session, 'id' | 'items'>,
  events: readonly CountEvent[],
): Map<number, Resolution> {
  const known = new Set(session.items.map((item) => item.idarticulo));
  for (const event of events) {
    if (event.sessionId !== session.id) {
      throw new Error(
        `event ${event.id} belongs to session ${event.sessionId}, not ${session.id}`,
      );
    }
    // Session-scoped kinds — `finish`, `reopen`, a `note` about no particular
    // article — carry no primary key and so cannot reference an item that is
    // missing from the session. `resolveAll` drops them.
    if (event.idarticulo === null) continue;
    if (!known.has(event.idarticulo)) {
      throw new Error(
        `event ${event.id} references idarticulo ${event.idarticulo}, which is not ` +
          `in session ${session.id}`,
      );
    }
  }
  return resolveAll(events);
}

/**
 * A row counted at zero that the ERP believed held something (DOMAIN.md §2).
 *
 * Exported because the review screen and the posting confirmation must agree
 * on the set to the row, and two spellings of one predicate is how they stop
 * agreeing. Derived from state and quantity — never a fourth state.
 */
export function isWriteOff(summary: ItemSummary): boolean {
  return summary.state === 'counted' && summary.qty === 0 && summary.item.existencia > 0;
}

function accumulate(into: Exposure, valor: number, exposicion: number): void {

  into.items++;
  into.valor = addDecimal(into.valor, valor);
  into.exposicion = addDecimal(into.exposicion, exposicion);
}

export function summarizeSession(
  session: Pick<Session, 'id' | 'items'>,
  events: readonly CountEvent[],
  options: SummaryOptions = {},
): SessionSummary {
  const { topN = DEFAULT_TOP_N } = options;
  const resolutions = resolveSession(session, events);

  const counts: Record<ItemState, number> = { counted: 0, unchanged: 0, untouched: 0 };
  const items: ItemSummary[] = [];
  const unverified: UnverifiedItem[] = [];
  let netVarianceValue = 0;
  let grossVarianceValue = 0;
  const pendiente: Exposure = { items: 0, valor: 0, exposicion: 0 };
  const sinVerificar: Exposure = { items: 0, valor: 0, exposicion: 0 };
  let valorContado = 0;
  let valorTotal = 0;

  for (const item of session.items) {
    const resolution = resolutions.get(item.idarticulo) ?? { state: 'untouched' as const };
    const variance = itemVariance(item, resolution);
    counts[resolution.state]++;
    items.push({ item, state: resolution.state, qty: resolution.qty, variance });

    const valor = bookValue(item);
    valorTotal = addDecimal(valorTotal, valor);

    if (variance) {
      netVarianceValue = addDecimal(netVarianceValue, variance.valorVariance);
      grossVarianceValue = addDecimal(grossVarianceValue, variance.materialidad);
    }

    if (resolution.state === 'counted') {
      // Coverage counts only what somebody actually counted. A waiver is a
      // decision not to count, and crediting it here would let a session reach
      // full coverage with nobody having gone anywhere.
      valorContado = addDecimal(valorContado, valor);
      continue;
    }

    // Everything below is inside `sinVerificar`: nobody counted it.
    const exposicion = exposureValue(item);
    accumulate(sinVerificar, valor, exposicion);
    if (resolution.state === 'untouched') {
      accumulate(pendiente, valor, exposicion);
      unverified.push({ item, valor, exposicion });
    }
  }

  // Ties break on idarticulo so every ranking is stable across runs and
  // devices: Array.prototype.sort is stable only with respect to the input
  // order, and the input order is the file's, not something we control.
  const byMateriality = items
    .filter((summary) => summary.variance !== null)
    .sort(
      (a, b) =>
        b.variance!.materialidad - a.variance!.materialidad ||
        a.item.idarticulo - b.item.idarticulo,
    );
  const writeOffs = byMateriality.filter(isWriteOff);
  let writeOffValue = 0;
  for (const row of writeOffs) {
    writeOffValue = addDecimal(writeOffValue, row.variance!.materialidad);
  }
  const byValor = unverified
    .slice()
    .sort((a, b) => b.valor - a.valor || a.item.idarticulo - b.item.idarticulo);
  const cobertura: Coverage = {
    valor: valorContado,
    valorTotal,
    // A bodega whose whole book is worth nothing has no value coverage to
    // report; zero is the honest answer, not one.
    fraccionValor: valorTotal === 0 ? 0 : valorContado / valorTotal,
    filas: counts.counted,
    filasTotal: session.items.length,
    fraccionFilas: session.items.length === 0 ? 0 : counts.counted / session.items.length,
  };
  const byExposicion = unverified
    .slice()
    .sort((a, b) => b.exposicion - a.exposicion || a.item.idarticulo - b.item.idarticulo);

  return {
    itemCount: session.items.length,
    counts,
    netVarianceValue,
    grossVarianceValue,
    items,
    byMateriality,
    writeOffs,
    writeOffValue,
    pendiente,
    sinVerificar,
    cobertura,
    pendienteTop: byValor.slice(0, topN),
    byExposicion,
    canPost: counts.untouched === 0,
  };
}
