/**
 * Who counts what — sections, counters, and the gate in front of dispatch.
 *
 * A **section** is an admin-created named bucket of articles. Sections are
 * ours: the ERP has no concept of them, and nothing about one is ever written
 * back into a Zeus file. One counter per section; a counter may hold several.
 *
 * Three rules hold this together, and each of them is a decision rather than a
 * detail.
 *
 * **The resolved assignment is stored, not the rule that produced it.** The
 * admin builds sections by dragging whole families in, splitting one across
 * two people, then moving a handful of articles by hand — but what is written
 * down is one row per `idarticulo`. A rule ("everything with prefix 09") that
 * got re-evaluated later against a changed catalogue would be a silent
 * reassignment nobody authorised, and the person it moved work away from would
 * have no way to see that it happened.
 *
 * **Coverage is a hard gate.** Dispatch is refused unless every article in the
 * catalogue is assigned to exactly one counter. `assignmentCoverage` names the
 * gaps rather than counting them, because "23 sin asignar" is not something an
 * admin can act on at six on cutoff day.
 *
 * **Exactly one counter per article is enforced here, in the application, and
 * not in the schema.** The `assignments` primary key is
 * `(session_id, idarticulo, counter_id)`, so several counters per article is
 * representable — deliberately, because blind double-counting (two people
 * covering one section independently, their numbers compared rather than
 * summed) is a legitimate audit technique that this architecture supports
 * naturally, counters being unable to see each other's figures (DOMAIN.md
 * §2.1). P2 does not have that feature and the schema should not foreclose it.
 * If this check ever starts wanting an exception, that is the double-count
 * feature asking to exist, and it should be built rather than let in sideways.
 */
import { addDecimal } from '../lib/decimal';
import { familyPrefix } from './families';
import type { Item } from './types';
import { exposureValue } from './variance';

/** Where a session is. Only `borrador -> abierto` is implemented (P2.1). */
export type SessionEstado = 'borrador' | 'abierto' | 'revision' | 'sellado' | 'cerrado';

/**
 * Where a counter is, as far as the **server** can tell.
 *
 * There is deliberately no `terminado_local`: with no connectivity in the
 * bodega, a counter who recorded nothing looks exactly like a counter whose
 * tablet is holding 200 queued events (migrations/0001_init.sql).
 */
export type CounterEstado =
  | 'asignado'
  | 'contando'
  | 'terminado_confirmado'
  | 'terminado_incompleto';

/**
 * One person counting.
 *
 * Name only — no password, no account. `token` is a bearer credential in a URL
 * and is **not authentication**; see `docs/BACKEND.md`. It is minted from 128
 * bits of CSPRNG entropy (`src/lib/token.ts`) precisely because it is the only
 * thing standing between a stranger and a counter's view of one session.
 */
export interface Counter {
  id: string;
  nombre: string;
  token: string;
  estado: CounterEstado;
  /**
   * When this counter's device last pulled its assignment, or `null`.
   *
   * On the dispatch screen as `pendiente` / `descargado`, because a tablet that
   * walks into the bodega unloaded is a person who walks back out. There is no
   * signal in there, so this is the last moment anybody can notice.
   */
  fetchedAt: string | null;
}

/** A named bucket of articles, held by one counter. */
export interface Section {
  id: string;
  nombre: string;
  /** `null` while the admin is still building the partition. A blocker at dispatch. */
  counterId: string | null;
}

/**
 * One article, one counter, one section — the durable fact.
 *
 * `sectionId` rides along because the section's name becomes `zona` on every
 * event the counter emits for this article (DOMAIN.md §6). That is the
 * modelling move §6 said to make once, in the multi-device stage: `zona` stops
 * being a keystroke and becomes item data, assigned before anybody counts.
 */
export interface Assignment {
  idarticulo: number;
  counterId: string;
  sectionId: string;
}

