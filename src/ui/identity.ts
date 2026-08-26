/**
 * Who is counting, and in which zone.
 *
 * `usuario` and `zona` are stamped on every event (`CountEventBase`) and owned
 * by no entity — DOMAIN.md §6 keeps them that way until the multi-device stage
 * turns the question from attribution into assignment. Until then they are a
 * preference, and a preference belongs in the browser.
 *
 * `deviceId` used to live here and no longer does. The fold breaks ties on it,
 * so an id that a cleared storage bucket could regenerate would silently
 * reorder this tablet's own history against itself; it is now a row in the
 * database, created once, and the app refuses to count without it (§6).
 */

const USUARIO_KEY = 'conteo.usuario';
const ZONA_KEY = 'conteo.zona';
const REVISA_KEY = 'conteo.revisa';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Private mode, or storage disabled. A count still has to be possible.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // As above: losing the preference is survivable, losing the count is not.
  }
}

export function loadUsuario(): string {
  return read(USUARIO_KEY) ?? '';
}

export function saveUsuario(usuario: string): void {
  write(USUARIO_KEY, usuario);
}

/**
 * Who signs the review off.
 *
 * A separate key from `usuario`, because they are separate people and the
 * whole point of the bulk waiver is whose name is on it. Sharing one key would
 * mean a supervisor opening the review screen on a counter's tablet silently
 * signing two hundred waivers as the counter.
 */
export function loadSupervisor(): string {
  return read(REVISA_KEY) ?? '';
}

export function saveSupervisor(usuario: string): void {
  write(REVISA_KEY, usuario);
}

/** Zones we suggest. Zeus's `ubicacion` column is empty, so this is where the
 * vocabulary starts — a fixed list first, and whatever the hotel actually says
 * afterwards. */
export const ZONAS = [
  'ALMACEN',
  'COCINA',
  'NEVERA',
  'CONGELADOR',
  'CAVA',
  'BAR',
  'PANADERIA',
] as const;

export function loadZona(sessionId: string): string {
  return read(`${ZONA_KEY}.${sessionId}`) ?? ZONAS[0];
}

export function saveZona(sessionId: string, zona: string): void {
  write(`${ZONA_KEY}.${sessionId}`, zona);
}
