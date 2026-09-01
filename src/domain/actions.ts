/**
 * Counter changes after dispatch — P2.3.5.
 *
 * Four scenarios arrive from the bodega and they are one operation:
 *
 *     «Luis se fue enfermo, Pedro lo reemplaza»       swap
 *     «Vamos lentos, metamos a Carla»                 add
 *     «María fue asignada y nunca llegó»              remove
 *     «Ana terminó, que ayude con abarrotes»          rebalance
 *
 * All four are **reassigning articles between counters while a session is
 * open**, plus — sometimes — creating or retiring a counter. What is built here
 * is the reassignment primitive; the four are compositions of it, and building
 * four flows would produce four partial answers that disagree.
 *
 * ## The thing that makes this tractable
 *
 * **Assignments and events are separate tables and separate concerns** (§4,
 * DOMAIN.md §4). Luis counted sixty articles; those sixty events are attributed
 * to Luis by `counterId` on each event and stay that way for ever, whoever holds
 * the assignment afterwards. Reassignment moves responsibility for what is
 * *still to be done*. It rewrites no history and touches no chain.
 *
 * If a step in here ever seems to require moving, re-attributing or re-hashing
 * an event, it is wrong.
 *
 * ## What must not break
 *
 * | Invariant | Established | How reassignment threatens it |
 * |---|---|---|
 * | Every article assigned to exactly one counter | P2.1 | a move that is not atomic leaves an article with none or two |
 * | Disjoint assignments imply a commutative fold | P2.2, P2.3 | an article held by two counters at once breaks it |
 * | Attribution is by event, never by assignment | P2.0 | moving an assignment must not move or invalidate events |
 * | Chains are per counter and append-only | P2.2 | no chain surgery is permissible, ever |
 * | Sealing gates on `terminado_confirmado` only | P2.2 | a retired counter has no `finish` and would block sealing for ever |
 * | Counters see no quantities | P2.1, P2.3 | an inherited assignment must not leak what the predecessor found |
 *
 * The last two are answered elsewhere and named here so the connection is not
 * lost: `sync.ts` for the sealing gate, and `counterView.ts` for `yaRegistrados`
 * — a list of `idarticulo`s and nothing else, which is the same information the
 * neutral checkmark already carries.
 */
import {
  assignmentCoverage,
  type Assignment,
  type AssignmentCoverage,
  type Section,
  type SessionEstado,
} from './assignment';

/**
 * The kinds on the admin's chain: P2.3.5's four, and P2.4's two.
 *
 * **No payload here carries a quantity, and none ever may** (P2.4 §4a). A
 * waiver's value is `existencia` from `catalog_rows`; recording it again would
 * be a second copy of a figure that can disagree with the first, and there is
 * no reading of a disagreement between them that is not a problem. If an admin
 * action ever seems to need a number counted off a shelf, it is a count, and a
 * count belongs in `events` — where `cantidad text` exists precisely because
 * decimals do not survive a `numeric` round trip, and where `canonicalJson`'s
 * refusal of anything but safe integers would otherwise bite.
 */
export type SessionActionKind =
  | 'agregar_contador'
  | 'retirar_contador'
  | 'reasignar'
  | 'sellar_sin_registros'
  | 'waiver'
  | 'anular_waiver';

/** Sessions in which the partition may still be changed (§4a). */
export const REASSIGNABLE: ReadonlySet<SessionEstado> = new Set<SessionEstado>([
  'abierto',
  // Review is exactly when a gap is discovered and somebody is sent back, so it
  // is allowed here. The consequence is deliberate and worth stating: a session
  // can move backwards from «everyone finished», and a counter who was
  // `terminado_confirmado` can be handed work and reopen. «Todos terminaron» is
  // not final until the seal.
  'revision',
]);

