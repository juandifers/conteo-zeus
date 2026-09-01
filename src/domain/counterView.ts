/**
 * What a counter's device is allowed to hold — an allowlist, built by hand.
 *
 * Two requirements from the jefe de costos meet in this file, and both of them
 * are about *data* rather than about pixels.
 *
 * **Counters never see Zeus quantities** (DOMAIN.md §2.1). A variance is only
 * evidence to the extent the counter did not know what they were supposed to
 * find; shown `existencia` first, a person under time pressure finds
 * `existencia`. P1 enforced that by what the screens drew, which was already
 * asserted by `tests/blindCount.test.ts`. From P2 on it is enforced by what the
 * server sends, which is stronger: a screen can be changed by anybody, and a
 * figure that never left the database cannot be rendered by accident.
 *
 * **Entry is blind and additive.** Nothing in what a device holds may reveal a
 * running total. The entry UI is P2.3's problem; this file's obligation is not
 * to ship data that would make blindness impossible before it is written.
 *
 * ## Why an allowlist, and why by construction
 *
 * A denylist fails open. The first time somebody adds a column to
 * `catalog_rows` — a `costo_promedio`, a `stock_minimo` — a redacting
 * projection ships it, and nothing anywhere fails. An allowlist fails closed:
 * the new column simply does not appear, and the worst case is a missing field
 * somebody notices. This particular mistake has to fail in that direction.
 *
 * So the projections below are literal objects naming their fields, not
 * `omit(row, [...])` over a spread. The exported field lists are the same
 * allowlist as data, so that `tests/backend/counterView.test.ts` can assert the
 * serialised payload's key set *equals* them at every level of nesting rather
 * than merely containing them.
 */
import type { Assignment, Counter, Section } from './assignment';
import type { Item } from './types';

/**
 * One article, as the tablet sees it.
 *
 * Not `existencia`, `costo`, `ultimoConteo`, `toma`, `conteo1..3`,
 * `diferencia`, `rawRow` or `familia`. `familia` is excluded even though it is
 * not a quantity: it is a grouping the admin used to build the partition, the
 * counter already has their sections, and a field nobody needs is a field that
 * only carries risk.
 */
export interface CounterItem {
  /** The primary key (ZEUS_FORMAT.md §4). Events are keyed on it, so it must travel. */
  idarticulo: number;
  /** Printed on the shelf label, so it is how a counter finds a row. A string, always. */
  codigo: string;
  nombre: string;
  presentacion: string;
  /**
   * The unit label, taken from `presentacion` **verbatim**.
   *
   * It is the same string, and that is the point rather than an oversight.
   * `presentacion` is free text — `KILO`, `500 GRM`, `CAJA X 125 UNIDADES`,
   * `UNIDAD DE 450 A 550 GRAMOS` — and any attempt to extract "the unit" from
   * it is a guess. A guessed unit beside a keypad is a wrong number: a counter
   * shown `KILO` for a row measured in boxes types boxes.
   *
   * The field exists so the entry screen has a named place for the label
   * without inventing a vocabulary the catalogue does not have. If a real unit
   * column ever arrives from Zeus, this is where it lands and nothing above it
   * changes.
   */
  unidad: string;
}

/** One of the counter's sections. Its `nombre` becomes `zona` on every event from it. */
export interface CounterSection {
  id: string;
  nombre: string;
  items: CounterItem[];
}

/** The session, as the tablet sees it. No posting parameters — see below. */
export interface CounterSessionView {
  id: string;
  bodega: string;
  fechaCorte: string;
  nombre: string | null;
  /**
   * Whether the neutral `registrado` checkmark is drawn (P2.3).
   *
   * Read from session config rather than compiled in, because the jefe may
   * want it gone after seeing it in use and that must be a toggle on the admin
   * screen rather than a deploy.
   */
  mostrarMarcaRegistrado: boolean;
}

/** The counter themselves. Not the token: it is already in the URL that fetched this. */
export interface CounterView {
  id: string;
  nombre: string;
}

export interface CounterPayload {
  session: CounterSessionView;
  counter: CounterView;
  secciones: CounterSection[];
  /**
   * Articles in this counter's assignment that already carry a standing event
   * **from anyone**, as of the moment this payload was built (P2.3.5 §6b).
   *
   * Ids only. No quantities, no counter names, no counts — this is the same
   * information the neutral checkmark already conveys, which is *presence*, and
   * never magnitude. The blind rule (§2.1) is intact.
   *
   * It exists for the handover. P2.3 defines the gap list as «articles in my
   * sections with no standing events **from me**», which is right while
   * assignments are disjoint and wrong the moment Pedro inherits 120 articles
   * of which Luis already counted 60: Pedro's finish screen would list all 120
   * and send him to recount work already done, which is the double count of
   * §4b arriving by a second route.
   *
   * Two properties worth being explicit about:
   *
   *   - **It is a snapshot, not a subscription.** Counter sync stays push-only.
   *     The device fetches this once, at handover, on wifi — which is exactly
   *     when a handover happens. Nothing here asks a tablet in a bodega to pull.
   *   - **It only matters after a handover.** Under disjoint assignments
   *     «standing event from anyone» and «from me» are the same set; the two
   *     definitions diverge only for inherited articles, which is the case this
   *     exists for.
   */
  yaRegistrados: number[];
}

/**
 * The allowlist, as data, level by level.
 *
 * Kept beside the interfaces rather than derived from them: a type is erased at
 * runtime, and the test that matters walks the JSON a device actually
 * receives.
 */
