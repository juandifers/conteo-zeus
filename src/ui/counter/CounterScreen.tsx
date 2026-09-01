/**
 * The counter's tablet, from the link to «Terminar».
 *
 * What P2.2 owns here is the *sync* behaviour and nothing else: preparing the
 * device (P2.1), and the finish button with the banner behind it. **The entry
 * screens are P2.3** — there is no keypad here, no tally, no search. What this
 * screen proves is that the pieces underneath them work: a chain that starts in
 * the right place, an outbox that survives a reboot, a finish that degrades
 * instead of hanging.
 *
 * The boot order is deliberate and is the offline guarantee in miniature: the
 * assignment is read from Dexie first, the chain start is taken from this
 * device's own rows if it has any, and the network is consulted **only** when
 * there is nothing local — which is the replacement-tablet case and no other.
 */
import { useCallback, useEffect, useState } from 'react';

import type {
  CounterChainRepository,
  CounterPayload,
  CountRepository,
  DeviceRepository,
} from '../../domain';
import type { AssignmentStore } from '../../store';
import type { Api } from '../api';
import { localOutbox } from '../outbox';
import { CountStore } from '../store';
import { FinishPanel } from './Finish';
import { Prepare } from './Prepare';
import { bootCounter, type ChainStart } from './boot';
import { CounterSync } from './sync';

interface Live {
  store: CountStore;
  sync: CounterSync;
  start: ChainStart;
}

export function CounterScreen({
  token,
  api,
  assignments,
  repo,
  chain,
}: {
  token: string;
  api: Api;
  assignments: AssignmentStore;
  repo: CountRepository & DeviceRepository;
  chain: CounterChainRepository;
}) {
  const [payload, setPayload] = useState<CounterPayload | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const onReady = useCallback((held: CounterPayload) => {
    setPayload((current) => (current?.counter.id === held.counter.id ? current : held));
  }, []);

  useEffect(() => {
    if (!payload) return;
    let alive = true;
    void (async () => {
      try {
        const boot = await bootCounter({
          chain,
          api,
          token,
          sessionId: payload.session.id,
          counterId: payload.counter.id,
          identify: () => repo.identify(),
        });
        if (!alive) return;

        // A session shaped for the counting store, built from the *allowlisted*
        // payload and nothing else. `items` is empty on purpose: the store's
        // tally counts states across a session's items, and P2.3 is what fills
        // this in from the sections the server sent. Not one Zeus figure is
        // available here to fill it with, which is the point (DOMAIN.md §2.1).
        const session = {
          id: payload.session.id,
          bodega: payload.session.bodega,
          fechaCorte: payload.session.fechaCorte,
          sourceHash: '',
          createdAt: '1970-01-01T00:00:00.000Z',
          items: [],
        };
        const store = new CountStore(repo, session, [], {
          usuario: payload.counter.nombre,
          deviceId: boot.device.deviceId,
          nextSeq: boot.nextSeq,
          zona: payload.secciones[0]?.nombre ?? '',
          outbox: localOutbox(),
          counterId: payload.counter.id,
          head: boot.head,
          chain,
          ...(boot.highWater === null ? {} : { highWater: boot.highWater }),
        });
        const sync = new CounterSync(api, chain, {
          sessionId: payload.session.id,
          counterId: payload.counter.id,
          token,
        });
        if (boot.serverEstado) sync.setDeviceEstado(
          boot.serverEstado === 'terminado_confirmado' ? 'terminado_confirmado' : 'contando',
        );
        await sync.refresh();
        if (!alive) return;
        setLive({ store, sync, start: boot });
      } catch (cause) {
        if (alive) setFailed(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [payload, api, chain, repo, token]);

  // Everything that means "there might be signal now": the `online` event, the
  // app coming back to the foreground, and a slow timer for the cases neither
  // fires on — a captive portal, a marginal access point.
  useEffect(() => {
    if (!live) return;
    return live.sync.listen(globalThis as unknown as {
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
    });
  }, [live]);

  return (
    <>
      <Prepare token={token} api={api} store={assignments} onReady={onReady} />
      {failed && (
        <div className="panel">
          <div className="banner" role="alert">
            No se pudo abrir el conteo en esta tableta: {failed}
          </div>
        </div>
      )}
      {live?.start.assumedFresh && (
        <div className="panel">
          <div className="banner" role="status">
            Esta tableta no tenía registros y no pudo confirmar con el servidor dónde va tu
            conteo. Si estás usando una tableta de repuesto, conéctate al wifi de la oficina
            antes de seguir.
          </div>
        </div>
      )}
      {live && <FinishPanel store={live.store} sync={live.sync} />}
    </>
  );
}
