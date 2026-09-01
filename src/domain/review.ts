/**
 * The review — P2.4.
 *
 * Everything before this produced data that is provably intact. This is where a
 * person looks at it and decides what the file will claim, so it is the one
 * module in the domain whose whole purpose is to *reveal*: it reads
 * `existencia`, it reads `costo`, and it derives variances and exposures from
 * both. §2.1's blindness governs the counter's tablet and only that; conflating
 * the two would either leak quantities to a device in a bodega or blind the
 * person who has to sign the acta.
 *
 * `tests/boundaries.test.ts` asserts that no module reachable from the counter
 * bundle imports this file. That is the seam, and it is machine-checked rather
 * than remembered.
 *
 * ## Two rules run through all of it
 *
 * **Advisory, never blocking, never auto-correcting.** Every flag here ranks a
 * row and says why. None of them changes a count, and none of them may ever be
 * offered a "corregir" button: the count is what somebody saw, and an admin
 * adjusting it at a desk would be entering a number nobody observed, under a
 * counter's identity or under none. If a count is wrong the counter reopens and
 * corrects it, or the admin writes a note and the acta says so.
 *
 * **A waiver never overrides a count** (§4b). Waivers are projected into
 * `unchanged` events for the fold, and only for articles that fold to
 * `untouched` from counter events alone. That is not a refinement, it is the
 * correctness condition — see `waiversToEvents`.
 */
import type {
  AnularWaiverPayload,
  ReasignarPayload,
  SessionActionRecord,
  StandingWaiver,
  WaiverPayload,
} from './actions.js';
import { standingWaivers } from './actions.js';
import type { CounterEstado } from './assignment.js';
import { compareEvents, isItemEvent, resolve, resolveAll, type Resolution } from './fold.js';
import {
  summarizeSession,
  type Coverage,
  type Exposure,
  type ItemSummary,
} from './session.js';
import type { CountEvent, Item, ItemState, NoteEvent, UnchangedEvent } from './types.js';
import { bookValue, exposureValue } from './variance.js';

/** What the review needs to know about one counter. Names and state, no chain. */
export interface ReviewCounter {
  id: string;
  nombre: string;
  estado: CounterEstado;
}

export interface ReviewInput {
  sessionId: string;
  items: readonly Item[];
  /** Every event in the session, however it was paged in. Order is irrelevant. */
  events: readonly CountEvent[];
  /** The admin's own chain, in `seq` order or not. */
  actions: readonly SessionActionRecord[];
  counters: readonly ReviewCounter[];
}

// --- §4b: waivers, projected ------------------------------------------------

/**
 * Standing waivers as `unchanged` events — but **only** where nothing was
 * counted (§4b).
 *
 * The scenario this exists for:
 *
 *     15:00  el admin exonera el artículo 4471
 *     15:30  sincroniza una tableta rezagada
 *            Luis contó 4471 a las 11:02
 *
 *     el fold ordena por `at`  →  el conteo de Luis va primero,
 *                                 la exoneración después  →  'unchanged' gana
 *                                 y el conteo real se descarta
 *
 * `unchanged` discards any running value (fold.ts), and the fold orders by
 * time, so a waiver signed at three o'clock beats a count taken at eleven that
 * arrived at half past three. The outcome would depend on **when a tablet
 * reached wifi**, which is the one thing the whole offline model refuses to let
 * anything depend on.
 *
 * Evaluating waivers against the fold of counter events alone removes the
 * dependency at the root: a waiver either lands on an article nobody touched —
 * where nothing can contradict it, whenever it arrives — or it does not land at
 * all, and shows up in `superseded` for somebody to look at. The projection is
 * therefore idempotent and order-independent by construction rather than by
 * ordering discipline.
 *
 * It is a pure projection consumed by the existing fold, so `fold.ts` does not
 * learn what a `session_action` is. That direction matters: the fold is the
 * definition of what a count means, and it must go on being readable by
 * somebody who has never heard of an admin.
 *
 * @param counterFold the fold over **counter events only** — `resolveAll` of the
 *   log with no waivers in it. Passing a fold that already contains projected
 *   waivers would make this self-confirming.
 */
