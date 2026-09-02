/**
 * The counting surfaces show no figure that came out of Zeus — DOMAIN.md §2.1.
 *
 * Inventory sends counters out with nothing from the ERP, so this is a rule
 * about the product and not a preference somebody sets. It is asserted the way
 * the dependency direction is asserted, by reading the source, because that is
 * the only form of the assertion that a future edit cannot quietly walk past:
 * a rendering test can only catch what it happens to render, and this file is
 * a count of 298 items with fifteen ways to reach any one of them.
 *
 * What is forbidden is *reading a Zeus quantity or price*, not touching an
 * `Item`. These screens are made of `nombre`, `codigo` and `presentacion` and
 * must go on being. The list below is every field an ERP figure can enter
 * through, plus the two derivations of them (`itemVariance`, `formatMoney`) —
 * a variance is `existencia` arrived at by subtraction, and a peso total is
 * `existencia x costo` arrived at by multiplication. Neither is any less the
 * book figure for having been through arithmetic first.
 *
 * `byExposicion` is deliberately *not* forbidden. The faltantes list is
 * ordered by exposure and that ordering is the screen's whole purpose; what it
 * may not do is print the number behind the order.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Every file a counter's flow renders: sessions, the count screen and the
 * entry card, the search results, the state chip, the work list.
 *
 * The review screen is not one of them and is the one screen that must show
 * all of it — see §2.1. Nothing routes into it from here except a button the
 * counter can press, which is a limit named in the doc rather than a hole this
 * test is blind to.
 */
const COUNTING_SURFACES = [
  // The tablet's P2 entrance. It renders the assignment the server sent, and
  // the whole reason it can be trusted to is that the server never sent a
  // quantity — but a screen that reached for one anyway would be a screen
  // ready for the day somebody widens the payload.
  'ui/counter/Prepare.tsx',
  'ui/counter/CounterScreen.tsx',
  'ui/counter/Search.tsx',
  'ui/counter/Entry.tsx',
  'ui/counter/MyEntries.tsx',
  'ui/counter/Notes.tsx',
  'ui/counter/SyncBar.tsx',
  'ui/counter/Finish.tsx',
  'ui/counter/Registrado.tsx',
  'ui/counter/assignment.ts',
  'ui/counter/handover.ts',
  'ui/screens/CountScreen.tsx',
  'ui/screens/FaltantesScreen.tsx',
  'ui/components/EntryCard.tsx',
  'ui/components/ResultRows.tsx',
  'ui/components/StateChip.tsx',
  'ui/components/Topbar.tsx',
  // The update bar. It renders on the counter screen (a stale tablet was how
  // the two-tap register outlived its removal by a week), so it is held to
  // the same rule: nothing in it may reach for an ERP figure.
  'ui/components/UpdateNotice.tsx',
];