/** What the partition covers, and what it does not. */
export interface AssignmentCoverage {
  /** Articles assigned exactly once. */
  assigned: number;
  /** In the catalogue, assigned to nobody. In catalogue order. */
  unassigned: number[];
  /** Assigned to more than one counter. P2 refuses these; see the module note. */
  duplicated: { idarticulo: number; counterIds: string[] }[];
  /** Assigned but not in this catalogue at all — a bug, not a gap. */
  foreign: number[];
  complete: boolean;
}

/**
 * The partition, checked against the catalogue it claims to cover.
 *
 * Two rows for one article and one counter are one assignment, not a
 * duplication: the same fact stated twice is not a disagreement about who
 * counts it.
 */
export function assignmentCoverage(
  items: readonly Item[],
  assignments: readonly Assignment[],
): AssignmentCoverage {
  const catalogue = new Set(items.map((item) => item.idarticulo));
  const byArticle = new Map<number, Set<string>>();
  for (const assignment of assignments) {
    const holders = byArticle.get(assignment.idarticulo) ?? new Set<string>();
    holders.add(assignment.counterId);
    byArticle.set(assignment.idarticulo, holders);
  }

  const unassigned: number[] = [];
  const duplicated: AssignmentCoverage['duplicated'] = [];
  let assigned = 0;
  for (const item of items) {
    const holders = byArticle.get(item.idarticulo);
    if (!holders || holders.size === 0) unassigned.push(item.idarticulo);
    else if (holders.size > 1) {
      duplicated.push({ idarticulo: item.idarticulo, counterIds: [...holders].sort() });
    } else assigned++;
  }

  const foreign = [...byArticle.keys()]
    .filter((idarticulo) => !catalogue.has(idarticulo))
    .sort((a, b) => a - b);

  return {
    assigned,
    unassigned,
    duplicated,
    foreign,
    complete: unassigned.length === 0 && duplicated.length === 0 && foreign.length === 0,
  };
}

/** A gap, grouped so it reads as a place to go rather than a list of numbers. */
export interface CoverageGap {
  prefix: string;
  idarticulos: number[];
  rows: number;
  /** DOMAIN.md §5: the produce group's book value is nothing and its exposure is not. */
  exposicion: number;
  ejemplos: string[];
}

/**
 * Unassigned articles by family, largest exposure first.
 *
 * Ranked on `exposicion` rather than `valor` for the §5 reason: 31 of the
 * sample's rows are perishables booked at zero, and a value-ordered gap list
 * would report the one family most likely to be holding unrecorded stock as
 * worth nothing.
 */
export function unassignedByFamily(
  items: readonly Item[],
  coverage: AssignmentCoverage,
): CoverageGap[] {
  const missing = new Set(coverage.unassigned);
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (!missing.has(item.idarticulo)) continue;
    const prefix = familyPrefix(item.codigo);
    const bucket = groups.get(prefix);
    if (bucket) bucket.push(item);
    else groups.set(prefix, [item]);
  }
  return [...groups]
    .map(([prefix, bucket]) => ({
      prefix,
      idarticulos: bucket.map((item) => item.idarticulo),
      rows: bucket.length,
      exposicion: bucket.reduce((total, item) => addDecimal(total, exposureValue(item)), 0),
      ejemplos: [...new Set(bucket.map((item) => item.nombre))].slice(0, 5),
    }))
    .sort((a, b) => b.exposicion - a.exposicion || a.prefix.localeCompare(b.prefix));
}

/**
 * A reason dispatch is refused. Data, not a sentence: the API returns these and
 * the screen renders them, so there is one list and two presentations of it.
 */
export type DispatchBlocker =
  | { kind: 'estado'; estado: SessionEstado }
  | { kind: 'archivo-cambiado' }
  | { kind: 'parametros-sin-verificar' }
  | { kind: 'sin-contadores' }
  | { kind: 'sin-asignar'; idarticulos: number[] }
  | { kind: 'doble-asignacion'; idarticulos: number[] }
  | { kind: 'fuera-del-catalogo'; idarticulos: number[] }
  | { kind: 'contador-vacio'; counterIds: string[] }
  | { kind: 'seccion-sin-contador'; sectionIds: string[] }
  | { kind: 'seccion-desconocida'; sectionIds: string[] }
  | { kind: 'contador-desconocido'; counterIds: string[] };