export function waiversToEvents(
  actions: readonly SessionActionRecord[],
  counterFold: ReadonlyMap<number, Resolution>,
): UnchangedEvent[] {
  const events: UnchangedEvent[] = [];
  for (const waiver of standingWaivers(actions)) {
    for (const idarticulo of waiver.idarticulo) {
      const state = counterFold.get(idarticulo)?.state ?? 'untouched';
      if (state !== 'untouched') continue;
      events.push({
        // Derived from the action and the article, so the same log projects to
        // the same events every time. Nothing mints an identity here: an id a
        // second call would not reproduce would make this projection a source
        // of new facts rather than a reading of the chain.
        id: `${waiver.actionId}:${idarticulo}`,
        // The action's own session. `resolveSession` checks it, and it should:
        // a projected event that claimed no session would fold into whatever
        // log it was handed to.
        sessionId: waiver.sessionId,
        idarticulo,
        kind: 'unchanged',
        usuario: waiver.usuario,
        // A waiver is signed at a desk. There is no shelf and no section, and an
        // invented zone would put a place on an event that never had one.
        zona: '',
        at: waiver.at,
        deviceId: '',
        seq: waiver.seq,
        motivo: waiver.motivo,
      });
    }
  }
  return events;
}

/** A waiver that a count overtook: signed, and then the article turned out to have data. */
export interface SupersededWaiver {
  actionId: string;
  usuario: string;
  at: string;
  motivo: string;
  item: Item;
  /** What the counters' events actually say. */
  state: ItemState;
  qty?: number;
  /** Who counted it, and when — so the admin can see what overtook the waiver. */
  contadores: string[];
}

// --- Rows and flags ---------------------------------------------------------

/**
 * Why a row is worth a look. Advisory, always; each one shows its arithmetic.
 *
 * Deliberately data rather than sentences, like `DispatchBlocker`: one list, and
 * the screen renders it. A flag that arrived as Spanish could not be counted,
 * filtered or tested for.
 */
export type ReviewFlag =
  /** Standing events from two or more counters — §3a. */
  | { kind: 'overlap'; causa: 'reasignado' | 'secciones' }
  /** At least one standing event after that counter's first `finish` — §3b. */
  | { kind: 'post-finish' }
  /** A standing entry of zero against a non-zero book figure — §3c. */
  | { kind: 'cero' }
  /** The last thing a finished counter did here was withdraw something — §3d. */
  | { kind: 'retraccion-final' }
  /** Waived, and then counted. The waiver did not apply — §4b. */
  | { kind: 'waiver-superado' }
  /** More than 10x the book figure, or less than a tenth of it — §3e. */
  | { kind: 'outlier'; motivo: 'magnitud'; ratio: number }
  /** `existencia / conteo` (or its inverse) lands on a case size — §3e. */
  | { kind: 'outlier'; motivo: 'caja'; factor: number; ratio: number; invertido: boolean }
  /** One entry dwarfs the others on the same article — §3e. */
  | { kind: 'outlier'; motivo: 'entrada'; ratio: number };

export interface ReviewRow {
  item: Item;
  state: ItemState;
  /** Present only for `counted`. */
  conteo?: number;
  /** `conteo − existencia`. `null` when nobody counted, which is not zero. */
  diferencia: number | null;
  /** `|diferencia| × costo`, or the whole row's exposure when nobody counted. */
  exposicion: number;
  /** Standing quantity entries on this row, from every counter. */
  entradas: number;
  /** Counters with a standing event here. More than one is `overlap`. */
  contadores: string[];
  flags: ReviewFlag[];
}

/** One counter's part of an article two people touched. */
export interface OverlapContribution {
  counterId: string;
  nombre: string;
  entradas: number;
  /** What **this counter's own** events fold to here. */
  cantidad: number | null;
  primero: string;
  ultimo: string;
}

/**
 * An article carrying standing events from more than one counter.
 *
 * Under P2.1's disjointness gate this is always worth a look, and the two causes
 * want completely different reactions from the admin — which is the whole reason
 * they are told apart rather than counted together.
 */
export interface Overlap {
  item: Item;
  causa: 'reasignado' | 'secciones';
  /** The reassignment that explains it (§4b pre-armed this), when there is one. */
  movimiento: { at: string; usuario: string; motivo: string; from: string; to: string } | null;
  contribuciones: OverlapContribution[];
}

/** An event a counter wrote after their first `finish` — the amendment log. */
export interface Amendment {
  counterId: string;
  nombre: string;
  event: CountEvent;
  item: Item | null;
  /** A `reopen` stands between that first `finish` and this event. */
  reabierto: boolean;
}

