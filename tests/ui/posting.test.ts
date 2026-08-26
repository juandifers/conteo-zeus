/**
 * The sentences and the file name on the last screen before an ERP posting.
 *
 * Out of the component tests because these are the pure parts: what the
 * confirmation asserts, and what the file is called. A default filename that
 * can repeat itself is a defect nobody sees until two adjustments for one
 * bodega are sitting in one folder.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/domain';
import { defaultFilename, formatCoverage } from '../../src/ui/posting';
import { sampleSession } from './harness';

const SESSION = sampleSession();

describe('defaultFilename', () => {
  it('keeps the imported base, swaps the extension, and states corte and sequence', () => {
    expect(defaultFilename(SESSION, 1)).toBe('COMESTIBLES ALMACEN - conteo 2025-04-30 #1.txt');
  });

  it('never names two files of one session the same thing', () => {
    // The whole point. A repeated default collides in the download folder, and
    // the browser resolves it silently by appending `(1)`.
    const names = new Set<string>();
    for (let n = 1; n <= 50; n++) names.add(defaultFilename(SESSION, n));
    expect(names.size).toBe(50);
  });

  it('writes the corte with no path separators in it', () => {
    // fechaCorte is the ERP's own `YYYY/MM/DD`, and a slash is a directory.
    expect(SESSION.fechaCorte).toContain('/');
    expect(defaultFilename(SESSION, 1)).not.toContain('/');
  });

  it('always ends .txt, whatever the count was imported from', () => {
    const fromTxt: Session = {
      ...SESSION,
      source: { name: 'COMESTIBLES ALMACEN.txt', bytes: new Uint8Array() },
    };
    expect(defaultFilename(SESSION, 2)).toMatch(/\.txt$/); // imported .xls
    expect(defaultFilename(fromTxt, 2)).toBe('COMESTIBLES ALMACEN - conteo 2025-04-30 #2.txt');
  });

  it('falls back to the bodega when the session kept no file', () => {
    const { source: _source, ...sourceless } = SESSION;
    expect(defaultFilename(sourceless, 1)).toBe('bodega 01 - conteo 2025-04-30 #1.txt');
  });

  it('keeps a dotted base intact, trimming only the last extension', () => {
    const dotted: Session = {
      ...SESSION,
      source: { name: 'COMESTIBLES.ALMACEN.v2.xls', bytes: new Uint8Array() },
    };
    expect(defaultFilename(dotted, 3)).toBe(
      'COMESTIBLES.ALMACEN.v2 - conteo 2025-04-30 #3.txt',
    );
  });
});

describe('formatCoverage', () => {
  it('rounds to a whole percentage', () => {
    expect(formatCoverage(0.8734)).toBe('87%');
    expect(formatCoverage(0)).toBe('0%');
    expect(formatCoverage(1)).toBe('100%');
  });
});
