/**
 * Opening a counter's session on a tablet.
 *
 * Three facts have to be true before the first tap, and only one of them is
 * local:
 *
 *   - the assignment is resident (P2.1 §4c — fetched on office wifi, read from
 *     Dexie thereafter);
 *   - this device has a `deviceId`, so its events can be ordered;
 *   - **the chain has a starting point.**
 *
 * The third is the one that needs care. A device that has already counted knows
 * where it is: `localChain` answers from its own rows and no network is
 * involved, which is the whole design — the tablet spends four hours in a cold
 * room and keeps appending. A device that holds nothing is either brand new, in
 * which case the chain starts at the genesis hash with `seq = 1`, or it is the
 * *spare somebody picked up when the first tablet died*, in which case the
 * counter has forty events on the server and starting over at 1 is a fork.
 *
 * The two are indistinguishable locally, so the server is asked. It is asked
 * only when there is nothing local, so the ordinary offline morning never
 * touches the network.
 */
import { genesisHash, type CounterChainRepository, type DeviceIdentity } from '../../domain';
import type { Api } from '../api';

export interface ResumePoint {
  storedMaxSeq: number;
  headHash: string;
  counterEstado: string;
  sessionEstado: string;
  lastClientAt: string | null;
  serverAt: string;
}

export interface ChainStart {
  /** The first `seq` this device may use. One-based (P2.2 §2a). */
  nextSeq: number;
  head: string;
  /** What the server said, when it was reachable. */
  serverEstado: string | null;
  /**
   * The latest `at` this counter has already been stamped with, if the server
   * knew of one. Seeds the store's clock watermark so a replacement tablet with
   * a slow clock cannot stamp events that sort before the ones they follow.
   */
  highWater: string | null;
  /**
   * True when this device holds nothing, could not reach the server, and is
   * assuming it is the first tablet. Correct almost always, and a fork when it
   * is not — so the screen says so rather than letting it be silent.
   */
  assumedFresh: boolean;
}

export async function chainStart(
  chain: CounterChainRepository,
  api: Api,
  token: string,
  sessionId: string,
  counterId: string,
): Promise<ChainStart> {
  const local = await chain.localChain(sessionId, counterId);
  if (local) {
    return {
      nextSeq: local.maxSeq + 1,
      head: local.head,
      serverEstado: null,
      // The store seeds its own watermark from the log it loads, which on a
      // device that has been counting is this device's own history.
      highWater: null,
      assumedFresh: false,
    };
  }

  try {
    const resume = await api.get<ResumePoint>(`/api/c/${token}/resume`);
    return {
      nextSeq: resume.storedMaxSeq + 1,
      head: resume.headHash,
      serverEstado: resume.counterEstado,
      highWater: resume.lastClientAt,
      assumedFresh: false,
    };
  } catch {
    // No network and no local chain. Almost always a tablet being opened for
    // the first time in a corridor, which is exactly right; the one case it is
    // wrong in — a replacement tablet that never reached the server — is the
    // one the screen has to name, because it ends in a fork nobody can undo.
    return {
      nextSeq: 1,
      head: genesisHash(sessionId, counterId),
      serverEstado: null,
      highWater: null,
      assumedFresh: true,
    };
  }
}

export interface CounterBoot extends ChainStart {
  device: DeviceIdentity;
}

export async function bootCounter(input: {
  chain: CounterChainRepository;
  api: Api;
  token: string;
  sessionId: string;
  counterId: string;
  identify: () => Promise<DeviceIdentity>;
}): Promise<CounterBoot> {
  const [device, start] = await Promise.all([
    input.identify(),
    chainStart(input.chain, input.api, input.token, input.sessionId, input.counterId),
  ]);
  // `device.nextSeq` is the P1 watermark — one device's own numbering across
  // every session it has ever held — and it is deliberately not used here. A P2
  // `seq` belongs to the *counter*: it has to survive the counter moving to a
  // spare tablet, and it has to start at 1 for a manifest to be checkable.
  return { ...start, device };
}