/** A standing entry of zero on a row the ERP believed held something. */
export interface ExplicitZero {
  event: CountEvent;
  item: Item;
  counterId: string | null;
  nombre: string;
  /** `existencia × costo` — the book value this entry writes off. */
  valor: number;
}

/** A counter whose last content event is a withdrawal with nothing after it. */
export interface TrailingRetraction {
  counterId: string;
  nombre: string;
  estado: CounterEstado;
  event: CountEvent;
  /** The event it withdrew, when that event is in the log. */
  retirado: CountEvent | null;
  item: Item | null;
}

/** One note, with the article it hangs off when it has one. */
export interface ReviewNote {
  event: NoteEvent;
  item: Item | null;
  counterId: string | null;
  nombre: string;
}

export interface ReviewNotes {
  /** Grouped by counter, chronological within each. */
  porContador: { counterId: string | null; nombre: string; notas: ReviewNote[] }[];
  /**
   * Notes attached to no article — physical stock with no catalogue row.
   *
   * The important ones, and a distinct section rather than a line in the list:
   * these are the cases where the file **cannot represent what is in the
   * bodega** at all, and the admin needs them before sealing rather than after.
   */
  sueltas: ReviewNote[];
}

/** One advisory line on the pre-seal panel. Blocks nothing; links to a list. */
export interface AdvisoryItem {
  kind:
    | 'sin-contar'
    | 'ceros'
    | 'overlap'
    | 'post-finish'
    | 'retraccion-final'
    | 'waiver-superado'
    | 'notas-sueltas';
  filas: number;
  /** What that set is worth, where the question has a peso answer. */
  valor: number;
}

export interface Review {
  /** Every catalogue row, by exposure of the variance, descending. */
  rows: ReviewRow[];
  counts: Record<ItemState, number>;
  netVarianceValue: number;
  grossVarianceValue: number;
  /** §5's pair. `pendiente` falls as rows are waived; `sinVerificar` does not. */
  pendiente: Exposure;
  sinVerificar: Exposure;
  cobertura: Coverage;
  /** How many of `sinVerificar` are waived rather than merely untouched. */
  exoneradas: number;
  waivers: StandingWaiver[];
  superseded: SupersededWaiver[];
  overlaps: Overlap[];
  amendments: Amendment[];
  zeros: ExplicitZero[];
  trailing: TrailingRetraction[];
  notes: ReviewNotes;
}

// --- The pass ---------------------------------------------------------------

/** Events a scoped retraction has withdrawn, plus the retractions themselves. */
function standing(events: readonly CountEvent[]): CountEvent[] {
  const withdrawn = new Set<string>();
  for (const event of events) {
    if (event.kind === 'retract' && event.retractsEventId !== undefined) {
      withdrawn.add(event.retractsEventId);
    }
  }
  return events.filter(
    (event) =>
      !withdrawn.has(event.id) &&
      !(event.kind === 'retract' && event.retractsEventId !== undefined),
  );
}

const QUANTITY = new Set(['set', 'add']);

/**
 * Close enough to a case size to be worth asking about.
 *
 * One percent, because these are exact multiples when they happen: somebody
 * counted 4 cases and typed 4 where the book is in units, or the other way
 * round. A wide band would catch every ratio near six and say nothing.
 */
const CASE_SIZES = [6, 12, 24];
const CASE_TOLERANCE = 0.01;

/** More than an order of magnitude out, in either direction. */
const MAGNITUDE = 10;

function caseFlag(conteo: number, existencia: number): ReviewFlag | null {
  if (conteo <= 0 || existencia <= 0) return null;
  for (const [ratio, invertido] of [
    [existencia / conteo, false],
    [conteo / existencia, true],
  ] as const) {
    for (const factor of CASE_SIZES) {
      if (Math.abs(ratio - factor) / factor <= CASE_TOLERANCE) {
        return { kind: 'outlier', motivo: 'caja', factor, ratio, invertido };
      }
    }
  }
  return null;
}

/**
 * The whole review, in one pass over the log.
 *
 * One function rather than eight, because every one of the eight needs the same
 * three things — the log grouped by article, the log grouped by counter, and the
 * fold — and a screen that called them separately would walk 5 000 events eight
 * times to draw one table.
 */
