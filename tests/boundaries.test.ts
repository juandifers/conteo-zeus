/**
 * The dependency direction is the architecture, so it is asserted, not trusted.
 *
 *         src/lib/
 *            ^            ^
 *      src/zeus/     src/domain/     <- neither imports the other, ever
 *            ^            ^
 *            +- src/app/ -+          <- the only place they meet
 *                   ^
 *              src/store/
 *                   ^
 *               src/ui/              <- screens; never reaches src/zeus/
 *
 * The point of the rule: when Zeus access moves from files to ODBC, src/zeus/
 * is replaced and src/domain/ does not change. A single `import type` from the
 * domain into the adapter would quietly end that, which is why types count.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');

type Layer = 'lib' | 'zeus' | 'domain' | 'app' | 'store' | 'ui';

/** Which layers each layer may import from. */
const ALLOWED: Record<Layer, Layer[]> = {
  lib: [],
  zeus: ['lib'],
  domain: ['lib'],
  app: ['lib', 'zeus', 'domain'],
  store: ['lib', 'domain'],
  // The screens talk to the domain, reach the file format only through the
  // boundary, and name a concrete repository in exactly one file. They never
  // import src/zeus/: a component that knew what a `rawRow` was would be the
  // end of the rule, and the UI has no business knowing a count arrives as
  // tab-separated CP850.
  //
  // `src/lib/` is on the list because it is the leaf every layer is allowed to
  // use — it imports nothing and knows nothing, and the rule this file exists
  // to protect is about `zeus` and `domain` not meeting, which a base64 codec
  // has no bearing on. The upload screen needs one; `btoa` is not it
  // (src/lib/base64.ts).
  ui: ['lib', 'domain', 'app', 'store'],
};

/** Third-party packages each layer may import. */
const ALLOWED_PACKAGES: Record<Layer, string[]> = {
  lib: [],
  zeus: ['xlsx'],
  domain: [],
  app: [],
  store: ['dexie'],
  // `qrcode-generator` draws the counter links on the printed dispatch sheet.
  // A dependency rather than 250 lines of Reed-Solomon written here, and it is
  // bundled rather than fetched: this app has to work with no network.
  ui: ['react', 'react-dom', 'qrcode-generator'],
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

interface Edge {
  file: string;
  specifier: string;
  layer: Layer | null;
  bare: string | null;
}

function edgesFor(layer: Layer): Edge[] {
  const edges: Edge[] = [];
  for (const file of filesUnder(join(SRC, layer))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1];
      const shown = relative(SRC, file);
      // Asset imports (`?raw`) carry bytes, not code: nothing in them can be
      // called, so they cannot create the coupling this file guards against.
      // The one in the tree ships tools/verificador.html to the operator from
      // the close-out screen — the acta tells them to open it, and a file that
      // lives only in the repository is a file they could never have.
      if (specifier.endsWith('?raw')) continue;
      if (specifier.startsWith('.')) {
        const target = relative(SRC, resolvePath(dirname(file), specifier));
        const head = target.split('/')[0] as Layer;
        edges.push({ file: shown, specifier, layer: head, bare: null });
      } else if (!specifier.startsWith('node:')) {
        edges.push({ file: shown, specifier, layer: null, bare: specifier });
      }
    }
  }
  return edges;
}