export interface DispatchInput {
  estado: SessionEstado;
  items: readonly Item[];
  counters: readonly Counter[];
  sections: readonly Section[];
  assignments: readonly Assignment[];
  /**
   * Whether the stored bytes still hash to the session's `sourceHash`.
   *
   * A boolean rather than the bytes, because the domain does not know what a
   * file is — `src/app/` computes it and hands over the answer. Same reason as
   * the next field.
   */
  archivoIntacto: boolean;
  /**
   * Whether this session's posting parameters are the verified triple
   * (ZEUS_FORMAT.md §7.1).
   *
   * A session created on untested parameters has to be an explicit, visible
   * act rather than a default somebody drifts into, so it blocks here and the
   * screen says which of the three is off. `countTargetColumn` and the rest are
   * Zeus column names; the domain has no business holding them, and
   * `src/app/parameters.ts` does.
   */
  parametrosVerificados: boolean;
}

/**
 * Everything standing between this session and `abierto`, all of it at once.
 *
 * All blockers, never the first: an admin who fixes the coverage gap and is
 * then told about the counter with no articles has been made to walk the same
 * screen twice for no reason.
 */
export function dispatchBlockers(input: DispatchInput): DispatchBlocker[] {
  const blockers: DispatchBlocker[] = [];

  if (input.estado !== 'borrador') blockers.push({ kind: 'estado', estado: input.estado });
  if (!input.archivoIntacto) blockers.push({ kind: 'archivo-cambiado' });
  if (!input.parametrosVerificados) blockers.push({ kind: 'parametros-sin-verificar' });
  if (input.counters.length === 0) blockers.push({ kind: 'sin-contadores' });

  const coverage = assignmentCoverage(input.items, input.assignments);
  if (coverage.unassigned.length > 0) {
    blockers.push({ kind: 'sin-asignar', idarticulos: coverage.unassigned });
  }
  if (coverage.duplicated.length > 0) {
    blockers.push({
      kind: 'doble-asignacion',
      idarticulos: coverage.duplicated.map((entry) => entry.idarticulo),
    });
  }
  if (coverage.foreign.length > 0) {
    blockers.push({ kind: 'fuera-del-catalogo', idarticulos: coverage.foreign });
  }

  // Referential integrity of the plan itself. These are bugs rather than
  // policy — an assignment naming a counter that does not exist is not a
  // decision anybody made — but they must not reach the database, where the
  // foreign keys would refuse them with a message no admin can read.
  const counterIds = new Set(input.counters.map((counter) => counter.id));
  const sectionIds = new Set(input.sections.map((section) => section.id));

  const unknownCounters = [
    ...new Set(
      input.assignments
        .map((assignment) => assignment.counterId)
        .filter((id) => !counterIds.has(id)),
    ),
  ].sort();
  if (unknownCounters.length > 0) {
    blockers.push({ kind: 'contador-desconocido', counterIds: unknownCounters });
  }

  const unknownSections = [
    ...new Set(
      input.assignments
        .map((assignment) => assignment.sectionId)
        .filter((id) => !sectionIds.has(id)),
    ),
  ].sort();
  if (unknownSections.length > 0) {
    blockers.push({ kind: 'seccion-desconocida', sectionIds: unknownSections });
  }

  const orphanSections = input.sections
    .filter((section) => section.counterId === null || !counterIds.has(section.counterId))
    .map((section) => section.id)
    .sort();
  if (orphanSections.length > 0) {
    blockers.push({ kind: 'seccion-sin-contador', sectionIds: orphanSections });
  }

  // "At least one article" and not "at least one section": a counter holding
  // two named sections and no articles is still somebody who walks into the
  // bodega with nothing to do.
  const holding = new Set(input.assignments.map((assignment) => assignment.counterId));
  const idle = input.counters
    .filter((counter) => !holding.has(counter.id))
    .map((counter) => counter.id);
  if (idle.length > 0) blockers.push({ kind: 'contador-vacio', counterIds: idle });

  return blockers;
}