export function reviewSession(input: ReviewInput): Review {
  const items = new Map(input.items.map((item) => [item.idarticulo, item]));
  const counters = new Map(input.counters.map((counter) => [counter.id, counter]));
  /**
   * A counter's name, and a name for the ones that have none.
   *
   * `''` is the P1 case and it is not a missing lookup: those events predate
   * counter identity entirely (MIGRATION-P1-P2.md), and calling them «sin
   * contador» is the truthful label rather than a placeholder for a row that
   * should have been there.
   */
  const nombreOf = (counterId: string | null | undefined): string => {
    if (counterId === null || counterId === undefined || counterId === '') return 'sin contador';
    return counters.get(counterId)?.nombre ?? counterId;
  };

  // The fold over **counter events only**. Everything about waivers is decided
  // against this one, and never against a fold that already contains them.
  const counterFold = resolveAll(input.events);
  const waiverEvents = waiversToEvents(input.actions, counterFold);
  const waivers = standingWaivers(input.actions);

  // §5's figures, from the one function that defines them. Recomputing them here
  // would be a second definition of `pendiente` and `sinVerificar`, and the
  // honesty property this screen rests on is a property of *those* definitions.
  const summary = summarizeSession(
    { id: input.sessionId, items: input.items },
    [...input.events, ...waiverEvents],
  );
  const byId = new Map(summary.items.map((row) => [row.item.idarticulo, row]));

  // --- one pass, grouping ---------------------------------------------------
  const byArticle = new Map<number, CountEvent[]>();
  const byCounter = new Map<string, CountEvent[]>();
  for (const event of input.events) {
    if (isItemEvent(event)) {
      const bucket = byArticle.get(event.idarticulo);
      if (bucket) bucket.push(event);
      else byArticle.set(event.idarticulo, [event]);
    }
    const owner = event.counterId ?? '';
    const own = byCounter.get(owner);
    if (own) own.push(event);
    else byCounter.set(owner, [event]);
  }

  // Which articles a `reasignar` moved, and when — §3a's first cause. Pre-armed
  // by P2.3.5: the payload already names every article that changed hands, so an
  // overlap that follows a handover is *explained* rather than anomalous.
  const moved = new Map<number, Overlap['movimiento']>();
  for (const action of [...input.actions].sort((a, b) => a.seq - b.seq)) {
    if (action.kind !== 'reasignar') continue;
    const payload = action.payload as ReasignarPayload;
    for (const move of payload.movimientos) {
      moved.set(move.idarticulo, {
        at: action.at,
        usuario: action.usuario,
        motivo: payload.motivo,
        from: nombreOf(move.from),
        to: nombreOf(move.to),
      });
    }
  }

  const overlaps: Overlap[] = [];
  const zeros: ExplicitZero[] = [];
  const rows: ReviewRow[] = [];

  for (const item of input.items) {
    const summaryRow: ItemSummary =
      byId.get(item.idarticulo) ??
      { item, state: 'untouched', variance: null };
    const events = byArticle.get(item.idarticulo) ?? [];
    const alive = standing(events);
    const entries = alive.filter((event) => QUANTITY.has(event.kind));

    const contadores = [
      ...new Set(alive.filter(isItemEvent).map((event) => event.counterId ?? '')),
    ].sort();

    const flags: ReviewFlag[] = [];

    // §3a — two counters on one article.
    if (contadores.length > 1) {
      const movimiento = moved.get(item.idarticulo) ?? null;
      const causa = movimiento ? 'reasignado' : 'secciones';
      flags.push({ kind: 'overlap', causa });
      overlaps.push({
        item,
        causa,
        movimiento,
        contribuciones: contadores.map((counterId) => {
          const mine = alive
            .filter((event) => (event.counterId ?? '') === counterId)
            .sort(compareEvents);
          // This counter's own events, folded on their own. The parts need not
          // sum to the whole — a `set` from either side overrides — which is
          // exactly why the breakdown is shown next to the total rather than
          // instead of it.
          const own = resolve(mine.filter(isItemEvent));
          return {
            counterId,
            nombre: nombreOf(counterId),
            entradas: mine.filter((event) => QUANTITY.has(event.kind)).length,
            cantidad: own.qty ?? null,
            primero: mine[0]?.at ?? '',
            ultimo: mine[mine.length - 1]?.at ?? '',
          };
        }),
      });
    }

    // §3c — a standing entry of zero on a row the ERP believed held something.
    // A `set(0)` counts too: it is the same stock deletion arrived at by another
    // route, and §7.4 zeroes the balance either way.
    for (const event of entries) {
      if ((event as { qty?: number }).qty !== 0 || item.existencia <= 0) continue;
      zeros.push({
        event,
        item,
        counterId: event.counterId ?? null,
        nombre: nombreOf(event.counterId),
        valor: bookValue(item),
      });
      if (!flags.some((flag) => flag.kind === 'cero')) flags.push({ kind: 'cero' });
    }

    // §3e — outliers. All advisory, all showing the arithmetic rather than a
    // verdict, and none of them offered a correction.
    const conteo = summaryRow.state === 'counted' ? summaryRow.qty : undefined;
    if (conteo !== undefined && item.existencia > 0 && item.costo > 0) {
      const ratio = conteo / item.existencia;
      if (ratio > MAGNITUDE || (conteo > 0 && ratio < 1 / MAGNITUDE)) {
        flags.push({ kind: 'outlier', motivo: 'magnitud', ratio });
      }
      const caja = caseFlag(conteo, item.existencia);
      // The case-versus-unit error is the classic one, and a counter cannot
      // catch it: `presentacion` is free text and often unhelpful
      // (`UNIDAD DE 450 A 550 GRAMOS`), so the unit is not on their screen in a
      // form anybody could compare against.
      if (caja) flags.push(caja);
    }
    if (entries.length > 1) {
      const sizes = entries
        .map((event) => Math.abs((event as { qty: number }).qty))
        .sort((a, b) => b - a);
      const rest = sizes.slice(1).reduce((sum, value) => sum + value, 0);
      if (rest > 0 && sizes[0] >= MAGNITUDE * rest) {
        flags.push({ kind: 'outlier', motivo: 'entrada', ratio: sizes[0] / rest });
      }
    }

    const diferencia = summaryRow.variance?.variance ?? null;
    rows.push({
      item,
      state: summaryRow.state,
      ...(summaryRow.qty === undefined ? {} : { conteo: summaryRow.qty }),
      diferencia,
      // Counted: what the variance is worth. Not counted: what the whole row
      // could be hiding, waived or not — waiving accepts an exposure, it does
      // not retire it, and a column that fell when somebody clicked would be the
      // screen §2a exists to prevent.
      exposicion:
        summaryRow.variance === null ? exposureValue(item) : summaryRow.variance.materialidad,
      entradas: entries.length,
      contadores: contadores.map(nombreOf),
      flags,
    });
  }

  // --- per counter ----------------------------------------------------------
  const amendments: Amendment[] = [];
  const trailing: TrailingRetraction[] = [];
  const notes: ReviewNote[] = [];

  for (const [counterId, own] of byCounter) {
    const ordered = [...own].sort(compareEvents);
    const counter = counters.get(counterId);

    for (const event of ordered) {
      if (event.kind !== 'note') continue;
      notes.push({
        event,
        item: event.idarticulo === null ? null : items.get(event.idarticulo) ?? null,
        counterId: event.counterId ?? null,
        nombre: nombreOf(counterId),
      });
    }

    // §3b — the amendment log, derived from **log position** and never from a
    // stored boolean. A flag written at ingest would be a second copy of a fact
    // the events already carry, and the two drift the first time a batch arrives
    // out of order: an event recorded before the finish and inserted after it
    // would be stamped post-finish for ever on the strength of when it happened
    // to reach the office wifi.
    const firstFinish = ordered.find((event) => event.kind === 'finish');
    if (firstFinish) {
      for (const event of ordered) {
        if (event.seq <= firstFinish.seq) continue;
        if (event.kind === 'finish' || event.kind === 'reopen') continue;
        amendments.push({
          counterId,
          nombre: nombreOf(counterId),
          event,
          item: event.idarticulo === null ? null : items.get(event.idarticulo) ?? null,
          reabierto: ordered.some(
            (other) =>
              other.kind === 'reopen' && other.seq > firstFinish.seq && other.seq < event.seq,
          ),
        });
      }
    }

    // §3d — a trailing retraction. Either a correction still in flight or one
    // whose replacement was lost; G1 prevents the common cause on the wire, and
    // the admin is the only one who can tell the difference for the rest.
    //
    // Suppressed until the counter is done. While they are `contando` this is
    // the ordinary shape of somebody mid-correction, and a flag that fires on
    // every correction in progress is a flag nobody reads. `terminado_local` is
    // not a state the server holds at all, which is why the condition is on
    // `estado` and not on an outbox the server cannot see.
    const done =
      counter?.estado === 'terminado_confirmado' || counter?.estado === 'retirado';
    const content = ordered.filter(
      (event) => event.kind !== 'finish' && event.kind !== 'reopen' && event.kind !== 'note',
    );
    const last = content[content.length - 1];
    if (done && last && last.kind === 'retract' && last.retractsEventId !== undefined) {
      trailing.push({
        counterId,
        nombre: nombreOf(counterId),
        estado: counter.estado,
        event: last,
        retirado: ordered.find((event) => event.id === last.retractsEventId) ?? null,
        item: last.idarticulo === null ? null : items.get(last.idarticulo) ?? null,
      });
    }
  }

  // Flags that are facts about a counter rather than about a row still have to
  // rank the row, or the table cannot show them.
  for (const mark of trailing) {
    if (mark.event.idarticulo === null) continue;
    const row = rows.find((entry) => entry.item.idarticulo === mark.event.idarticulo);
    if (row && !row.flags.some((flag) => flag.kind === 'retraccion-final')) {
      row.flags.push({ kind: 'retraccion-final' });
    }
  }
  for (const amendment of amendments) {
    if (amendment.event.idarticulo === null) continue;
    const row = rows.find((entry) => entry.item.idarticulo === amendment.event.idarticulo);
    if (row && !row.flags.some((flag) => flag.kind === 'post-finish')) {
      row.flags.push({ kind: 'post-finish' });
    }
  }

  // --- superseded waivers ---------------------------------------------------
  const superseded: SupersededWaiver[] = [];
  for (const waiver of waivers) {
    for (const idarticulo of waiver.idarticulo) {
      const resolution = counterFold.get(idarticulo);
      if (!resolution || resolution.state === 'untouched') continue;
      const item = items.get(idarticulo);
      if (!item) continue;
      superseded.push({
        actionId: waiver.actionId,
        usuario: waiver.usuario,
        at: waiver.at,
        motivo: waiver.motivo,
        item,
        state: resolution.state,
        ...(resolution.qty === undefined ? {} : { qty: resolution.qty }),
        contadores: [
          ...new Set(
            standing(byArticle.get(idarticulo) ?? []).map((event) => nombreOf(event.counterId)),
          ),
        ].sort(),
      });
      const row = rows.find((entry) => entry.item.idarticulo === idarticulo);
      if (row && !row.flags.some((flag) => flag.kind === 'waiver-superado')) {
        row.flags.push({ kind: 'waiver-superado' });
      }
    }
  }

  // **Exposure of the variance, descending** — not `codigo`, not book value.
  // The count route is ranked this way for the reason §5 gives, and the review
  // inherits it: the produce family is 54 rows with 31 booked at zero, and on
  // book value it sorts to the bottom while carrying real unpriced stock.
  rows.sort((a, b) => b.exposicion - a.exposicion || a.item.idarticulo - b.item.idarticulo);

  return {
    rows,
    counts: summary.counts,
    netVarianceValue: summary.netVarianceValue,
    grossVarianceValue: summary.grossVarianceValue,
    pendiente: summary.pendiente,
    sinVerificar: summary.sinVerificar,
    cobertura: summary.cobertura,
    exoneradas: summary.counts.unchanged,
    waivers,
    superseded,
    overlaps: overlaps.sort((a, b) => a.item.idarticulo - b.item.idarticulo),
    amendments,
    // §3c is a **list the admin walks**, not a flag in a table, and it is sorted
    // by what each line costs: a zero on a row booked at 4 million is a
    // different act from a zero on a row booked at nine hundred pesos.
    zeros: zeros.sort((a, b) => b.valor - a.valor || a.item.idarticulo - b.item.idarticulo),
    trailing,
    notes: groupNotes(notes),
  };
}

