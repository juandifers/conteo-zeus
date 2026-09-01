/**
 * Dispatch blockers, in Spanish, for the person who has to fix them.
 *
 * The domain returns them as data and the API passes them through unchanged, so
 * there is one list of reasons and this is its only rendering. A count of
 * blockers is not something anybody can act on; each of these names what is
 * wrong and, where the answer is "go and look", what to look at.
 */
import type {
  AdvisoryItem,
  DispatchBlocker,
  ReassignBlocker,
  ReviewFlag,
  SealBlocker,
} from '../../domain';

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


/**
 * Reassignment blockers, in Spanish (P2.3.5 §4a).
 *
 * The same discipline as `describeBlocker` above and for the same reason: the
 * domain returns them as data, the endpoint passes them through, and this is the
 * one place they become sentences. Each one names what is wrong; the two that
 * are usually the admin's own stale tab say so, because «vuelve a cargar» is the
 * whole fix and telling somebody to reload is kinder than letting them re-plan.
 */
export function describeReassign(
  blocker: ReassignBlocker,
  names: { counters?: Map<string, string> } = {},
): string {
  const counterName = (id: string) => names.counters?.get(id) ?? id;

  switch (blocker.kind) {
    case 'estado':
      return `Esta sesión está en «${blocker.estado}» y su reparto ya no se cambia.`;
    case 'sin-movimientos':
      return 'No seleccionaste nada que mover.';
    case 'sin-motivo':
      return (
        'Falta el motivo. Por qué un estante cambió de manos no se reconstruye después ' +
        'comparando dos tablas de asignaciones, y es lo primero que pregunta cualquiera.'
      );
    case 'origen-no-tiene':
      return (
        `${blocker.movimientos.length} artículos ya no son de quien esta pantalla cree ` +
        '(alguien más los movió). Vuelve a cargar y arma el movimiento otra vez.'
      );
    case 'destino-desconocido':
      return `El movimiento nombra contadores que no existen: ${list(blocker.counterIds)}.`;
    case 'destino-retirado':
      return (
        `${blocker.counterIds.map(counterName).join(', ')} está retirado del conteo. ` +
        'No se le puede asignar trabajo.'
      );
    case 'articulo-desconocido':
      return `El movimiento incluye artículos que no están en este archivo: ${list(blocker.idarticulos)}.`;
    case 'articulo-repetido':
      return `Hay artículos repetidos en el movimiento: ${list(blocker.idarticulos)}.`;
    case 'mismo-contador':
      return `Hay artículos que se mueven a quien ya los tiene: ${list(blocker.idarticulos)}.`;
    case 'nombre-repetido':
      return (
        `Ya hay alguien llamado ${blocker.nombres.join(', ')}. Dos contadores con un nombre ` +
        'en una hoja impresa son dos personas que nadie puede separar cuando una cadena ' +
        'aparece con un hueco.'
      );
    case 'seccion-de-otro':
      return `Las secciones ${blocker.nombres.join(', ')} son de otro contador.`;
    case 'cobertura':
      return (
        `Después del movimiento quedarían ${blocker.idarticulos.length} artículos sin dueño ` +
        `o con dos: ${list(blocker.idarticulos)}. Nadie caminaría hasta esos estantes.`
      );
  }
}

/**
 * Why this session cannot be sealed yet (P2.2 §2d, extended by P2.3.5 §5a).
 *
 * Rendered here rather than on the review screen because P2.4 and P2.5 both ask
 * the question and the answer must not be spelled two ways.
 */
export function describeSeal(blocker: SealBlocker): string {
  switch (blocker.kind) {
    case 'sin-contadores':
      return 'Esta sesión no tiene contadores: nadie fue despachado.';
    case 'contador-sin-terminar':
      return (
        `${blocker.nombre} está en «${blocker.estado}»` +
        (blocker.detalle ? ` — ${blocker.detalle}` : '') +
        '. El sello exige la cadena completa de cada contador, no que todos hayan tocado «terminar».'
      );
    case 'contador-bifurcado':
      return (
        `La cadena de ${blocker.nombre} se bifurcó: dos tabletas escribieron el mismo número. ` +
        'Nada de esto se resuelve solo.'
      );
    case 'contador-sin-descargar':
      return `La tableta de ${blocker.nombre} nunca descargó su asignación.`;
    case 'contador-retirado-incompleto':
      return (
        `${blocker.nombre} está retirado y al servidor le faltan registros suyos. ` +
        'Lo correcto es esperar la tableta; si no va a volver, hay que sellar sin sus ' +
        'registros — y eso queda escrito en el acta con nombre propio.'
      );
  }
}

/**
 * The advisory tier of the pre-seal panel (P2.4 §6).
 *
 * **None of these blocks**, and the wording has to make that legible next to
 * `describeSeal`, which is the list that cannot be clicked past. Presenting a
 * thing somebody may proceed over and a thing they may not under one heading
 * teaches them that neither means much.
 */
export function describeAdvisory(item: AdvisoryItem): string {
  switch (item.kind) {
    case 'sin-contar':
      return `${item.filas} filas que nadie tocó`;
    case 'ceros':
      return `${item.filas} registros en cero sobre filas con saldo en libros`;
    case 'overlap':
      return `${item.filas} artículos con registros de más de un contador`;
    case 'post-finish':
      return `${item.filas} registros hechos después de terminar`;
    case 'retraccion-final':
      return `${item.filas} contadores cuyo último movimiento fue deshacer`;
    case 'waiver-superado':
      return `${item.filas} exoneraciones que un conteo posterior dejó sin efecto`;
    case 'notas-sueltas':
      return `${item.filas} notas sin artículo — mercancía que el archivo no puede representar`;
  }
}

/**
 * A row flag, in the words the table prints beside it (P2.4 §3).
 *
 * Every one of them shows its arithmetic rather than a verdict. None of them is
 * phrased as an error and none offers a correction: the count is what somebody
 * saw, and an admin adjusting it here would be entering a number nobody
 * observed.
 */
export function describeFlag(flag: ReviewFlag): string {
  switch (flag.kind) {
    case 'overlap':
      return flag.causa === 'reasignado'
        ? 'dos contadores · cambió de manos durante el conteo'
        : 'dos contadores · nadie lo reasignó';
    case 'post-finish':
      return 'registrado después de terminar';
    case 'cero':
      return 'registrado en cero';
    case 'retraccion-final':
      return 'lo último aquí fue deshacer';
    case 'waiver-superado':
      return 'se exoneró y después alguien lo contó';
    case 'outlier':
      switch (flag.motivo) {
        case 'magnitud':
          return `conteo ${formatRatio(flag.ratio)}× la existencia`;
        case 'caja':
          return flag.invertido
            ? `conteo ≈ ${flag.factor}× la existencia — ¿cajas contra unidades?`
            : `existencia ≈ ${flag.factor}× el conteo — ¿unidades contra cajas?`;
        case 'entrada':
          return `una entrada ${formatRatio(flag.ratio)}× el resto de las de este artículo`;
      }
  }
}

/** A ratio, short enough to sit inside a sentence. */
function formatRatio(ratio: number): string {
  if (ratio >= 100) return String(Math.round(ratio));
  return ratio.toFixed(1).replace('.', ',').replace(',0', '');
}
