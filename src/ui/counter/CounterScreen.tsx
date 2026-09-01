/**
 * The counter's tablet: the link, the shelf, and «Terminar».
 *
 * Four tabs and nothing else, because a counter holding a tablet in a cold room
 * with gloves on is doing exactly four things:
 *
 *     Contar         search → keypad → confirm → registered
 *     Mis registros  what I did, in order, and how to correct it
 *     Notas          what does not fit in a quantity
 *     Terminar       my own gaps, then done
 *
 * The boot order is deliberate and is the offline guarantee in miniature: the
 * assignment is read from Dexie first, the chain start is taken from this
 * device's own rows if it has any, and the network is consulted **only** when
 * there is nothing local — the replacement-tablet case and no other. Everything
 * after that renders from Dexie, and nothing on any of the four tabs waits on a
 * request to draw.
 *
 * Two things are wired here rather than inside a component, because both are
 * rules rather than presentation:
 *
 * `zonaFor` — the store's only source of `zona` (P2.3 G2). A section's name *is*
 * the zone of every article in it (P2.1 §3c). A counter holding two sections
 * emits events in two zones, so a fixed string would put the wrong shelf on most
 * of an afternoon, and the picker that used to answer this is gone.
 *
 * The background drain is wired here for the same reason: after a handover this
 * tablet can be holding two counters' outboxes, and the one whose owner went
 * home is the one nothing would otherwise look at (P2.3.5 §6a).
 *
 * `session.items` stays **empty**. The store's tally counts states across a
 * session's items and the counter's screens do not use it: their progress is
 * `sectionProgress`, over the assignment, which is the only list that is theirs.
 * Filling `items` would mean minting `Item`s — and an `Item` has `existencia`
 * and `costo` on it, which is a place for a figure to arrive later (DOMAIN.md
 * §2.1). There is nothing to fill them with here, and that is worth keeping true.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
  CounterChainRepository,
  CounterItem,
  CounterPayload,
  CountRepository,
  DeviceRepository,
} from '../../domain';
import { registeredArticles } from '../../domain';
import type { AssignmentStore } from '../../store';
import type { Api } from '../api';
import { localOutbox } from '../outbox';
import { CountStore } from '../store';
import { Entry } from './Entry';
import { FinishPanel } from './Finish';
import { MyEntries } from './MyEntries';
import { Notes } from './Notes';
import { Prepare } from './Prepare';
import { Search } from './Search';
import { SyncBar } from './SyncBar';
import { catalogueOf, type CounterCatalogue } from './assignment';
import { bootCounter, type ChainStart } from './boot';
import { drainOthers, otherOutboxes, type OtherOutbox } from './handover';
import { CounterSync } from './sync';

interface Live {
  store: CountStore;
  sync: CounterSync;
  start: ChainStart;
  catalogue: CounterCatalogue;
}

type Tab = 'contar' | 'registros' | 'notas' | 'terminar';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'contar', label: 'Contar' },
  { id: 'registros', label: 'Mis registros' },
  { id: 'notas', label: 'Notas' },
  { id: 'terminar', label: 'Terminar' },
];

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

        const catalogue = catalogueOf(payload);
        // Shaped for the counting store, built from the *allowlisted* payload
        // and nothing else — see the module note on why `items` is empty.
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
          zonaFor: catalogue.zonaFor,
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
        if (boot.serverEstado) {
          sync.setDeviceEstado(
            boot.serverEstado === 'terminado_confirmado' ? 'terminado_confirmado' : 'contando',
          );
        }
        await sync.refresh();
        if (!alive) return;
        setLive({ store, sync, start: boot, catalogue });
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
    return live.sync.listen(
      globalThis as unknown as {
        addEventListener: (type: string, fn: () => void) => void;
        removeEventListener: (type: string, fn: () => void) => void;
      },
    );
  }, [live]);

  if (failed) {
    return (
      <div className="screen">
        <div className="empty" role="alert">
          <div className="empty__title">No se pudo abrir el conteo en esta tableta</div>
          <div className="empty__body">{failed}</div>
        </div>
      </div>
    );
  }

  // Until the assignment is on the device and the chain has a starting point,
  // the preparation screen is the whole app — it is the one that can say «esta
  // tableta todavía no está lista» and offer a retry.
  if (!payload || !live) {
    return <Prepare token={token} api={api} store={assignments} onReady={onReady} />;
  }

  return (
    <Counting
      payload={payload}
      live={live}
      api={api}
      chain={chain}
      assignments={assignments}
    />
  );
}

function Counting({
  payload,
  live,
  api,
  chain,
  assignments,
}: {
  payload: CounterPayload;
  live: Live;
  api: Api;
  chain: CounterChainRepository;
  assignments: AssignmentStore;
}) {
  const { store, sync, catalogue } = live;
  const [tab, setTab] = useState<Tab>('contar');
  const [open, setOpen] = useState<CounterItem | null>(null);
  const [echo, setEcho] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [otros, setOtros] = useState<readonly OtherOutbox[]>([]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Membership only — never a resolution, never a quantity (§2.1).
  const registrados = useMemo(
    () => registeredArticles(snapshot.events, store.counterId),
    [snapshot.events, store.counterId],
  );

  /**
   * Somebody else's queue on this tablet (P2.3.5 §6a).
   *
   * The outbox has always been keyed by counter rather than by device, which is
   * what stops Pedro's arrival stranding Luis's morning. What this adds is that
   * something *looks* at it: a queue whose owner went home is otherwise a queue
   * nothing ever drains.
   *
   * Woken by the same three things the foreground drain is — `online`, the app
   * coming back, and a slow timer for the cases neither fires on — because they
   * are the same three moments a tablet in a corridor gets a network back.
   */
  const counterId = store.counterId ?? '';
  useEffect(() => {
    let alive = true;
    const wake = () => {
      void (async () => {
        const found = await otherOutboxes(chain, assignments, counterId);
        if (!alive) return;
        setOtros(found);
        if (found.length === 0) return;
        await drainOthers(api, chain, found);
        const after = await otherOutboxes(chain, assignments, counterId);
        if (alive) setOtros(after);
      })();
    };
    wake();
    globalThis.addEventListener('online', wake);
    globalThis.addEventListener('focus', wake);
    const tick = setInterval(wake, 30_000);
    return () => {
      alive = false;
      globalThis.removeEventListener('online', wake);
      globalThis.removeEventListener('focus', wake);
      clearInterval(tick);
    };
  }, [api, chain, assignments, counterId]);

  const group = open ? catalogue.groups.get(open.codigo) ?? [open] : [];

  function pick(item: CounterItem): void {
    setOpen(item);
    setEcho(null);
  }

  return (
    <div className="screen">
      <div className="masthead">
        <div className="masthead__title">{payload.counter.nombre}</div>
        <div className="hint">
          Bodega {payload.session.bodega} · corte {payload.session.fechaCorte}
        </div>
      </div>

      <SyncBar sync={sync} otros={otros} onExport={setExported} />

      {live.start.assumedFresh && (
        <div className="banner" role="status">
          Esta tableta no tenía registros y no pudo confirmar con el servidor dónde va tu
          conteo. Si estás usando una tableta de repuesto, conéctate al wifi de la oficina
          antes de seguir.
        </div>
      )}

      {exported && (
        <div className="panel">
          <div className="panel__title">Registros para el acta</div>
          <textarea className="field" rows={6} readOnly aria-label="exportación" value={exported} />
        </div>
      )}

      {/*
        Halted: the tabs are gone, not disabled. Accumulating unsaved work behind
        a warning is worse than stopping, and a greyed-out screen still reads as
        «keep going, it will come back». The sync bar stays above it, because
        what is already in the outbox still has to get out.
      */}
      {snapshot.halted ? (
        <>
          <div className="empty" role="alert">
            <div className="empty__title">{snapshot.halted.title}</div>
            <div className="empty__body">{snapshot.halted.detail}</div>
          </div>
          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => store.retryFailures()}>
              Reintentar guardado ({snapshot.failures.length})
            </button>
          </div>
        </>
      ) : (
        <>
          <nav className="tabs">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`tabs__tab ${tab === entry.id ? 'tabs__tab--on' : ''}`}
                aria-pressed={tab === entry.id}
                onClick={() => {
                  setTab(entry.id);
                  setOpen(null);
                }}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          {tab === 'contar' &&
            (open ? (
              <Entry
                key={open.idarticulo}
                item={open}
                group={group}
                registrados={registrados}
                heredados={catalogue.heredados}
                mostrarMarca={payload.session.mostrarMarcaRegistrado}
                store={store}
                onActive={setOpen}
                onDone={(line) => {
                  setOpen(null);
                  setEcho(line);
                }}
              />
            ) : (
              <Search
                catalogue={catalogue}
                registrados={registrados}
                heredados={catalogue.heredados}
                mostrarMarca={payload.session.mostrarMarcaRegistrado}
                echo={echo}
                onPick={pick}
              />
            ))}

          {tab === 'registros' && (
            <MyEntries store={store} catalogue={catalogue} events={snapshot.events} />
          )}

          {tab === 'notas' && (
            <Notes store={store} catalogue={catalogue} events={snapshot.events} />
          )}

          {tab === 'terminar' && (
            <FinishPanel
              store={store}
              sync={sync}
              catalogue={catalogue}
              events={snapshot.events}
              onCount={(idarticulo) => {
                const item = catalogue.byId.get(idarticulo);
                if (!item) return;
                setTab('contar');
                pick(item);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