function groupNotes(notes: readonly ReviewNote[]): ReviewNotes {
  const porContador = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const key = note.counterId ?? '';
    const bucket = porContador.get(key);
    if (bucket) bucket.push(note);
    else porContador.set(key, [note]);
  }
  return {
    porContador: [...porContador.entries()]
      .map(([counterId, notas]) => ({
        counterId: counterId === '' ? null : counterId,
        nombre: notas[0].nombre,
        notas: notas.slice().sort((a, b) => compareEvents(a.event, b.event)),
      }))
      .sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0)),
    sueltas: notes
      .filter((note) => note.event.idarticulo === null)
      .sort((a, b) => compareEvents(a.event, b.event)),
  };
}

/**
 * The advisory tier of the pre-seal panel (§6).
 *
 * **None of these blocks.** They sit under the blocking list —
 * `sessionReadyToSeal`, which cannot be clicked past — and the difference must
 * be legible on the screen, because presenting a thing somebody may proceed
 * over and a thing they may not under one heading teaches them that neither
 * means much.
 */
export function reviewChecklist(review: Review): AdvisoryItem[] {
  const items: AdvisoryItem[] = [];
  const push = (kind: AdvisoryItem['kind'], filas: number, valor: number) => {
    if (filas > 0) items.push({ kind, filas, valor });
  };

  push('sin-contar', review.pendiente.items, review.pendiente.exposicion);
  push(
    'ceros',
    review.zeros.length,
    review.zeros.reduce((sum, zero) => sum + zero.valor, 0),
  );
  push('overlap', review.overlaps.length, 0);
  push('post-finish', review.amendments.length, 0);
  push('retraccion-final', review.trailing.length, 0);
  push(
    'waiver-superado',
    review.superseded.length,
    0,
  );
  push('notas-sueltas', review.notes.sueltas.length, 0);
  return items;
}

