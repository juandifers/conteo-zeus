/**
 * What a counter has done, and what is still open in their sections — P2.3.
 *
 * The gap list is the piece the original requirement asked for and the piece
 * P2.1's scoped assignment made possible: articles **in this counter's own
 * sections** with nothing standing against them. Not the catalogue, not another
 * counter's shelves. Well-defined because the assignment is scoped, and
 * actionable for the same reason — these are shelves this person walked past.
 *
 * Everything here returns ids and counts. Nothing returns a quantity, which is
 * the property that lets a counting screen ask «have I done this one» without
 * ending up holding a `Resolution` with `qty` on it (DOMAIN.md §2.1).
 */
import { describe, expect, it } from 'vitest';

import {
  ownLog,
  ownNotes,
  ownSummary,
  registeredArticles,
  sectionProgress,
  type AssignedSection,
} from '../../src/domain';
import { addCount, note, resetFactory, retract } from './factory';

const ANA = 'counter-ana';
const LUIS = 'counter-luis';

const SECTIONS: AssignedSection[] = [
  {
    id: 'sec-frio',
    nombre: 'Cuarto frío proteínas',
    items: [{ idarticulo: 1181 }, { idarticulo: 330 }, { idarticulo: 1595 }],
  },
  { id: 'sec-pan', nombre: 'Panadería', items: [{ idarticulo: 2165 }, { idarticulo: 67 }] },
];

describe('the gap list', () => {
  it('is every assigned article with nothing standing, in section order', () => {
    resetFactory();
    const events = [addCount(1181, 8, { counterId: ANA, seq: 1 })];
    expect(sectionProgress(SECTIONS, events, ANA)).toEqual([
      {
        id: 'sec-frio',
        nombre: 'Cuarto frío proteínas',
        total: 3,
        registrados: 1,
        heredados: 0,
        faltan: [330, 1595],
      },
      {
        id: 'sec-pan',
        nombre: 'Panadería',
        total: 2,
        registrados: 0,
        heredados: 0,
        faltan: [2165, 67],
      },
    ]);
  });

  it('counts a zero as counted — «fui al estante, está vacío» is work', () => {
    resetFactory();
    const events = [addCount(2165, 0, { counterId: ANA, seq: 1 })];
    expect(sectionProgress(SECTIONS, events, ANA)[1].faltan).toEqual([67]);
  });

  it('does not count a note — the remark is the reason to go back', () => {
    resetFactory();
    const events = [note(2165, '3 cajas sin código arriba', { counterId: ANA, seq: 1 })];
    expect(sectionProgress(SECTIONS, events, ANA)[1].faltan).toEqual([2165, 67]);
  });

  it('puts an article back when its only entry is withdrawn', () => {
    resetFactory();
    const entry = addCount(1181, 8, { counterId: ANA, seq: 1 });
    const undone = retract(1181, { retractsEventId: entry.id, counterId: ANA, seq: 2 });
    expect(sectionProgress(SECTIONS, [entry], ANA)[0].faltan).toEqual([330, 1595]);
    expect(sectionProgress(SECTIONS, [entry, undone], ANA)[0].faltan).toEqual([1181, 330, 1595]);
  });

  it('keeps it out when only one of two entries is withdrawn', () => {
    resetFactory();
    const first = addCount(1181, 8, { counterId: ANA, seq: 1 });
    const second = addCount(1181, 3, { counterId: ANA, seq: 2 });
    const undone = retract(1181, { retractsEventId: first.id, counterId: ANA, seq: 3 });
    expect(sectionProgress(SECTIONS, [first, second, undone], ANA)[0].faltan).toEqual([330, 1595]);
  });

  it('ignores another counter’s events entirely', () => {
    // Under P2.1's dispatch gate no two counters share an article, so this is
    // belt on top of braces — but the scoping is what makes the list *theirs*,
    // and a shared tablet holding two tokens is the shape that would break it.
    resetFactory();
    const theirs = addCount(1181, 8, { counterId: LUIS, seq: 1 });
    expect(sectionProgress(SECTIONS, [theirs], ANA)[0].faltan).toEqual([1181, 330, 1595]);
    expect(registeredArticles([theirs], ANA).size).toBe(0);
    expect(registeredArticles([theirs], LUIS)).toEqual(new Set([1181]));
  });

  it('the gaps are derivable by the admin from exactly what was pushed', () => {
    // «Finishing with gaps is permitted and the gaps reach the admin.» The gap
    // is not an event — it is the absence of one — so what has to travel is the
    // assignment (already the server's) and the counter's complete chain (what
    // the finish manifest proves). This is that computation, run over the
    // events a push would have delivered.
    resetFactory();
    const pushed = [
      addCount(1181, 8, { counterId: ANA, seq: 1 }),
      addCount(2165, 0, { counterId: ANA, seq: 2 }),
    ];
    const gaps = sectionProgress(SECTIONS, pushed, ANA).flatMap((section) => section.faltan);
    expect(gaps).toEqual([330, 1595, 67]);
  });
});

