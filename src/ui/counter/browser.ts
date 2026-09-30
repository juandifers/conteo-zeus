/**
 * Whether this page is running somewhere other than the tablet's Chrome.
 *
 * A counter link travels as a QR code, and a QR scanner app often opens it in
 * its own built-in browser (an Android WebView) or in whatever browser the
 * tablet's maker ships. Each of those keeps its **own** IndexedDB: counts
 * registered there are invisible to Chrome, and opening the same link in
 * Chrome later starts a second chain for the same counter — measured, it ends
 * in DEVICE_COLLISION with the first browser's work stranded, or silently
 * sealed without it.
 *
 * The advice depends on whether counting has started here, and getting that
 * wrong is worse than saying nothing: before the first entry, move to Chrome;
 * after it, *stay* — switching now is the fork.
 *
 * User-agent sniffing, so it is a hint and not a gate: a false negative costs
 * what it cost before, and a false positive costs one sentence.
 */
export function outsideChrome(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  // Android WebView marks itself `; wv)`; in-app browsers name themselves.
  if (/; wv\)|FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\//.test(ua)) return 'app';
  if (/SamsungBrowser|Firefox\/|FxiOS|OPR\/|EdgA\/|UCBrowser|MiuiBrowser|HuaweiBrowser/.test(ua)) {
    return 'otro';
  }
  return null;
}

export function outsideChromeAdvice(where: 'app' | 'otro', counted: boolean): string {
  const place =
    where === 'app'
      ? 'Este enlace se abrió dentro de otra aplicación, no en Chrome.'
      : 'Este enlace se abrió en un navegador distinto de Chrome.';
  return counted
    ? `${place} Sigue contando aquí mismo hasta terminar y subir todo: si ahora lo abres ` +
        'en Chrome, empieza otra cuenta y lo de aquí no llega.'
    : `${place} Lo que registres aquí queda solo en esta ventana. Antes de empezar, ` +
        'abre el enlace en Chrome (menú ⋮ → «Abrir en Chrome») y cuenta desde allí.';
}
