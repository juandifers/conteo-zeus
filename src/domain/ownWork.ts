/**
 * What one counter has done, from their own log — DOMAIN.md §2.1, P2.3.
 *
 * Every question the counting screens ask about progress is answered here, and
 * the reason is the blind rule rather than tidiness. A screen that wanted to
 * know "have I registered this shelf" could fold the article and look at the
 * state — and would then be holding a `Resolution`, which carries `qty`, one
 * property access away from rendering the running total for an article the
 * counter is standing in front of. So the fold happens in the domain and what
 * crosses back is a set of `idarticulo`s and some counts of rows: **no function
 * in this file returns a quantity, and none may be added that does.**
 *
 * The counts that do cross are counts of the counter's *own work* — how many of
 * their articles they have registered, how many entries they made, how many
 * were zeros — which §2.1 admits explicitly. None of them is anything the ERP
 * believes, and none of them is per-article.
 */
import { compareEvents, isItemEvent, resolve } from './fold.js';
import type { CountEvent } from './types.js';

/** The shape of an assignment, as much of it as progress needs. */
export interface AssignedSection {
  id: string;
  nombre: string;
  items: readonly { idarticulo: number }[];
}

/** This counter's events, in the order they recorded them. */
function own(events: readonly CountEvent[], counterId?: string): CountEvent[] {
  return events
    .filter((event) => counterId === undefined || event.counterId === counterId)
    .slice()
    .sort(compareEvents);
}

/**
 * The articles this counter has registered something against.
 *
 * "Registered" is asked of the fold rather than of the event kinds: an article
 * is registered when its events resolve to anything but `untouched`. That is
 * what makes the one behaviour the correction screen has to have fall out for
 * free — withdrawing the only entry on an article puts it back in the gap list,
 * because withdrawing the only entry is exactly what returns the fold to
 * `untouched` — instead of being a second rule that has to be kept in step.
 *
 * A `note` is not a registration. It asserts nothing about the stock (§3) and
 * folds to nothing, so an article somebody remarked on and never counted stays
 * in the gap list, which is right: the remark is the reason to go back, not a
 * substitute for going.
 */
export function registeredArticles(
  events: readonly CountEvent[],
  counterId?: string,
): Set<number> {
  const byItem = new Map<number, CountEvent[]>();
  for (const event of own(events, counterId)) {
    if (!isItemEvent(event)) continue;
    const bucket = byItem.get(event.idarticulo);
    if (bucket) bucket.push(event);
    else byItem.set(event.idarticulo, [event]);
  }

  const registered = new Set<number>();
  for (const [idarticulo, bucket] of byItem) {
    // Only the state is read. `Resolution.qty` does not leave this function.
    if (resolve(bucket).state !== 'untouched') registered.add(idarticulo);
  }
  return registered;
}

export interface SectionProgress {
  id: string;
  nombre: string;
  total: number;
  /** Articles with something standing against them, this counter's or inherited. */
  registrados: number;
  /**
   * Of those, the ones somebody else had already registered when this device
   * fetched (P2.3.5 §6b).
   *
   * Broken out rather than folded in because the two are different facts about
   * the afternoon: «I registered 38» and «38 are registered, 12 of them by
   * Luis» are not the same sentence, and the finish summary should not claim
   * somebody else's shelves as this counter's work.
   */
  heredados: number;
  /** The gap, in the order the section holds them — which is catalogue order. */
  faltan: number[];
}

/**
 * Each of this counter's sections, and what is still open in it.
 *
 * Well-defined *because the assignment is scoped* (P2.1): these are shelves this
 * person physically walked past, which is what makes the list actionable rather
 * than a list of everything nobody counted. A counter is never shown a gap in
 * somebody else's section, and the whole catalogue never appears here.
 */