export const COUNTER_PAYLOAD_FIELDS = [
  'session',
  'counter',
  'secciones',
  'yaRegistrados',
] as const;
export const COUNTER_SESSION_FIELDS = [
  'id',
  'bodega',
  'fechaCorte',
  'nombre',
  'mostrarMarcaRegistrado',
] as const;
export const COUNTER_COUNTER_FIELDS = ['id', 'nombre'] as const;
export const COUNTER_SECTION_FIELDS = ['id', 'nombre', 'items'] as const;
export const COUNTER_ITEM_FIELDS = [
  'idarticulo',
  'codigo',
  'nombre',
  'presentacion',
  'unidad',
] as const;

/**
 * The posting parameters, named here so the exclusion is deliberate.
 *
 * `uncountedPolicy` in particular: it says what happens to a row nobody counts,
 * which is a statement about the shape of the whole count. It belongs to the
 * admin and to the export, and a counting screen that knew it would be a
 * counting screen that could tell a counter which rows do not matter.
 */
export const NEVER_SENT_TO_A_COUNTER = [
  'existencia',
  'costo',
  'costo2',
  'ultimoConteo',
  'toma',
  'conteo1',
  'conteo2',
  'conteo3',
  'diferencia',
  'rawRow',
  'raw_row',
  'familia',
  'uncountedPolicy',
  'uncounted_policy',
  'countTargetColumn',
  'differenceColumn',
] as const;

/** One row, projected. A literal, never a spread — see the module note. */
export function counterItem(item: Item): CounterItem {
  return {
    idarticulo: item.idarticulo,
    codigo: item.codigo,
    nombre: item.nombre,
    presentacion: item.presentacion,
    unidad: item.presentacion,
  };
}

export interface CounterPayloadInput {
  session: CounterSessionView;
  counter: Counter;
  sections: readonly Section[];
  assignments: readonly Assignment[];
  /** The whole catalogue. Everything not assigned to this counter is dropped. */
  items: readonly Item[];
  /**
   * Articles anybody has registered something against, session-wide.
   *
   * Filtered here to this counter's own assignment: the tablet has no use for
   * an id outside its sections, and a field nobody needs is a field that only
   * carries risk (see `CounterItem` on `familia`). Computed by the caller,
   * because deciding what «registered» means is a fold and the fold is
   * `registeredArticles` in `ownWork.ts` — there is one definition of it and
   * this file is not going to grow a second.
   */
  registered?: ReadonlySet<number>;
}

/**
 * Everything one counter's device needs, and nothing else.
 *
 * Grouped by section rather than flat, for two reasons. The section name is the
 * `zona` every event from those articles carries, and an article's zone has to
 * be derivable from the payload without a lookup table the tablet would have to
 * be sent separately. And it keeps the item projection to exactly five fields:
 * a flat list would need a section name *per row*, which is a sixth field on
 * the object the leak test is strictest about.
 *
 * Sections with no articles are dropped. An empty named section on a printed
 * sheet is a place somebody looks for and does not find.
 */
export function counterPayload(input: CounterPayloadInput): CounterPayload {
  const byId = new Map(input.items.map((item) => [item.idarticulo, item]));
  const mine = input.assignments.filter(
    (assignment) => assignment.counterId === input.counter.id,
  );

  const sections = input.sections.filter((section) => section.counterId === input.counter.id);
  const secciones: CounterSection[] = [];
  for (const section of sections) {
    const ids = new Set(
      mine
        .filter((assignment) => assignment.sectionId === section.id)
        .map((assignment) => assignment.idarticulo),
    );
    // Catalogue order, not assignment order: the printed list and the shelf are
    // both in the order Zeus exported, and a device that reordered them would
    // send somebody up and down the same aisle.
    const items = input.items.filter((item) => ids.has(item.idarticulo)).map(counterItem);
    if (items.length === 0) continue;
    secciones.push({ id: section.id, nombre: section.nombre, items });
  }

  // An assignment naming a section this counter does not hold is a bug in the
  // partition, and dispatch refuses it (`dispatchBlockers`). If one reaches
  // here anyway, the article is silently absent from the tablet rather than
  // arriving without a zone, and the check below turns that into an error the
  // caller can see instead of a shelf nobody counts.
  const delivered = secciones.reduce((total, section) => total + section.items.length, 0);
  const expected = new Set(mine.map((assignment) => assignment.idarticulo).filter((id) => byId.has(id)))
    .size;
  if (delivered !== expected) {
    throw new Error(
      `counter ${input.counter.id} is assigned ${expected} articles but only ${delivered} ` +
        'fall in sections they hold; the partition is inconsistent',
    );
  }

  const mineIds = secciones.flatMap((section) => section.items.map((item) => item.idarticulo));
  return {
    session: {
      id: input.session.id,
      bodega: input.session.bodega,
      fechaCorte: input.session.fechaCorte,
      nombre: input.session.nombre,
      mostrarMarcaRegistrado: input.session.mostrarMarcaRegistrado,
    },
    counter: { id: input.counter.id, nombre: input.counter.nombre },
    secciones,
    // Sorted, so two builds of one assignment are byte-identical and a test can
    // compare them without knowing what order a `Set` iterates in.
    yaRegistrados: mineIds
      .filter((idarticulo) => input.registered?.has(idarticulo) ?? false)
      .sort((a, b) => a - b),
  };
}
