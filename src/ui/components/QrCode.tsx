/**
 * A counter's link, as a QR code.
 *
 * The tablets are shared and the links are 22 random characters on the end of a
 * URL. Somebody will otherwise type one, and a mistyped token is a 404 at the
 * one moment nobody has time for it — the tablet is being handed over, the
 * count is about to start, and the person holding it cannot see what went
 * wrong.
 *
 * Drawn as an SVG of one `<path>` rather than as a canvas or a grid of rects:
 * it prints at whatever size the sheet gives it, it survives a
 * `window.print()`, and it is a handful of elements rather than nine hundred.
 */
import qrcode from 'qrcode-generator';

/**
 * Error correction level.
 *
 * `M` — about 15% recoverable. `L` would make a slightly smaller symbol; these
 * are read off a sheet of paper that has been in somebody's back pocket and
 * then in a storeroom, and the modules are already small.
 */
const CORRECTION = 'M';

/** Quiet zone, in modules. Four is the specification's minimum and readers rely on it. */
const QUIET = 4;

export function QrCode({
  value,
  size = 160,
  title,
}: {
  value: string;
  /** Rendered width in CSS pixels. The SVG scales; the module grid does not. */
  size?: number;
  /** Read by a screen reader in place of the image. */
  title: string;
}) {
  // Type number 0 asks the library to pick the smallest version that fits.
  const qr = qrcode(0, CORRECTION);
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const side = count + QUIET * 2;

  // One path, one `d`, drawn in module units and scaled by the viewBox.
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
    >
      {/* Painted white rather than left transparent: a dark theme behind a QR
          code inverts it, and an inverted symbol is one most readers refuse. */}
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
