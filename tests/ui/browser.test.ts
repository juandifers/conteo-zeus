/**
 * Opened from a QR code, somewhere that is not Chrome (src/ui/counter/browser.ts).
 */
import { describe, expect, it } from 'vitest';

import { outsideChrome, outsideChromeAdvice } from '../../src/ui/counter/browser';

const CHROME =
  'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const WEBVIEW =
  'Mozilla/5.0 (Linux; Android 13; SM-X200 Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36';
const SAMSUNG =
  'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Safari/537.36';

describe('where a counter link was opened', () => {
  it('says nothing in Chrome, or on a desk, or in the test browser', () => {
    expect(outsideChrome(CHROME)).toBeNull();
    expect(outsideChrome('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/128.0.0.0')).toBeNull();
    expect(outsideChrome(undefined)).toBeNull();
  });

  it('knows a QR app’s built-in browser from another browser', () => {
    expect(outsideChrome(WEBVIEW)).toBe('app');
    expect(outsideChrome(SAMSUNG)).toBe('otro');
  });

  it('says move before the first entry, and stay after it', () => {
    expect(outsideChromeAdvice('app', false)).toMatch(/Antes de empezar, abre el enlace en Chrome/);
    const after = outsideChromeAdvice('app', true);
    expect(after).toMatch(/Sigue contando aquí mismo/);
    expect(after).not.toMatch(/abre el enlace en Chrome \(menú/);
  });
});