/** One article changing hands. The wire shape §4a specifies, plus an optional destination. */
export interface Move {
  idarticulo: number;
  /** The counter who holds it now. Checked against the stored partition, never trusted. */
  from: string;
  to: string;
  /**
   * Where it lands, by section name. Optional, and usually omitted.
   *
   * When it is omitted the plan decides: a whole section changing hands is
   * *repointed* — same name, same zone, new holder — and a partial move gets a
   * new section named after the one it came from and the person receiving it.
   * See `resolveSection`.
   */
  seccion?: string;
}

/** A counter minted in the same transaction as the moves that give them work. */
export interface NewCounter {
  /** How `Move.to` refers to them before they have an id. */
  ref: string;
  nombre: string;
}

/** Why a reassignment is refused. Data, like `DispatchBlocker`: one list, two presentations. */
export type ReassignBlocker =
  | { kind: 'estado'; estado: SessionEstado }
  | { kind: 'sin-movimientos' }
  | { kind: 'sin-motivo' }
  | { kind: 'origen-no-tiene'; movimientos: { idarticulo: number; from: string }[] }
  | { kind: 'destino-desconocido'; counterIds: string[] }
  | { kind: 'destino-retirado'; counterIds: string[] }
  | { kind: 'articulo-desconocido'; idarticulos: number[] }
  | { kind: 'articulo-repetido'; idarticulos: number[] }
  | { kind: 'mismo-contador'; idarticulos: number[] }
  | { kind: 'nombre-repetido'; nombres: string[] }
  | { kind: 'seccion-de-otro'; nombres: string[] }
  | { kind: 'cobertura'; idarticulos: number[] };

/** A section created for the receiving counter, because only part of one moved. */
export interface NewSection {
  id: string;
  nombre: string;
  counterId: string;
}

/** A whole section changing hands: same name, same zone, new holder. */
export interface RepointedSection {
  id: string;
  nombre: string;
  from: string;
  to: string;
}

/** One move, with the section it lands in resolved. */
export interface ResolvedMove extends Move {
  sectionId: string;
}

export interface ReassignmentPlan {
  /** Counters minted here, with the ids the moves refer to. Empty for a plain move. */
  counters: { id: string; nombre: string; ref: string }[];
  createSections: NewSection[];
  repointSections: RepointedSection[];
  moves: ResolvedMove[];
  /** The partition **after** the moves, re-checked rather than assumed (§4a). */
  coverage: AssignmentCoverage;
}

export interface ReassignInput {
  estado: SessionEstado;
  /** The catalogue. A move naming an article that is not in it is a bug, not a gap. */
  items: readonly { idarticulo: number }[];
  /**
   * Every counter in the session, as the database holds them.
   *
   * `estado` is widened to `string` rather than `CounterEstado` because it
   * arrives from a text column: the state machine lives in `sync.ts` and the
   * schema deliberately has no check constraint, so this is the boundary where
   * a row becomes a value and it should say so.
   */
  counters: readonly { id: string; nombre: string; estado: string }[];
  sections: readonly Section[];
  /** The partition **as the database holds it**, never as a browser tab remembers it. */
  assignments: readonly Assignment[];
  moves: readonly Move[];
  nuevos?: readonly NewCounter[];
  motivo: string;
  /** Ids for the sections and counters this plan mints. */
  newId: () => string;
}

/**
 * Everything standing between this plan and the partition it describes.
 *
 * All of them at once, never the first: an admin who fixes a stale row and is
 * then told about the retired destination has been made to walk the same screen
 * twice for nothing.
 *
 * Every check here is re-run **inside the transaction** by the guards in
 * `reassignStatements`. This is not the belt to that pair of braces — it is the
 * half that can produce a readable answer, and the SQL is the half that is true
 * under concurrency.
 */