/**
 * What a bulk waiver is about to do, priced (§4d).
 *
 * Computed rather than counted off the screen so the confirmation cannot say a
 * different number from the one that will be signed.
 */
export function waiverPreview(
  rows: readonly ReviewRow[],
  idarticulo: readonly number[],
): { filas: number; valor: number; exposicion: number } {
  const wanted = new Set(idarticulo);
  const chosen = rows.filter((row) => wanted.has(row.item.idarticulo));
  return {
    filas: chosen.length,
    valor: chosen.reduce((sum, row) => sum + bookValue(row.item), 0),
    exposicion: chosen.reduce((sum, row) => sum + exposureValue(row.item), 0),
  };
}

/** Whether an `anular_waiver` names something that can still be withdrawn. */
export function annullable(
  actions: readonly SessionActionRecord[],
  waiverId: string,
): { ok: true } | { ok: false; reason: 'no-existe' | 'no-es-waiver' | 'ya-anulado' } {
  const target = actions.find((action) => action.id === waiverId);
  if (!target) return { ok: false, reason: 'no-existe' };
  if (target.kind !== 'waiver') return { ok: false, reason: 'no-es-waiver' };
  const annulled = actions.some(
    (action) =>
      action.kind === 'anular_waiver' &&
      (action.payload as AnularWaiverPayload).waiverId === waiverId,
  );
  return annulled ? { ok: false, reason: 'ya-anulado' } : { ok: true };
}

/** The articles a `waiver` payload may name: in the catalogue, and not repeated. */
export function waiverBlockers(input: {
  items: readonly Pick<Item, 'idarticulo'>[];
  payload: WaiverPayload;
}): { kind: 'vacio' | 'sin-motivo' | 'desconocido' | 'repetido'; idarticulos?: number[] }[] {
  const blockers: ReturnType<typeof waiverBlockers> = [];
  const catalogue = new Set(input.items.map((item) => item.idarticulo));
  if (input.payload.idarticulo.length === 0) blockers.push({ kind: 'vacio' });
  if (input.payload.motivo.trim() === '') blockers.push({ kind: 'sin-motivo' });

  const unknown = input.payload.idarticulo.filter((id) => !catalogue.has(id));
  if (unknown.length > 0) {
    blockers.push({ kind: 'desconocido', idarticulos: [...new Set(unknown)].sort((a, b) => a - b) });
  }
  const duplicated = input.payload.idarticulo.filter(
    (id, index, all) => all.indexOf(id) !== index,
  );
  if (duplicated.length > 0) {
    blockers.push({
      kind: 'repetido',
      idarticulos: [...new Set(duplicated)].sort((a, b) => a - b),
    });
  }
  return blockers;
}
