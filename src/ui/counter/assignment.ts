/**
 * The assignment, in the shapes the counting screens need it in.
 *
 * One place rather than four `useMemo`s, because three of these — the search
 * index, the `codigo` grouping, the `idarticulo` lookup — are derived from the
 * same array and would otherwise be rebuilt independently on every render of
 * every tab.
 *
 * The fourth is not a convenience. `zonaFor` is the **only** source of `zona` in
 * the P2 write path (P2.3 G2): a section's name *is* the zone of every article
 * in it (P2.1 §3c), so the zone of an event is a lookup into the partition the
 * admin committed to at dispatch and never something a person selects. The
 * `ZONAS` dropdown that used to answer this question is gone.
 */
import { SECCION_COMPARTIDA, type CounterItem, type CounterPayload, type CounterSection } from '../../domain';
import { buildIndex, groupByCodigo, type IndexedItem } from '../search';

export interface CounterCatalogue {
  sections: readonly CounterSection[];
  /**
   * A shared session (P2.6): this tablet holds the whole catalogue, and so
   * does everybody else's. The screens read it to stop talking about «tu
   * sección» — the gap list is «what nobody had registered», not a debt.
   * Recognised by the synthesized section's constant id, which no sectioned
   * session can carry: real section ids are uuids minted at dispatch.
   */
  compartido: boolean;
  /** Every assigned article, in catalogue order across sections. */
  items: readonly CounterItem[];
  byId: ReadonlyMap<number, CounterItem>;
  /** Presentations under one `codigo` — one code covers up to five (ZEUS_FORMAT.md §4). */
  groups: ReadonlyMap<string, CounterItem[]>;
  index: readonly IndexedItem<CounterItem>[];
  /** The zone of one article. `''` for the session-scoped kinds. */
  zonaFor: (idarticulo: number | null) => string;
  /**
   * Articles somebody **else** had already registered when this device fetched
   * (P2.3.5 §6b).
   *
   * Empty for every counter who was not handed somebody else's shelves, which
   * is every counter until a handover happens. A `Set` rather than the payload's
   * array because every reader asks it the membership question and nothing asks
   * it for a length — and because a set of ids is, by construction, incapable of
   * carrying a magnitude.
   */
  heredados: ReadonlySet<number>;
}

export function catalogueOf(payload: CounterPayload): CounterCatalogue {
  const items: CounterItem[] = [];
  const byId = new Map<number, CounterItem>();
  const zonas = new Map<number, string>();
  for (const section of payload.secciones) {
    for (const item of section.items) {
      items.push(item);
      byId.set(item.idarticulo, item);
      zonas.set(item.idarticulo, section.nombre);
    }
  }
  return {
    sections: payload.secciones,
    compartido:
      payload.secciones.length === 1 && payload.secciones[0].id === SECCION_COMPARTIDA.id,
    items,
    byId,
    groups: groupByCodigo(items),
    index: buildIndex(items),
    // An article outside this counter's assignment has no zone here, and the
    // empty string is the honest answer: nothing invents a name for a shelf
    // this tablet was never sent to. In practice it is unreachable — the search
    // only offers assigned articles — which is why it is not an error.
    zonaFor: (idarticulo) => (idarticulo === null ? '' : zonas.get(idarticulo) ?? ''),
    // `?? []` because a payload stored by a build before P2.3.5 has no such
    // field, and a tablet that fetched last week must still open. An empty set
    // is exactly what that tablet's situation is: nobody handed it anything.
    heredados: new Set(payload.yaRegistrados ?? []),
  };
}