export function reassignBlockers(input: ReassignInput): ReassignBlocker[] {
  const blockers: ReassignBlocker[] = [];

  if (!REASSIGNABLE.has(input.estado)) blockers.push({ kind: 'estado', estado: input.estado });
  if (input.moves.length === 0) blockers.push({ kind: 'sin-movimientos' });
  if (input.motivo.trim() === '') blockers.push({ kind: 'sin-motivo' });

  const nuevos = input.nuevos ?? [];
  const existingNames = new Set(input.counters.map((counter) => counter.nombre.trim()));
  const repeated = nuevos
    .map((counter) => counter.nombre.trim())
    .filter((nombre, index, all) => existingNames.has(nombre) || all.indexOf(nombre) !== index);
  if (repeated.length > 0) {
    // Two counters called "Ana" on one printed sheet are two people nobody can
    // tell apart when a chain turns out to have a gap in it (P2.1).
    blockers.push({ kind: 'nombre-repetido', nombres: [...new Set(repeated)].sort() });
  }

  const refs = new Set(nuevos.map((counter) => counter.ref));
  const byCounter = new Map(input.counters.map((counter) => [counter.id, counter]));
  const catalogue = new Set(input.items.map((item) => item.idarticulo));
  const held = new Map(input.assignments.map((a) => [a.idarticulo, a]));

  const stale: { idarticulo: number; from: string }[] = [];
  const unknownTo = new Set<string>();
  const retiredTo = new Set<string>();
  const unknownArticle: number[] = [];
  const duplicated: number[] = [];
  const noop: number[] = [];
  const seen = new Set<number>();

  for (const move of input.moves) {
    if (seen.has(move.idarticulo)) duplicated.push(move.idarticulo);
    seen.add(move.idarticulo);
    if (!catalogue.has(move.idarticulo)) unknownArticle.push(move.idarticulo);
    // The stale-plan check. An admin whose browser tab is ten minutes old must
    // fail here rather than silently overwrite a move somebody else made.
    else if (held.get(move.idarticulo)?.counterId !== move.from) {
      stale.push({ idarticulo: move.idarticulo, from: move.from });
    }
    if (move.from === move.to) noop.push(move.idarticulo);
    if (refs.has(move.to)) continue;
    const target = byCounter.get(move.to);
    if (!target) unknownTo.add(move.to);
    else if (target.estado === 'retirado') retiredTo.add(move.to);
  }

  if (stale.length > 0) blockers.push({ kind: 'origen-no-tiene', movimientos: stale });
  if (unknownTo.size > 0) blockers.push({ kind: 'destino-desconocido', counterIds: [...unknownTo].sort() });
  if (retiredTo.size > 0) blockers.push({ kind: 'destino-retirado', counterIds: [...retiredTo].sort() });
  if (unknownArticle.length > 0) {
    blockers.push({ kind: 'articulo-desconocido', idarticulos: [...new Set(unknownArticle)].sort((a, b) => a - b) });
  }
  if (duplicated.length > 0) {
    blockers.push({ kind: 'articulo-repetido', idarticulos: [...new Set(duplicated)].sort((a, b) => a - b) });
  }
  if (noop.length > 0) {
    blockers.push({ kind: 'mismo-contador', idarticulos: [...new Set(noop)].sort((a, b) => a - b) });
  }

  // A destination section that exists and belongs to somebody else. `sections`
  // is unique on `(session_id, nombre)`, so this would otherwise surface as a
  // constraint violation with no readable message — and two zones with one name
  // are two places nobody can separate afterwards.
  const named = new Map(input.sections.map((section) => [section.nombre, section]));
  const stolen = new Set<string>();
  for (const move of input.moves) {
    if (move.seccion === undefined) continue;
    const existing = named.get(move.seccion);
    if (existing && existing.counterId !== move.to) stolen.add(move.seccion);
  }
  if (stolen.size > 0) blockers.push({ kind: 'seccion-de-otro', nombres: [...stolen].sort() });

  // Coverage on the **post-state**, re-run rather than reasoned about. Moves do
  // preserve coverage by construction, and this check is still what catches the
  // bug in the code that generated them (§4a).
  if (blockers.length === 0) {
    const coverage = assignmentCoverage(input.items, applyMoves(input.assignments, input.moves));
    if (!coverage.complete) {
      blockers.push({
        kind: 'cobertura',
        idarticulos: [...coverage.unassigned, ...coverage.duplicated.map((entry) => entry.idarticulo)],
      });
    }
  }

  return blockers;
}

