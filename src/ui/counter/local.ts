/**
 * A single-device count, shaped so the counter screens can run it.
 *
 * Since 2026-10 a file imported on the tablet is counted on the **same four
 * tabs** a dispatched counter uses — Contar, Mis registros, Notas, Terminar —
 * rather than on the older single-device screens. One way to count, taught
 * once: every quantity an independent registro, the keypad always empty, a
 * correction screen that lists what was entered and lets it be withdrawn.
 *
 * Nothing about the count leaves the tablet. There is no server, no link, no
 * push: the file came in from the device and the `.txt` goes out from it.
 * What makes it «the counter screens» is only the shape of the log, and that
 * shape is exactly a dispatched counter's:
 *
 *     Session.contadorLocal = { id, nombre }      set once, at import
 *            │
 *            ▼
 *     CountStore in counter mode
 *       counterId = contadorLocal.id               on every event
 *       head/seq  = this device's own chain        (or genesis, seq 1)
 *       chain     = the same outbox table          rows flagged `pendiente`,
 *                                                  which nothing ever drains:
 *                                                  no assignment row names
 *                                                  this counter (handover.ts)
 *
 * so the fold, «Mis registros», the scoped withdrawal and the gap list all
 * behave as they do on a dispatched tablet, because they are the same code
 * reading the same kind of log.
 *
 * Two deliberate differences:
 *
 *   - **`zona` is empty**, as it always was on this device. A dispatched
 *     section's name is a fact about where somebody stood; here there is one
 *     section, the whole bodega, and stamping it on every event says nothing.
 *   - **The reviewer may waive** (`sinServidor`). On a dispatched count the
 *     admin waives at the desk; here the review is on this same tablet, by the
 *     person who sees the book figures, and their signed bulk waiver goes into
 *     this counter's chain. The counter still cannot waive — `markUnchanged`
 *     refuses in counter mode, sinServidor or not.
 *
 * The catalogue is projected through `counterItem`, the same allowlist the
 * server applies to a dispatched payload: the store holds the session's items
 * for the review, but the counting tabs only ever see the projection.
 */
import {
  counterItem,
  genesisHash,
  type CounterChainRepository,
  type CounterPayload,
  type CountRepository,
  type DeviceRepository,
  type Session,
} from '../../domain';
import type { Outbox } from '../outbox';
import { CountStore } from '../store';
import { catalogueOf, type CounterCatalogue } from './assignment';

/** The one section a single-device count has: everything in the file. */
export const SECCION_LOCAL = { id: 'local', nombre: 'Toda la bodega' } as const;

/** Who counts on this tablet when nobody typed a name before importing. */
export const NOMBRE_SIN_ESCRIBIR = 'Conteo en esta tableta';

/**
 * A fresh identity for a single-device count. Minted at import and never
 * again: re-importing makes a new session, and a new session a new counter.
 */
export function nuevoContadorLocal(usuario: string): { id: string; nombre: string } {
  return { id: crypto.randomUUID(), nombre: usuario.trim() || NOMBRE_SIN_ESCRIBIR };
}

/** The session, as the counting tabs see it: names and codes, no figures. */
export function localPayload(session: Session): CounterPayload {
  const contador = requireLocal(session);
  return {
    session: {
      id: session.id,
      bodega: session.bodega,
      fechaCorte: session.fechaCorte,
      nombre: session.source?.name ?? null,
      // The neutral checkmark on: one person is doing the whole bodega, and
      // «did I already do this shelf» is the question it answers. Membership
      // only, never a magnitude (Registrado.tsx).
      mostrarMarcaRegistrado: true,
    },
    counter: contador,
    secciones: [{ ...SECCION_LOCAL, items: session.items.map(counterItem) }],
    // Nobody else counts here, so nobody could have registered anything first.
    yaRegistrados: [],
  };
}

export interface LocalCountState {
  store: CountStore;
  catalogue: CounterCatalogue;
  payload: CounterPayload;
}

/**
 * Open the count: this device's chain if it has one, genesis otherwise.
 *
 * Read from the rows, never assumed. A tablet that reloads mid-count must
 * continue the chain where it stands — `seq` from the last row plus one,
 * `prevHash` from its hash — or the next write collides with a row already on
 * disk and the store halts.
 */
export async function openLocalCount(input: {
  repo: CountRepository & DeviceRepository;
  chain: CounterChainRepository;
  session: Session;
  /** Stamped on every entry. Whoever is set to count now, else the import's name. */
  usuario: string;
  outbox: Outbox;
}): Promise<LocalCountState> {
  const { repo, chain, session } = input;
  const contador = requireLocal(session);
  const device = await repo.identify();
  const held = await chain.localChain(session.id, contador.id);
  const events = await repo.eventsForSession(session.id);

  const payload = localPayload(session);
  const catalogue: CounterCatalogue = { ...catalogueOf(payload), zonaFor: () => '' };

  const store = new CountStore(repo, session, events, {
    usuario: input.usuario.trim() || contador.nombre,
    deviceId: device.deviceId,
    nextSeq: held ? held.maxSeq + 1 : 1,
    zonaFor: catalogue.zonaFor,
    outbox: input.outbox,
    counterId: contador.id,
    head: held ? held.head : genesisHash(session.id, contador.id),
    chain,
    sinServidor: true,
  });
  return { store, catalogue, payload };
}

function requireLocal(session: Session): { id: string; nombre: string } {
  if (!session.contadorLocal) {
    throw new Error(
      `la sesión ${session.id} es de las anteriores (sin contador local) y se cuenta ` +
        'en las pantallas de antes; no se puede abrir como conteo de una tableta',
    );
  }
  return session.contadorLocal;
}