describe('layer boundaries', () => {
  for (const layer of Object.keys(ALLOWED) as Layer[]) {
    it(`src/${layer}/ imports only ${ALLOWED[layer].join(', ') || 'itself'}`, () => {
      const violations = edgesFor(layer)
        .filter((edge) => edge.layer !== null)
        .filter((edge) => edge.layer !== layer && !ALLOWED[layer].includes(edge.layer!))
        .map((edge) => `${edge.file} -> ${edge.specifier}`);
      expect(violations).toEqual([]);
    });

    it(`src/${layer}/ pulls in only ${ALLOWED_PACKAGES[layer].join(', ') || 'no'} third-party code`, () => {
      const violations = edgesFor(layer)
        .filter((edge) => edge.bare !== null)
        .filter((edge) => !ALLOWED_PACKAGES[layer].includes(edge.bare!.split('/')[0]))
        .map((edge) => `${edge.file} -> ${edge.specifier}`);
      expect(violations).toEqual([]);
    });
  }

  it('src/domain/ never reaches into src/zeus/, in either direction', () => {
    const domainToZeus = edgesFor('domain').filter((edge) => edge.layer === 'zeus');
    const zeusToDomain = edgesFor('zeus').filter((edge) => edge.layer === 'domain');
    expect(domainToZeus).toEqual([]);
    expect(zeusToDomain).toEqual([]);
  });

  it('src/app/ is the place they meet — and it is the only one', () => {
    const app = edgesFor('app');
    expect(app.some((edge) => edge.layer === 'zeus')).toBe(true);
    expect(app.some((edge) => edge.layer === 'domain')).toBe(true);

    const others: Layer[] = ['lib', 'zeus', 'domain', 'store', 'ui'];
    const both = others.filter((layer) => {
      const edges = edgesFor(layer);
      return (
        edges.some((edge) => edge.layer === 'zeus') &&
        edges.some((edge) => edge.layer === 'domain')
      );
    });
    expect(both).toEqual([]);
  });

  it('src/lib/ is a leaf: it imports nothing at all', () => {
    expect(edgesFor('lib')).toEqual([]);
  });

  it('api/ shares the domain and the adapter rather than reimplementing either', () => {
    // `api/` sits where `src/ui/` sits: a consumer above `src/app/`, not a
    // layer inside it. It may reach the domain, the boundary and the leaf
    // library, and it may reach nothing else.
    //
    // **It may not import src/zeus/ directly**, and that restriction survived
    // P2.1 intact even though the server now parses a Zeus file. §1b requires
    // the server to re-parse `source_bytes` and re-run the §4.1 check before
    // committing a session — the client is a PWA whose cached build may be
    // weeks old, and a file that parses is not a file that means anything. But
    // it does that through `src/app/`, the one module where the two
    // vocabularies meet, so there is still exactly one implementation of the
    // check and exactly one place that knows what a CP850 tab-separated row is.
    //
    // It may not import src/store/ (Dexie, and a browser) or src/ui/ at all.
    const allowed = new Set(['lib', 'domain', 'app']);
    const files = filesUnder(join(SRC, '..', 'api'));
    expect(files.length).toBeGreaterThan(0);

    const forbidden: string[] = [];
    let reachesTheDomain = false;
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const target = relative(SRC, resolvePath(dirname(file), specifier));
        const head = target.split('/')[0];
        // A relative import that stays inside api/ resolves above src/ and
        // comes back with a leading `..`; those are the handler's own helpers.
        if (head.startsWith('..')) continue;
        if (head === 'domain') reachesTheDomain = true;
        if (!allowed.has(head)) forbidden.push(`${relative(SRC, file)} -> ${specifier}`);
      }
    }
    expect(forbidden).toEqual([]);
    // The rule `src/domain/chain.ts` exists to enforce: there must not be a
    // second implementation of the hash on the server, so the functions have to
    // be importing the first one.
    expect(reachesTheDomain).toBe(true);
  });

  /**
   * The counter bundle never reaches the review module — P2.4.
   *
   * `src/domain/ownWork.ts` is the seam that keeps quantities out of the
   * counting components; this is the same seam one layer up. `review.ts` reads
   * `existencia` and `costo` and derives variances out of both, which is exactly
   * right for the person who signs the acta and exactly wrong for a device in a
   * bodega. §2.1 governs the tablet and only the tablet, and the way to keep
   * that true under refactoring is to make the reach a test failure rather than
   * a review comment.
   *
   * The walk stops at `src/domain/index.ts` on purpose. It is a barrel that
   * re-exports every module in the domain, so following it would make every file
   * reachable from every file and the assertion would say nothing. What is
   * asserted instead is the thing that actually matters and that a bundler
   * actually keeps: **no file the counter renders imports a name the review
   * module exports**, by any route.
   */
  describe('the counter bundle does not import the review module (P2.4)', () => {
    /** Everything reachable from the counting screens, barrel excluded. */
    function counterClosure(): Set<string> {
      const seen = new Set<string>();
      const queue = filesUnder(join(SRC, 'ui', 'counter'));
      while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
          const specifier = match[1];
          if (!specifier.startsWith('.')) continue;
          const target = resolvePath(dirname(file), specifier);
          // The barrel: transparent, not followed. See the note above.
          if (target === join(SRC, 'domain') || target === join(SRC, 'domain', 'index')) continue;
          for (const candidate of [
            `${target}.ts`,
            `${target}.tsx`,
            join(target, 'index.ts'),
            join(target, 'index.tsx'),
          ]) {
            try {
              if (statSync(candidate).isFile()) {
                queue.push(candidate);
                break;
              }
            } catch {
              // Not this extension. The next candidate, or nothing at all —
              // a specifier that resolves to no file is a compile error, and
              // this test is not the place to report it.
            }
          }
        }
      }
      return seen;
    }

    /** Every name `src/domain/review.ts` exports, function or type. */
    function reviewExports(): string[] {
      const source = readFileSync(join(SRC, 'domain', 'review.ts'), 'utf8');
      return [
        ...source.matchAll(/export\s+(?:function|interface|type|const)\s+(\w+)/g),
      ].map((match) => match[1]);
    }

    it('no counting file imports one of its names, by any route', () => {
      const names = new Set(reviewExports());
      expect(names.size).toBeGreaterThan(8);

      const offenders: string[] = [];
      for (const file of counterClosure()) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(IMPORT)) {
          // The names inside the braces, with `type` prefixes and aliases
          // stripped. A default import cannot name one of these: the module has
          // no default export.
          const clause = source.slice(match.index ?? 0, (match.index ?? 0) + match[0].length);
          const braces = /\{([^}]*)\}/.exec(clause);
          if (!braces) continue;
          for (const raw of braces[1].split(',')) {
            const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (name !== '' && names.has(name)) {
              offenders.push(`${relative(SRC, file)} -> ${name}`);
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('and never reaches an admin screen either', () => {
      const admin = [...counterClosure()].filter((file) =>
        file.startsWith(join(SRC, 'ui', 'admin')),
      );
      expect(admin.map((file) => relative(SRC, file))).toEqual([]);
    });

    it('the closure is a real closure — it would pass on an empty walk', () => {
      const closure = counterClosure();
      // It reaches the store and the api port at least, or the walk stopped at
      // the first file and every assertion above is vacuous.
      expect(closure.size).toBeGreaterThan(12);
      expect([...closure].some((file) => file.includes(join('ui', 'store')))).toBe(true);
    });
  });

  it('the scanner actually sees imports — it would pass on an empty read', () => {
    // Guards against the regex silently matching nothing and every check above
    // becoming vacuous.
    expect(edgesFor('app').length).toBeGreaterThan(2);
    expect(edgesFor('zeus').length).toBeGreaterThan(5);
    expect(edgesFor('domain').length).toBeGreaterThan(2);
    expect(edgesFor('ui').length).toBeGreaterThan(10);
  });
});