/** The partition as it would be, with `section_id` left alone — coverage does not read it. */
function applyMoves(
  assignments: readonly Assignment[],
  moves: readonly Move[],
): Assignment[] {
  const to = new Map(moves.map((move) => [move.idarticulo, move.to]));
  return assignments.map((assignment) => {
    const target = to.get(assignment.idarticulo);
    return target === undefined ? assignment : { ...assignment, counterId: target };
  });
}

/**
 * The concrete writes, with every section resolved.
 *
 * Call only on a plan `reassignBlockers` accepted; it assumes the moves are
 * coherent and does not re-check them.
 *
 * ## Where a moved article lands
 *
 * An article must always be in a section, because a section's name **is** the
 * `zona` of every event emitted for it (P2.1 §3c, P2.3 G2) and an article with
 * no section is an article whose events would carry no zone. The move shape
 * §4a specifies does not name one, so the plan decides, and the two real
 * motions decide themselves:
 *
 *   - **A whole section changes hands** — the swap. The section is *repointed*:
 *     same row, same name, same zone, new holder. Pedro counting Luis's
 *     ALMACEN is standing in ALMACEN, and inventing a second name for the same
 *     shelf would put two zones on one place in the acta.
 *   - **Part of a section moves** — the rebalance. A new section is created for
 *     the receiving counter, named after the shelf and the person, because
 *     `sections` is unique on `(session_id, nombre)` and the original name is
 *     taken by the articles that did not move.
 *
 * An explicit `seccion` on the move overrides both, which is what the screen
 * uses when the admin knows the destination shelf by name.
 */
