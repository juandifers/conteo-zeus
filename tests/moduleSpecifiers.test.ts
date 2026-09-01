/**
 * Every relative import that Node itself has to resolve carries a file
 * extension.
 *
 * This is not a style rule. The serverless functions are not bundled: Vercel's
 * builder transpiles each `.ts` to a standalone `.js`, traces the graph with
 * `nft`, and ships the files as they are — specifiers untouched. `package.json`
 * says `"type": "module"`, so those files are real ESM, and real ESM has no
 * extension search and no directory index. `from './_store'` resolves under
 * Vite and under Vitest, which is why it was written that way and why nothing
 * in the repository noticed; in production every function threw
 * `ERR_MODULE_NOT_FOUND` at load and every route answered
 * `FUNCTION_INVOCATION_FAILED`.
 *
 * What makes this worth a test rather than a fixed commit is how the failure
 * arrived. The builder compiled with the wrong config, printed the diagnostics,
 * and deployed anyway — it logs TypeScript errors without failing the build. So
 * the deploy was green, the frontend was fine, and the only symptom was that
 * the entire backend was gone. One extensionless import added later would
 * reproduce that exactly, and nothing else in the checks would speak up.
 *
 * The scope is `api/` plus the four `src/` subtrees it reaches, which is
 * `tsconfig.api.json`'s `include` list — the files that end up in a function's
 * traced graph. `src/ui/` and the tests are outside it on purpose: those are
 * only ever resolved by Vite, which does search, and widening the rule to them
 * would be a convention rather than a constraint.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Exactly `tsconfig.api.json`'s `include`. */
const TRACED = ['api', 'src/lib', 'src/zeus', 'src/domain', 'src/app'];

const ROOT = resolve(import.meta.dirname, '..');

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...typescriptFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

const FILES = TRACED.flatMap((subtree) => typescriptFiles(join(ROOT, subtree)));

/** `from '…'`, `import '…'` and `import('…')`, relative specifiers only. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)'(\.[^']*)'/g;

interface Specifier {
  file: string;
  spec: string;
}

const SPECIFIERS: Specifier[] = FILES.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(SPECIFIER)].map((match) => ({
    file: file.slice(ROOT.length + 1),
    spec: match[1],
  }));
});

describe('the module graph the functions ship', () => {
  it('has something to check', () => {
    // A regex that stopped matching would make every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(30);
    expect(SPECIFIERS.length).toBeGreaterThan(100);
  });

  it('ends every relative specifier in .js', () => {
    const bare = SPECIFIERS.filter(({ spec }) => !spec.endsWith('.js'));
    // Named, not counted: the point of failing is to say which line to fix.
    expect(bare.map(({ file, spec }) => `${file}: ${spec}`)).toEqual([]);
  });

  it('points every relative specifier at a file that exists', () => {
    // `.js` that resolves to nothing is the same outage with a longer stack.
    // Node will not fall back to `.ts`, and neither does this.
    const missing = SPECIFIERS.filter(({ file, spec }) => {
      const target = resolve(ROOT, dirname(file), spec);
      return !existsSync(target.replace(/\.js$/, '.ts'));
    });
    expect(missing.map(({ file, spec }) => `${file}: ${spec}`)).toEqual([]);
  });

  it('keeps the tsconfig Vercel actually reads', () => {
    // The builder walks up from each entrypoint for a `tsconfig.json` and
    // extends the first one it finds. Without this file the walk reaches the
    // root solution config, which has no compilerOptions, and every function
    // compiles under TypeScript's defaults instead of ours.
    const path = join(ROOT, 'api/tsconfig.json');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('"extends": "../tsconfig.api.json"');
  });
});