/** Ways an ERP figure reaches a screen. Property reads, and the two derivations. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['existencia', /\.existencia\b/],
  ['costo', /\.costo\b/],
  ['ultimoConteo', /\.ultimoConteo\b/],
  ['valor', /\.valor\b/],
  ['exposicion', /\.exposicion\b/],
  ['variance', /\bitemVariance\b|\.variance\b/],
  ['money', /\bformatMoney(Short)?\b/],
];

const read = (file: string) => readFileSync(resolvePath(SRC, file), 'utf8');

/** Comments explain what is absent and why; only code is under test. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no counting surface reads a Zeus figure (§2.1)', () => {
  for (const file of COUNTING_SURFACES) {
    it(file, () => {
      const source = code(read(file));
      for (const [name, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${file} reads ${name}`).toBe(false);
      }
    });
  }

  /**
   * The P2 surfaces, which are held to a **second** rule the P1 ones are not.
   *
   * P1's screens legitimately render a resolution: one device, one counter, and
   * `contado 70` is that counter's own number. On a tablet in a dispatched
   * session it is a *sum over an article* — the counter's three entries added
   * up, and under blind double-counting somebody else's too — which is exactly
   * the anchor §2.1 removes.
   *
   * So no counting component may hold a fold result scoped to an article. The
   * fold still decides what «registered» means; it happens in
   * `src/domain/ownWork.ts`, and what crosses back is a set of ids. That is the
   * whole reason that module exists.
   */
  const P2_COUNTING = [
    'ui/counter/CounterScreen.tsx',
    'ui/counter/Search.tsx',
    'ui/counter/Entry.tsx',
    'ui/counter/MyEntries.tsx',
    'ui/counter/Notes.tsx',
    'ui/counter/SyncBar.tsx',
    'ui/counter/Finish.tsx',
    'ui/counter/Registrado.tsx',
  ];

  const NO_FOLD: Array<[string, RegExp]> = [
    ['resolve()', /\bresolve(All)?\s*\(/],
    ['a Resolution', /\bResolution\b/],
    ['store.resolutionFor', /\bresolutionFor\b/],
    ['snapshot.resolutions', /\bresolutions\b/],
    ['StateChip', /\bStateChip\b/],
    ['the P1 tally', /\bformatQty\(\s*(resolution|current)/],
  ];

  for (const file of P2_COUNTING) {
    it(`${file} never holds a fold result for an article`, () => {
      const source = code(read(file));
      for (const [name, pattern] of NO_FOLD) {
        expect(pattern.test(source), `${file} reaches for ${name}`).toBe(false);
      }
    });
  }

  it('the domain answers «has this been registered» without handing back a quantity', () => {
    // Stated as a test because it is the seam the rule rests on: if
    // `registeredArticles` ever starts returning a map of quantities, every
    // assertion above goes on passing and the screens get the totals anyway.
    const own = code(read('domain/ownWork.ts'));
    expect(own).toMatch(/Set<number>/);
    // The only thing read off a fold in that module is the state.
    expect(own).toMatch(/resolve\(bucket\)\.state !== 'untouched'/);
    // And the only `qty` in it is one the counter typed — «is this entry a
    // zero» — never a resolved one.
    expect(own.match(/\.qty\b/g) ?? []).toHaveLength(1);
    expect(own).toMatch(/entry\.event\.kind === 'add' && entry\.event\.qty === 0/);
  });

  it('covers the whole of what a counter can open', () => {
    // A new screen under `ui/screens/` is a new surface, and the honest way to
    // find out whether it belongs on the list above is to be made to say so.
    const app = code(read('ui/App.tsx'));
    const routed = [...app.matchAll(/<(\w+Screen)\b/g)].map((match) => match[1]);
    expect(new Set(routed)).toEqual(
      new Set(['SessionsScreen', 'CountScreen', 'ReviewScreen', 'FaltantesScreen']),
    );
  });

  it('covers the P2 entrance too, and names where it is routed from', () => {
    const root = code(read('ui/Root.tsx'));
    expect(root).toMatch(/<CounterScreen\b/);
    expect(root).toMatch(/<AdminApp\b/);
    // `CounterScreen` is what `#/c/<token>` opens; everything a counter can
    // reach is rendered from there and is on the list above.
    const screen = code(read('ui/counter/CounterScreen.tsx'));
    expect(screen).toMatch(/<Prepare\b/);
    // JSX only: a `<` preceded by a word character is a type parameter
    // (`useState<Live | null>`), not an element.
    const rendered = [...screen.matchAll(/(?:^|[^\w.])<([A-Z]\w+)\b/gm)].map((match) => match[1]);
    expect(new Set(rendered)).toEqual(
      new Set([
        'Prepare',
        'Counting',
        'SyncBar',
        'Entry',
        'Search',
        'MyEntries',
        'Notes',
        'FinishPanel',
        'UpdateNotice',
      ]),
    );
  });

  it('says «somebody registered here» without ever saying how much (P2.3.5 §6b)', () => {
    // After a handover the checkmark can mean two things — your own work, or
    // the work of whoever held this shelf before you — and they get different
    // labels because a screen reader saying «ya registraste algo aquí» about
    // Luis's shelf tells somebody they did something they did not do.
    //
    // What both labels have in common is the property that matters: neither
    // carries a number, and neither can, because the component is handed two
    // booleans and nothing else.
    const mark = code(read('ui/counter/Registrado.tsx'));
    expect(mark).toMatch(/propio: boolean/);
    expect(mark).toMatch(/heredado: boolean/);
    expect(mark).not.toMatch(/\bnumber\b/);
    // And the set it is asked about is a set of ids, which cannot hold a
    // magnitude however anybody reads it.
    expect(code(read('ui/counter/assignment.ts'))).toMatch(/heredados: ReadonlySet<number>/);
  });

  it('leaves the review screen alone, because it is the reveal', () => {
    // Stated as a test so that "the counting screens hide it" is never read as
    // "the app hides it". Somebody has to look at the variances.
    const review = code(read('ui/screens/ReviewScreen.tsx'));
    expect(/\.existencia\b|\bformatMoney\b/.test(review)).toBe(true);
  });

  it('leaves the review module alone — it is the reveal, and it is fenced off', () => {
    // P2.4's `src/domain/review.ts` reads `existencia` and `costo` and derives
    // variances out of both, which is exactly right for the person who signs the
    // acta and exactly wrong for a device in a bodega. §2.1 is about the
    // counter, not about the app.
    //
    // The fence is not this test — `tests/boundaries.test.ts` walks the counter
    // bundle's module graph and refuses any import of a name this module exports.
    // What is asserted here is that the module really does hold the figures, so
    // that the fence is protecting something.
    const review = code(read('domain/review.ts'));
    expect(/\.existencia\b/.test(review)).toBe(true);
    expect(/\bexposureValue\b|\bbookValue\b/.test(review)).toBe(true);
  });

  it('leaves the admin screens alone, for the same reason', () => {
    // The person dividing a bodega into five sections is ranking shelves by
    // exposure and has to see the figures. §2.1 is about the counter, not about
    // the app — stated here so nobody reads the list above as "no screen may".
    const reparto = code(read('ui/admin/Reparto.tsx'));
    expect(/\bexposureValue\b|\bformatMoneyShort\b/.test(reparto)).toBe(true);
  });
});