describe('«Mis registros» is chronological and hides nothing', () => {
  it('lists the entries, marks the withdrawn ones, and is not grouped by article', () => {
    resetFactory();
    const first = addCount(1181, 8, { counterId: ANA, seq: 1 });
    const other = addCount(2165, 2, { counterId: ANA, seq: 2 });
    const again = addCount(1181, 3, { counterId: ANA, seq: 3 });
    const undone = retract(1181, { retractsEventId: first.id, counterId: ANA, seq: 4 });

    const log = ownLog([first, other, again, undone], ANA);
    // Order is the order they happened, not 1181 / 1181 / 2165.
    expect(log.map((entry) => entry.event.id)).toEqual([first.id, other.id, again.id]);
    expect(log.map((entry) => entry.withdrawn)).toEqual([true, false, false]);
  });

  it('does not list the retractions themselves', () => {
    // They annotate their target, which is on screen struck through. A second
    // row saying the first was undone is a list twice as long saying the same.
    resetFactory();
    const first = addCount(1181, 8, { counterId: ANA, seq: 1 });
    const undone = retract(1181, { retractsEventId: first.id, counterId: ANA, seq: 2 });
    expect(ownLog([first, undone], ANA)).toHaveLength(1);
  });

  it('keeps notes on their own list, newest first', () => {
    resetFactory();
    const one = note(1181, 'primera', { counterId: ANA, seq: 1 });
    const two = note(null, 'segunda', { counterId: ANA, seq: 2 });
    expect(ownNotes([one, two], ANA).map((event) => event.id)).toEqual([two.id, one.id]);
    expect(ownLog([one, two], ANA)).toHaveLength(0);
  });
});

describe('the summary «Terminar» shows', () => {
  it('counts articles, entries, zeros and notes — and never a total', () => {
    resetFactory();
    const events = [
      addCount(1181, 8, { counterId: ANA, seq: 1 }),
      addCount(1181, 3, { counterId: ANA, seq: 2 }),
      addCount(2165, 0, { counterId: ANA, seq: 3 }),
      note(null, '3 cajas sin código', { counterId: ANA, seq: 4 }),
    ];
    expect(ownSummary(SECTIONS, events, ANA)).toEqual({
      registrados: 2,
      heredados: 0,
      sinRegistrar: 3,
      registros: 3,
      ceros: 1,
      notas: 1,
    });
    // Two entries on 1181 sum to 11, and no field of the summary is 11.
    expect(Object.values(ownSummary(SECTIONS, events, ANA))).not.toContain(11);
  });

  it('drops withdrawn entries from the counts', () => {
    resetFactory();
    const entry = addCount(1181, 8, { counterId: ANA, seq: 1 });
    const undone = retract(1181, { retractsEventId: entry.id, counterId: ANA, seq: 2 });
    expect(ownSummary(SECTIONS, [entry, undone], ANA)).toMatchObject({
      registrados: 0,
      heredados: 0,
      sinRegistrar: 5,
      registros: 0,
    });
  });

  it('is a valid and ordinary morning to have registered nothing', () => {
    // Assigned a section, walked over, found it already counted by receiving.
    expect(ownSummary(SECTIONS, [], ANA)).toEqual({
      registrados: 0,
      heredados: 0,
      sinRegistrar: 5,
      registros: 0,
      ceros: 0,
      notas: 0,
    });
  });
});

/**
 * The gap list a swapped counter inherits — P2.3.5 §6b.
 *
 * P2.3 defines the gap as «articles in my sections with no standing events
 * **from me**», which is right while assignments are disjoint and wrong the
 * moment Pedro inherits Luis's shelves: Pedro's finish screen would list
 * everything Luis already counted and send him to recount it, which is the
 * double count of §4b arriving by a second route.
 *
 * The fix is a set of ids in the assignment payload — presence, never magnitude
 * — and these are the four behaviours it has to have.
 */
describe('an inherited gap list', () => {
  const heredados = new Set([1181, 330]);

  it('drops what somebody else already registered', () => {
    resetFactory();
    const progress = sectionProgress(SECTIONS, [], ANA, heredados);
    expect(progress[0].faltan).toEqual([1595]);
    expect(progress[0].registrados).toBe(2);
    expect(progress[0].heredados).toBe(2);
  });

  it('counts an article the counter did register as theirs, not as inherited', () => {
    // Pedro can still count a shelf Luis counted — sometimes he should, if
    // Luis was ill and his numbers are suspect — and when he does it stops
    // being somebody else's work in the summary.
    resetFactory();
    const events = [addCount(1181, 8, { counterId: ANA, seq: 1 })];
    const progress = sectionProgress(SECTIONS, events, ANA, heredados);
    expect(progress[0].heredados).toBe(1);
    expect(progress[0].registrados).toBe(2);
  });

  it('changes nothing at all when nobody handed anything over', () => {
    // The two definitions coincide under disjoint assignments, which is every
    // session until a handover happens. This is why the parameter is optional
    // rather than threaded through every caller.
    resetFactory();
    const events = [addCount(1181, 8, { counterId: ANA, seq: 1 })];
    expect(sectionProgress(SECTIONS, events, ANA, new Set())).toEqual(
      sectionProgress(SECTIONS, events, ANA),
    );
  });

  it('separates «yo registré» from «hay algo registrado» in the summary', () => {
    resetFactory();
    const events = [addCount(2165, 3, { counterId: ANA, seq: 1 })];
    expect(ownSummary(SECTIONS, events, ANA, heredados)).toMatchObject({
      registrados: 3,
      heredados: 2,
      sinRegistrar: 2,
      registros: 1,
    });
  });
});
