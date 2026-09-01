/**
 * Who is counting.
 *
 * **`zona` used to live here too, and deliberately does not any more** (P2.3).
 * A `ZONAS` dropdown offered seven names and stamped whichever one somebody had
 * last touched onto every event. P2.1 §3c made `zona` a different kind of fact:
 * `Section.nombre` *is* the zone of every article in that section, decided by
 * the admin at dispatch and the same fact coverage is gated on. Two writers to
 * one field means the log can disagree with the partition, and the disagreement
 * surfaces months later as an acta nobody can reconcile — so the claim gives
 * way to the fact, and the picker is gone rather than merely unused.
 *
 * P1 sessions have no partition and therefore no zone, which is the honest
 * answer: `ubicacion` is empty in Zeus, nothing is written back from this field
 * (ZEUS_FORMAT.md §9), and a stored preference was never evidence of where
 * anybody stood.
 *
 * `deviceId` used to live here and no longer does. The fold breaks ties on it,
 * so an id that a cleared storage bucket could regenerate would silently
 * reorder this tablet's own history against itself; it is now a row in the
 * database, created once, and the app refuses to count without it (§6).
 */

const USUARIO_KEY = 'conteo.usuario';
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
