// @vitest-environment jsdom
/**
 * The QR code on the printed sheet.
 *
 * Not a test of the library — that is `qrcode-generator`'s job. A test of the
 * wiring: that every dark module reaches the path, that none of them lands in
 * the quiet zone, and that the symbol carries the whole link. A code that is
 * one module out, or whose four-module margin has been eaten by the viewBox, is
 * a code a phone camera declines in a corridor and nobody can debug there.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';

import { QrCode } from '../../src/ui/components/QrCode';
import { counterLink, tokenInHash, adminRoute } from '../../src/ui/admin/links';

afterEach(cleanup);

const LINK = counterLink('A'.repeat(22), 'https://conteo.example.com');

describe('QrCode', () => {
  it('draws every dark module and no others', () => {
    const { container } = render(<QrCode value={LINK} title="Enlace" />);
    const path = container.querySelector('path')!.getAttribute('d')!;

    const reference = qrcode(0, 'M');
    reference.addData(LINK);
    reference.make();
    let dark = 0;
    const count = reference.getModuleCount();
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (reference.isDark(row, col)) dark++;
    }

    expect((path.match(/M/g) ?? []).length).toBe(dark);
  });

  it('keeps the four-module quiet zone the specification requires', () => {
    const { container } = render(<QrCode value={LINK} title="Enlace" />);
    const svg = container.querySelector('svg')!;
    const path = svg.getAttribute('viewBox')!;
    const [, , side] = path.split(' ').map(Number);

    const reference = qrcode(0, 'M');
    reference.addData(LINK);
    reference.make();
    expect(side).toBe(reference.getModuleCount() + 8);

    // No module is drawn at 0..3 or at side-4..side-1 on either axis.
    const d = container.querySelector('path')!.getAttribute('d')!;
    for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x)).toBeLessThan(side - 4);
      expect(Number(y)).toBeLessThan(side - 4);
    }
  });

  it('is labelled, because it is an image of a link', () => {
    render(<QrCode value={LINK} title="Enlace de Ana" />);
    expect(screen.getByRole('img', { name: 'Enlace de Ana' })).toBeTruthy();
  });

  it('grows with the link rather than truncating it', () => {
    // 22 characters of token on the end of a real hostname is already a
    // version-4 symbol; a fixed type number would have thrown or silently
    // dropped data.
    const long = counterLink('B'.repeat(22), 'https://conteo-de-inventario.example.company.com');
    const { container } = render(<QrCode value={long} title="Enlace" />);
    expect(container.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(1000);
  });
});

describe('routes', () => {
  it('builds a hash link, so a prepared tablet opens it with no network', () => {
    expect(counterLink('A'.repeat(22), 'https://x.test')).toBe(`https://x.test/#/c/${'A'.repeat(22)}`);
  });

  it('reads the token back out', () => {
    expect(tokenInHash(`#/c/${'A'.repeat(22)}`)).toBe('A'.repeat(22));
    expect(tokenInHash('#/admin')).toBeNull();
    expect(tokenInHash('')).toBeNull();
  });

  it('separates the admin routes from everything else', () => {
    expect(adminRoute('#/admin')).toEqual({ name: 'list' });
    expect(adminRoute('#/admin/abc')).toEqual({ name: 'session', id: 'abc' });
    expect(adminRoute('#/c/x')).toBeNull();
    // The counting app is what anything else means, including no hash at all —
    // which is what a tablet that was never given a link opens on.
    expect(adminRoute('')).toBeNull();
  });
});
