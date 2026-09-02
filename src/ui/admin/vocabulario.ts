/**
 * The two state vocabularies of the admin panel — brief §5.3.
 *
 * One screen used to show «despachada» (header), «Despachada 01/09» (meta),
 * «abierta hace 45 min» (body) and «contando» (counter): three vocabularies
 * for what is one or two states. The resolution of the brief's first open
 * question: `despachada` and `abierta` are the **same** server state
 * (`abierto` — dispatch is the only transition into it and `dispatchedAt` is
 * its timestamp), so one of them had to go. What survives is one axis for the
 * session and one for the counter, and every screen reads them from here.
 *
 * The internal estado strings are wire contract and never change; these are
 * the words a cost accountant reads.
 */
import { formatQty } from '../format';

/** borrador · en curso · en revisión · sellada · cerrada */
export function sessionWord(estado: string): string {
  switch (estado) {
    case 'abierto':
      return 'en curso';
    case 'revision':
      return 'en revisión';
    case 'sellado':
      return 'sellada';
    case 'cerrado':
      return 'cerrada';
    default:
      return estado;
  }
}

/**
 * sin empezar · contando · terminó · retirado.
 *
 * `terminado_incompleto` reads «terminó» here: whether their registros made
 * it to the server is an anomaly the action chip carries, not a state of the
 * person — they did finish.
 */
export function counterWord(estado: string): string {
  switch (estado) {
    case 'asignado':
      return 'sin empezar';
    case 'terminado_confirmado':
    case 'terminado_incompleto':
      return 'terminó';
    default:
      return estado;
  }
}

/** `1 tableta`, `2 tabletas` — «1 tabletas» never again (§5.3). */
export function unos(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? `1 ${singular}` : `${formatQty(n)} ${plural}`;
}