/**
 * From P2 on, blindness is a property of what the **server sends**.
 *
 * P1 could only assert what the screens drew. That was already the stronger
 * form of the rule available at the time — but a screen can be changed by
 * anybody, and a figure that never left the database cannot be rendered by
 * accident. The tests below are about the projection rather than the render.
 */
describe('the payload a counter receives is an allowlist (§2.1)', () => {
  const source = code(read('domain/counterView.ts'));

  it('names its fields one by one, and does not spread an Item', () => {
    // `{ ...item }` minus a few keys is a denylist wearing an allowlist's
    // clothes: the next column added to `Item` ships. Every projection here has
    // to be a literal for the leak test in tests/domain/counterView.ts to mean
    // what it says.
    expect(source).not.toMatch(/\.\.\.item\b/);
    expect(source).not.toMatch(/\.\.\.row\b/);
    for (const field of ['idarticulo:', 'codigo:', 'nombre:', 'presentacion:', 'unidad:']) {
      expect(source).toContain(field);
    }
  });

  it('sends `yaRegistrados` as ids and folds it with the domain, not with SQL', () => {
    // P2.3.5 §6b widens the payload by exactly one field, and it is the one
    // shape that cannot carry a quantity: a list of `idarticulo`s. It is the
    // same information the neutral checkmark already conveys — presence, never
    // magnitude — which is why it is admissible at all.
    //
    // The fold behind it is `registeredArticles`, the same function the tablet
    // runs. Deciding what «registered» means in SQL would be a second definition
    // of the fold, and the two would disagree the first time a scoped retraction
    // landed.
    expect(source).toMatch(/yaRegistrados: number\[\]/);
    const handler = code(
      readFileSync(resolvePath(SRC, '..', 'api', 'c', '[token]', 'index.ts'), 'utf8'),
    );
    expect(handler).toMatch(/registeredArticles\(/);
    expect(handler).not.toMatch(/cantidad|qty/);
  });

  it('is the only thing api/c/[token] builds its response from', () => {
    const handler = code(
      readFileSync(resolvePath(SRC, '..', 'api', 'c', '[token]', 'index.ts'), 'utf8'),
    );
    expect(handler).toMatch(/counterPayload\(/);
    // Not the catalogue row, not `raw_row`, not the admin projection.
    expect(handler).not.toMatch(/existencia|costo|rawRow|raw_row/);
  });
});