export function sectionProgress(
  sections: readonly AssignedSection[],
  events: readonly CountEvent[],
  counterId?: string,
  /**
   * Articles somebody **else** had already registered, from the assignment
   * payload's `yaRegistrados` (P2.3.5 §6b).
   *
   * Absent for every counter who was not handed somebody else's shelves, which
   * is every counter until a handover happens: under disjoint assignments the
   * set is empty and this parameter changes nothing.
   */
  heredados?: ReadonlySet<number>,
): SectionProgress[] {
  const registered = registeredArticles(events, counterId);
  return sections.map((section) => {
    const ids = section.items.map((item) => item.idarticulo);
    const faltan = ids.filter(
      (idarticulo) => !registered.has(idarticulo) && !(heredados?.has(idarticulo) ?? false),
    );
    return {
      id: section.id,
      nombre: section.nombre,
      total: ids.length,
      registrados: ids.length - faltan.length,
      // Inherited *and still untouched by this counter*: an article Pedro
      // counted himself is his work, whoever had been there first.
      heredados: ids.filter(
        (idarticulo) => (heredados?.has(idarticulo) ?? false) && !registered.has(idarticulo),
      ).length,
      faltan,
    };
  });
}

/** One row of «Mis registros»: what was entered, and whether it still stands. */
export interface OwnEntry {
  event: CountEvent;
  /**
   * Withdrawn by a later scoped retraction.
   *
   * The row stays on screen struck through rather than disappearing. The log is
   * append-only, and a correction screen that hid what it corrected would be
   * lying about the one thing it exists to make honest.
   */
  withdrawn: boolean;
}

/** The ids every scoped retraction in this log names. */
function withdrawnIds(events: readonly CountEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === 'retract' && event.retractsEventId !== undefined) {
      ids.add(event.retractsEventId);
    }
  }
  return ids;
}

/**
 * This counter's entries, oldest first.
 *
 * **Chronological, never grouped by article**, and that is a decision rather
 * than a default. Grouping puts one article's entries adjacent and makes their
 * sum trivial to read off, which re-imports the anchor §2.1 removes into the
 * screen a counter visits *between* counts. Chronological answers "what did I
 * do", which is the question correction actually needs.
 *
 * The retractions themselves are not rows. They annotate their target — which
 * is on screen, struck through — and a second row saying the first one was
 * undone is a list twice as long that says the same thing.
 */
export function ownLog(events: readonly CountEvent[], counterId?: string): OwnEntry[] {
  const mine = own(events, counterId);
  const withdrawn = withdrawnIds(mine);
  return mine
    .filter(isItemEvent)
    .filter((event) => event.kind !== 'retract' && event.kind !== 'note')
    .map((event) => ({ event, withdrawn: withdrawn.has(event.id) }));
}

/** This counter's notes, newest first, article-scoped or loose. */
export function ownNotes(events: readonly CountEvent[], counterId?: string): CountEvent[] {
  return own(events, counterId)
    .filter((event) => event.kind === 'note')
    .reverse();
}

/**
 * The summary «Terminar» shows before it asks.
 *
 * Counts of rows, all of them about this counter's own afternoon. `ceros` is a
 * count of *entries* rather than of articles resolving to zero: it is the
 * deliberate action the screen made somebody confirm, and counting articles
 * would mean folding one and looking at the number, which is the thing this
 * module exists not to hand back.
 */
export interface OwnSummary {
  /** Articles in this counter's sections with something standing against them. */
  registrados: number;
  /** Of those, ones another counter had already registered before the handover. */
  heredados: number;
  /** Articles in their sections with nothing. The gap, as a number. */
  sinRegistrar: number;
  /** Standing entries — more than one on an article is normal and common. */
  registros: number;
  /** Standing entries of zero: «fui al estante, está vacío». */
  ceros: number;
  notas: number;
}

export function ownSummary(
  sections: readonly AssignedSection[],
  events: readonly CountEvent[],
  counterId?: string,
  heredados?: ReadonlySet<number>,
): OwnSummary {
  const progress = sectionProgress(sections, events, counterId, heredados);
  const entries = ownLog(events, counterId).filter((entry) => !entry.withdrawn);
  return {
    registrados: progress.reduce((sum, section) => sum + section.registrados, 0),
    heredados: progress.reduce((sum, section) => sum + section.heredados, 0),
    sinRegistrar: progress.reduce((sum, section) => sum + section.faltan.length, 0),
    registros: entries.length,
    ceros: entries.filter((entry) => entry.event.kind === 'add' && entry.event.qty === 0)
      .length,
    notas: ownNotes(events, counterId).length,
  };
}
