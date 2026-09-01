/**
 * Dispatch blockers, in Spanish, for the person who has to fix them.
 *
 * The domain returns them as data and the API passes them through unchanged, so
 * there is one list of reasons and this is its only rendering. A count of
 * blockers is not something anybody can act on; each of these names what is
 * wrong and, where the answer is "go and look", what to look at.
 */
import type { DispatchBlocker } from '../../domain';

/** How many ids a message prints before it stops being a list and becomes noise. */
const SHOWN = 8;

function list(ids: readonly (number | string)[]): string {
  const shown = ids.slice(0, SHOWN).join(', ');
  return ids.length > SHOWN ? `${shown} y ${ids.length - SHOWN} más` : shown;
}

export function describeBlocker(
  blocker: DispatchBlocker,
  names: { counters?: Map<string, string>; sections?: Map<string, string> } = {},
): string {
  const counterName = (id: string) => names.counters?.get(id) ?? id;
  const sectionName = (id: string) => names.sections?.get(id) ?? id;

  switch (blocker.kind) {
    case 'estado':
      return `Esta sesión ya está en «${blocker.estado}». Solo se despacha un borrador.`;
    case 'archivo-cambiado':
      return (
        'El archivo guardado ya no corresponde al que se importó. No se puede contar ' +
        'contra una foto del inventario distinta de la que se subió: vuelve a crear la sesión.'
      );
    case 'parametros-sin-verificar':
      return (
        'Esta sesión quedó con parámetros de subida que nunca se probaron contra Zeus ' +
        '(ZEUS_FORMAT.md §7.1). Créala de nuevo con los verificados, o asume el riesgo ' +
        'a propósito y con quién lo autorizó por escrito.'
      );
    case 'sin-contadores':
      return 'No hay contadores. Agrega al menos uno antes de despachar.';
    case 'sin-asignar':
      return (
        `${blocker.idarticulos.length} artículos no están asignados a nadie: ` +
        `${list(blocker.idarticulos)}. Nadie va a caminar hasta esos estantes.`
      );
    case 'doble-asignacion':
      return (
        `${blocker.idarticulos.length} artículos están asignados a dos contadores: ` +
        `${list(blocker.idarticulos)}. En P2 cada artículo lo cuenta exactamente una persona.`
      );
    case 'fuera-del-catalogo':
      return (
        `El reparto incluye artículos que no están en este archivo: ${list(blocker.idarticulos)}. ` +
        'Recarga la página: estás repartiendo contra un catálogo viejo.'
      );
    case 'contador-vacio':
      return (
        `${blocker.counterIds.map(counterName).join(', ')} no tiene artículos que contar. ` +
        'Asígnale una sección o quítalo del reparto.'
      );
    case 'seccion-sin-contador':
      return `${blocker.sectionIds.map(sectionName).join(', ')} no tiene contador asignado.`;
    case 'seccion-desconocida':
      return `El reparto nombra secciones que no existen: ${list(blocker.sectionIds)}.`;
    case 'contador-desconocido':
      return `El reparto nombra contadores que no existen: ${list(blocker.counterIds)}.`;
  }
}
