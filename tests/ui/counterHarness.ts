/**
 * A counter's tablet, set up the way the server would have set it up.
 *
 * The assignment is built by projecting **real rows from the real bodega**
 * through `counterItem` — the same allowlist `GET /api/c/:token` uses — rather
 * than by hand. Two reasons: the ranking rules are only interesting where three
 * letters return a dozen rows (`EMPANADA DE MAIZ CARNE` contains `pan`), and a
 * hand-built fixture is a fixture that can quietly acquire a field the real
 * payload does not carry, which is the one thing the blindness tests are about.
 */
import {
  counterItem,
  genesisHash,
  MemoryChain,
  SECCION_COMPARTIDA,
  type CounterPayload,
} from '../../src/domain';
import { catalogueOf, type CounterCatalogue } from '../../src/ui/counter/assignment';
import { CountStore } from '../../src/ui/store';
import { fakeIdentity, sampleSession, seededRepository, SESSION_ID, ID } from './harness';

export const COUNTER = 'counter-ana';

/** Cold room first, bakery second — two sections, so `zona` has to be per-article. */
export const PROTEINAS = [ID.pancetaKilo, ID.pancetaPorcion300, ID.tilapia600];
export const PANADERIA = [ID.panTajado, ID.name];

export function samplePayload(
  options: {
    mostrarMarcaRegistrado?: boolean;
    /**
     * Articles somebody else had already registered when this tablet fetched
     * (P2.3.5 §6b). Empty unless a test is about a handover, which is the same
     * as saying: empty for every session in which nobody changed hands.
     */
    yaRegistrados?: readonly number[];
    /**
     * A shared session (P2.6): the same five articles, but served the way
     * `GET /api/c/:token` serves a session with zero sections — one synthesized
     * section, whose constant id is what the screens recognise.
     */
    compartido?: boolean;
  } = {},
): CounterPayload {
  const items = new Map(sampleSession().items.map((item) => [item.idarticulo, item]));
  const project = (ids: readonly number[]) =>
    ids.map((idarticulo) => counterItem(items.get(idarticulo)!));
  const secciones = options.compartido
    ? [{ ...SECCION_COMPARTIDA, items: project([...PROTEINAS, ...PANADERIA]) }]
    : [
        { id: 'sec-frio', nombre: 'Cuarto frío proteínas', items: project(PROTEINAS) },
        { id: 'sec-pan', nombre: 'Panadería', items: project(PANADERIA) },
      ];
  return {
    session: {
      id: SESSION_ID,
      bodega: '01',
      fechaCorte: '2026/08/25',
      nombre: 'Inventario agosto',
      mostrarMarcaRegistrado: options.mostrarMarcaRegistrado ?? true,
    },
    counter: { id: COUNTER, nombre: 'Ana' },
    secciones,
    yaRegistrados: [...(options.yaRegistrados ?? [])],
  };
}

export function sampleCatalogue(payload = samplePayload()): CounterCatalogue {
  return catalogueOf(payload);
}

/** A P2 store over that assignment, chained onto genesis and writing to `chain`. */
export async function counterStore(catalogue: CounterCatalogue = sampleCatalogue()) {
  const repo = await seededRepository();
  const chain = new MemoryChain();
  const store = new CountStore(
    repo,
    // `items` empty, exactly as `CounterScreen` builds it: there is no `Item`
    // on a counter's tablet, and therefore no `existencia` field to fill.
    { ...sampleSession(), items: [] },
    [],
    {
      ...fakeIdentity(),
      nextSeq: 1,
      counterId: COUNTER,
      head: genesisHash(SESSION_ID, COUNTER),
      chain,
      zonaFor: catalogue.zonaFor,
    },
  );
  return { store, chain, repo, catalogue };
}