export function planReassignment(input: ReassignInput): ReassignmentPlan {
  const counters = (input.nuevos ?? []).map((counter) => ({
    id: input.newId(),
    nombre: counter.nombre.trim(),
    ref: counter.ref,
  }));
  const byRef = new Map(counters.map((counter) => [counter.ref, counter.id]));
  const nombreOf = new Map<string, string>([
    ...input.counters.map((counter) => [counter.id, counter.nombre] as const),
    ...counters.map((counter) => [counter.id, counter.nombre] as const),
  ]);

  const sectionOf = new Map(input.assignments.map((a) => [a.idarticulo, a.sectionId]));
  const sectionById = new Map(input.sections.map((section) => [section.id, section]));
  /** How many articles each section holds now — the test for "the whole section moved". */
  const sizeOf = new Map<string, number>();
  for (const assignment of input.assignments) {
    sizeOf.set(assignment.sectionId, (sizeOf.get(assignment.sectionId) ?? 0) + 1);
  }

  const resolved = input.moves.map((move) => ({
    ...move,
    to: byRef.get(move.to) ?? move.to,
    sourceSectionId: sectionOf.get(move.idarticulo) ?? '',
  }));

  /** Moves grouped by (source section, destination counter) — the unit a section is decided for. */
  const groups = new Map<string, typeof resolved>();
  for (const move of resolved) {
    const key = `${move.sourceSectionId} ${move.to} ${move.seccion ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(move);
    else groups.set(key, [move]);
  }

  const createSections: NewSection[] = [];
  const repointSections: RepointedSection[] = [];
  const taken = new Set(input.sections.map((section) => section.nombre));
  /** Sections created in this plan, so two groups landing in one name share it. */
  const minted = new Map<string, string>();
  const moves: ResolvedMove[] = [];

  for (const bucket of groups.values()) {
    const first = bucket[0];
    const source = sectionById.get(first.sourceSectionId);
    const wholeSection =
      first.seccion === undefined && source !== undefined && sizeOf.get(first.sourceSectionId) === bucket.length;

    let sectionId: string;
    if (first.seccion !== undefined) {
      const existing = input.sections.find(
        (section) => section.nombre === first.seccion && section.counterId === first.to,
      );
      const already = minted.get(`${first.to} ${first.seccion}`);
      if (existing) sectionId = existing.id;
      else if (already) sectionId = already;
      else {
        sectionId = input.newId();
        createSections.push({ id: sectionId, nombre: first.seccion, counterId: first.to });
        taken.add(first.seccion);
        minted.set(`${first.to} ${first.seccion}`, sectionId);
      }
    } else if (wholeSection) {
      sectionId = first.sourceSectionId;
      repointSections.push({
        id: sectionId,
        nombre: source!.nombre,
        from: source!.counterId ?? first.from,
        to: first.to,
      });
    } else {
      const base = `${source?.nombre ?? 'SIN SECCION'} · ${nombreOf.get(first.to) ?? first.to}`;
      const key = `${first.to} ${base}`;
      const already = minted.get(key);
      const reusable = input.sections.find(
        (section) => section.counterId === first.to && section.nombre === base,
      );
      if (already) sectionId = already;
      else if (reusable) sectionId = reusable.id;
      else {
        // `unique (session_id, nombre)` — a name held by somebody else's section
        // has to be stepped around rather than collided with.
        let nombre = base;
        for (let n = 2; taken.has(nombre); n++) nombre = `${base} (${n})`;
        sectionId = input.newId();
        createSections.push({ id: sectionId, nombre, counterId: first.to });
        taken.add(nombre);
        minted.set(key, sectionId);
      }
    }

    for (const move of bucket) {
      moves.push({ idarticulo: move.idarticulo, from: move.from, to: move.to, sectionId });
    }
  }

  return {
    counters,
    createSections,
    repointSections,
    moves,
    coverage: assignmentCoverage(input.items, applyMoves(input.assignments, moves)),
  };
}

// --- §4b: the hole, named rather than engineered around ---------------------

/** What the reassignment screen has to say before the admin presses the button. */
export interface HandoverRisk {
  counterId: string;
  nombre: string;
  /** When the server last accepted anything from them. `null` is «nunca». */
  lastServerAt: string | null;
  /** How many of the moved articles were theirs. */
  articulos: number;
}

/**
 * Counters whose work is about to be handed away while they may not know.
 *
 * **The unavoidable hole, and it is stated rather than engineered around.**
 * Luis is in the cold room with no signal. His articles are reassigned to
 * Pedro. Luis's tablet does not know and *cannot* know: counter sync is
 * push-only (DOMAIN.md §6.2) and there is no channel to a device in a bodega.
 * He keeps counting, his events arrive at 17:40, they are valid, and they are
 * attributed to him — correctly, because he did the counting. If Pedro counted
 * the same shelves, the fold sums both.
 *
 * **That is a real double count and nothing in the system can prevent it**,
 * because prevention requires reaching a device that is unreachable. What the
 * software can do is make the risk visible at the moment of the decision, and
 * record it so P2.4 reports an explained overlap rather than an anomaly:
 *
 *   - the screen says so, in words, with the time («Luis no ha sincronizado
 *     desde 10:14. Los artículos que reasignes pueden ser contados dos veces»);
 *   - the same list goes into the `reasignar` payload, so review can say «this
 *     was reassigned mid-count».
 *
 * Operationally the answer is a radio and a person: reassign when the counter
 * can be told.
 */
export function handoverRisk(
  input: {
    counters: readonly { id: string; nombre: string; lastServerAt: string | null }[];
    moves: readonly Move[];
    now: string;
    /** How long since the last push counts as «not recently seen». */
    staleAfterMs?: number;
  },
): HandoverRisk[] {
  const stale = input.staleAfterMs ?? 15 * 60 * 1000;
  const now = Date.parse(input.now);
  const counted = new Map<string, number>();
  for (const move of input.moves) counted.set(move.from, (counted.get(move.from) ?? 0) + 1);

  const risks: HandoverRisk[] = [];
  for (const counter of input.counters) {
    const articulos = counted.get(counter.id);
    if (!articulos) continue;
    const last = counter.lastServerAt === null ? Number.NaN : Date.parse(counter.lastServerAt);
    // Never heard from, or not heard from lately. Both mean the same thing to
    // the person about to press the button: this tablet does not know.
    if (Number.isNaN(last) || now - last > stale) {
      risks.push({
        counterId: counter.id,
        nombre: counter.nombre,
        lastServerAt: counter.lastServerAt,
        articulos,
      });
    }
  }
  return risks.sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0));
}

// --- The payloads, as they are stored and hashed ----------------------------

export interface AgregarContadorPayload {
  counterId: string;
  nombre: string;
  motivo: string;
}

export interface RetirarContadorPayload {
  counterId: string;
  nombre: string;
  motivo: string;
}

export interface ReasignarPayload {
  motivo: string;
  movimientos: { idarticulo: number; from: string; to: string; sectionId: string }[];
  seccionesCreadas: NewSection[];
  seccionesReapuntadas: RepointedSection[];
  /** §4b, pre-armed for P2.4: whose work was moved while they might not know. */
  sinSincronizar: HandoverRisk[];
}

export interface SellarSinRegistrosPayload {
  counterId: string;
  nombre: string;
  motivo: string;
  /** The sequence range known to be missing, as `checkFinishManifest` spells it. */
  faltan: string;
  /** The highest `seq` the server held when this was signed. */
  storedMaxSeq: number;
}

/**
 * «Nobody counted these and I accept that» — P2.4 §4.
 *
 * The admin's resolution for untouched rows, and the decision an auditor asks
 * about first, which is why it is on a chain with a name and a reason on it
 * rather than a column somebody set.
 *
 * **No quantity.** See `SessionActionKind`. The waived value is `existencia`
 * from the catalogue, priced at the moment somebody reads the acta rather than
 * copied into the payload where it could drift.
 */
export interface WaiverPayload {
  idarticulo: number[];
  motivo: string;
}

/**
 * Withdrawing a waiver — append-only, exactly like a scoped retraction.
 *
 * The original action stays on the chain for ever; this one names it. Deleting
 * or mutating an action would be the one act the chain exists to make
 * impossible, and «I waived 1 800 rows and then thought better of it» is a
 * fact about the afternoon rather than an embarrassment to be tidied away.
 */
export interface AnularWaiverPayload {
  /** `session_actions.id` of the `waiver` this withdraws. */
  waiverId: string;
  motivo: string;
}

export type ActionPayload =
  | AgregarContadorPayload
  | RetirarContadorPayload
  | ReasignarPayload
  | SellarSinRegistrosPayload
  | WaiverPayload
  | AnularWaiverPayload;

/** One stored admin action, as every reader of the log sees it. */
export interface SessionActionRecord {
  id: string;
  sessionId: string;
  seq: number;
  kind: SessionActionKind;
  payload: ActionPayload;
  usuario: string;
  /** The client's stamp, hashed. `serverAt` is beside it and is not. */
  at: string;
  serverAt: string;
  prevHash: string;
  hash: string;
}

/**
 * Sessions sealed over a counter's missing work, by counter id.
 *
 * Read by `sessionReadyToSeal`, which is why it is derived from the log rather
 * than stored as a flag on `counters`: the flag would be a second copy of a fact
 * the chain already carries, and the two would drift the first time somebody
 * edited a row by hand — which is exactly the act this whole mechanism exists to
 * make impossible to do quietly.
 */
export function sealOverrides(
  actions: readonly SessionActionRecord[],
): Map<string, SellarSinRegistrosPayload> {
  const overrides = new Map<string, SellarSinRegistrosPayload>();
  for (const action of actions) {
    if (action.kind !== 'sellar_sin_registros') continue;
    const payload = action.payload as SellarSinRegistrosPayload;
    overrides.set(payload.counterId, payload);
  }
  return overrides;
}

/** A waiver that is still standing, with the action that carries it. */
export interface StandingWaiver {
  actionId: string;
  sessionId: string;
  seq: number;
  usuario: string;
  /** The client stamp, as hashed. */
  at: string;
  motivo: string;
  idarticulo: number[];
}

/**
 * The waivers still standing, oldest first — those no `anular_waiver` names.
 *
 * Derived from the log rather than stored, for the same reason `sealOverrides`
 * is: a flag on a row is a second copy of a fact the chain already carries, and
 * the two drift the first time somebody edits one by hand.
 *
 * An `anular_waiver` naming an action that is not a waiver, or one that was
 * already withdrawn, does nothing. Both are refused at the endpoint; neither is
 * an error *here*, because this function is asked about rows that are already
 * in the database and its job is to say what stands, not to litigate how the
 * log got that way.
 */
export function standingWaivers(
  actions: readonly SessionActionRecord[],
): StandingWaiver[] {
  const annulled = new Set<string>();
  for (const action of actions) {
    if (action.kind !== 'anular_waiver') continue;
    annulled.add((action.payload as AnularWaiverPayload).waiverId);
  }
  return [...actions]
    .sort((a, b) => a.seq - b.seq)
    .filter((action) => action.kind === 'waiver' && !annulled.has(action.id))
    .map((action) => {
      const payload = action.payload as WaiverPayload;
      return {
        actionId: action.id,
        sessionId: action.sessionId,
        seq: action.seq,
        usuario: action.usuario,
        at: action.at,
        motivo: payload.motivo,
        idarticulo: payload.idarticulo,
      };
    });
}

/**
 * The admin decisions that have to be printed on the acta, in the order they
 * were taken.
 *
 * **Not a footnote.** A count missing a known quantity of a named person's work
 * is a fact about the file somebody signs, and the whole value of the sealing
 * gate is that it cannot be satisfied by assertion — so when it *is* stepped
 * around, the step is on the page. Reassignments are on it for the related
 * reason: the acta says who counted what, and a shelf that changed hands at
 * eleven has two people behind it.
 */
export function actaLines(actions: readonly SessionActionRecord[]): string[] {
  return [...actions]
    .sort((a, b) => a.seq - b.seq)
    .map((action) => {
      switch (action.kind) {
        case 'agregar_contador': {
          const payload = action.payload as AgregarContadorPayload;
          return `Se agregó a ${payload.nombre} durante el conteo (${action.usuario}): ${payload.motivo}`;
        }
        case 'retirar_contador': {
          const payload = action.payload as RetirarContadorPayload;
          return `Se retiró a ${payload.nombre} durante el conteo (${action.usuario}): ${payload.motivo}`;
        }
        case 'reasignar': {
          const payload = action.payload as ReasignarPayload;
          const riesgo =
            payload.sinSincronizar.length > 0
              ? ` · sin sincronizar al momento del cambio: ${payload.sinSincronizar
                  .map((risk) => risk.nombre)
                  .join(', ')}`
              : '';
          return (
            `Se reasignaron ${payload.movimientos.length} artículos durante el conteo ` +
            `(${action.usuario}): ${payload.motivo}${riesgo}`
          );
        }
        case 'sellar_sin_registros': {
          const payload = action.payload as SellarSinRegistrosPayload;
          return (
            `ESTE CONTEO SE SELLÓ SIN LOS REGISTROS DE ${payload.nombre}: faltan ` +
            `${payload.faltan} (${action.usuario}): ${payload.motivo}`
          );
        }
        case 'waiver': {
          const payload = action.payload as WaiverPayload;
          // The sentence says what the file will claim, because the file cannot
          // say «no fuimos» — §4d. An acta that recorded «se exoneraron 1 806
          // filas» and stopped would leave the reader to work out that those
          // rows went into Zeus as counted and matching.
          return (
            `Se exoneraron ${payload.idarticulo.length} artículos sin contar ` +
            `(${action.usuario}): ${payload.motivo}. Van al archivo con la ` +
            'cantidad de Zeus, como si se hubieran contado y coincidido.'
          );
        }
        case 'anular_waiver': {
          const payload = action.payload as AnularWaiverPayload;
          return `Se anuló una exoneración (${action.usuario}): ${payload.motivo}`;
        }
      }
    });
}
