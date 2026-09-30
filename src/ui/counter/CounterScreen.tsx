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
import { reauthOn401, type Api } from '../api';
import { openAuth, type AuthGate } from '../auth';
import { Login } from '../components/Login';
import { UpdateNotice } from '../components/UpdateNotice';
import { localOutbox } from '../outbox';
import { CountStore } from '../store';
import { requestPersistence, type StorageReport } from '../storage';
import { noUpdates, type Updates } from '../updates';
import { Entry } from './Entry';
import { FinishPanel } from './Finish';
import { MyEntries } from './MyEntries';
import { Notes } from './Notes';
import { Prepare } from './Prepare';
import { Search } from './Search';
import { SyncBar } from './SyncBar';
import { catalogueOf, type CounterCatalogue } from './assignment';
import { bootCounter, type ChainStart } from './boot';
import { outsideChrome, outsideChromeAdvice } from './browser';
import { useCounterLock, type LockManagerLike } from './counterLock';
import {
  clearStaleAssignments,
  drainOthers,
  otherOutboxes,
  type OtherOutbox,
} from './handover';
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

// One instance, at module scope: a default built per render would change the
// wrapped api's identity every render, and the boot effect watches it.
const OPEN_DOOR = openAuth();

export function CounterScreen({
  token,
  api,
  assignments,
  repo,
  chain,
  updates: injectedUpdates,
  auth = OPEN_DOOR,
  locks,
  persistence = requestPersistence,
}: {
  token: string;
  api: Api;
  assignments: AssignmentStore;
  repo: CountRepository & DeviceRepository;
  chain: CounterChainRepository;
  updates?: Updates;
  /**
   * `Root` passes the browser's gate. The tablet logs in once as the shared
   * `contador` user, on office wifi, alongside the assignment fetch; after
   * that `current()` answers from storage with no network, so a reopen in the
   * bodega never blocks on this. An expired login is still «worth trying» —
   * because an expiry gate that needed the network would blank the one screen
   * built to work without one. When the server does answer 401, `reauthOn401`
   * drops the stored login and this screen folds back to the form; a 401
   * takes signal, and where there is signal there is a way to log in again.
   * Nothing in Dexie — events, outbox — is touched by that.
   */
  auth?: AuthGate;
  /** `navigator.locks` unless a test passes its own (see counterLock.ts). */
  locks?: LockManagerLike;
  /** Asks the browser to keep this origin's data; injectable for tests. */
  persistence?: () => Promise<StorageReport>;
}) {
  const updates = useMemo(() => injectedUpdates ?? noUpdates(), [injectedUpdates]);
  const [, bump] = useState(0);
  // Every request this tablet makes goes through this: a 401 drops the stored
  // login and re-renders, which is what puts the login form back on screen.
  const door = useMemo(
    () => reauthOn401(api, auth, () => bump((n) => n + 1)),
    [api, auth],
  );
  const [payload, setPayload] = useState<CounterPayload | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [lockAttempt, setLockAttempt] = useState(0);
  const lock = useCounterLock(payload?.counter.id ?? null, lockAttempt, locks);
  // Ask the browser to keep this origin's database. Chrome answers from its
  // own heuristics — an installed app is granted, a plain tab often is not —
  // and until now the counting page never asked at all, so an eviction under
  // storage pressure took unsynced counts with nothing on screen saying so.
  const [storage, setStorage] = useState<StorageReport | null>(null);
  useEffect(() => {
    let alive = true;
    void persistence().then((report) => {
      if (alive) setStorage(report);
    });
    return () => {
      alive = false;
    };
  }, [persistence]);

  const onReady = useCallback((held: CounterPayload) => {
    // Same counter in the same session: keep the object identity so the boot
    // effect does not re-run on a refetch. Anything else — including the same
    // counter id under a different session, which a re-dispatch cannot mint
    // but a stale fixture can — replaces the payload outright.
    setPayload((current) =>
      current?.counter.id === held.counter.id && current.session.id === held.session.id
        ? current
        : held,
    );
  }, []);

  useEffect(() => {
    if (!payload) return;
    // Not before this screen is the only one writing this counter's chain.
    if (lock !== 'held' && lock !== 'unsupported') return;
    let alive = true;
    void (async () => {
      try {
        const boot = await bootCounter({
          chain,
          api: door,
          token,
          sessionId: payload.session.id,
          counterId: payload.counter.id,
          identify: () => repo.identify(),
        });
        if (!alive) return;

        const catalogue = catalogueOf(payload);

        // The device's own log, back onto the screen. A tablet that reloads
        // mid-count — a crash, a low-memory eviction, a tab closed by accident
        // — must reopen with «Mis registros» intact: the chain already
        // continued from these rows (`localChain`, above), and a correction
        // screen that forgot what it exists to correct would send somebody to
        // recount work the server is already holding. The whole session's rows
        // on this device, not one counter's: after a handover this tablet can
        // hold two counters' logs, the fold is built to merge them, and
        // `ownLog` still scopes «Mis registros» to this counter alone.
        const held = await repo.eventsForSession(payload.session.id);
        if (!alive) return;

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
        const store = new CountStore(repo, session, held, {
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
        const sync = new CounterSync(door, chain, {
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
  }, [payload, door, chain, repo, token, lock]);

  // Every entry, once it is on disk: recount the outbox, and push if the
  // browser does not know it is offline. Without this the sync bar went on
  // saying «Todo lo que llevas está subido» for up to thirty seconds after a
  // tap — the one sentence that tells somebody it is safe to walk away.
  useEffect(() => {
    if (!live) return;
    let seen = live.store.getSnapshot().events.length;
    return live.store.subscribe(() => {
      const snapshot = live.store.getSnapshot();
      if (snapshot.pending !== 0 || snapshot.events.length === seen) return;
      seen = snapshot.events.length;
      void live.sync.refresh().then(() => {
        if (globalThis.navigator?.onLine !== false) void live.sync.drain();
      });
    });
  }, [live]);

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

  const body = !auth.current() ? (
    <Login role="contador" api={door} gate={auth} onDone={() => bump((n) => n + 1)} />
  ) : failed ? (
    <div className="screen">
      <div className="empty" role="alert">
        <div className="empty__title">No se pudo abrir el conteo en esta tableta</div>
        <div className="empty__body">{failed}</div>
      </div>
    </div>
  ) : lock === 'busy' ? (
    <div className="screen">
      <div className="empty" role="alert">
        <div className="empty__title">Este conteo ya está abierto en esta tableta</div>
        <div className="empty__body">
          Está abierto en otra pestaña o en la aplicación instalada. Sigue contando allí: si
          cuentas en las dos a la vez, una de ellas pierde registros. Si ya la cerraste, toca
          «Reintentar».
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setLockAttempt((n) => n + 1)}
          >
            Reintentar
          </button>
        </div>
      </div>
    </div>
  ) : !payload || !live ? (
    // Until the assignment is on the device and the chain has a starting point,
    // the preparation screen is the whole app — it is the one that can say «esta
    // tableta todavía no está lista» and offer a retry.
    <Prepare token={token} api={door} store={assignments} onReady={onReady} />
  ) : (
    <Counting
      payload={payload}
      live={live}
      storage={storage}
      api={door}
      chain={chain}
      assignments={assignments}
    />
  );

  return (
    <>
      {body}
      {/* The same blocking gate the other faces carry, and here it can only
          appear where applying it is free: detecting a new version takes
          network, so a tablet offline in the bodega never sees it, and a
          tablet on office wifi at preparation is exactly the one that must
          not walk out carrying a deprecated build. Sync keeps draining
          underneath it, so the gate never strands an outbox. */}
      <UpdateNotice updates={updates} />
    </>
  );
}

function Counting({
  payload,
  live,
  storage,
  api,
  chain,
  assignments,
}: {
  payload: CounterPayload;
  live: Live;
  storage: StorageReport | null;
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
        if (found.length > 0) {
          await drainOthers(api, chain, found);
          const after = await otherOutboxes(chain, assignments, counterId);
          if (alive) setOtros(after);
        }
        // Entering a session clears the previous ones — once, and only what
        // is safe: links from other sessions whose queues just drained (or
        // were never owed anything) are forgotten, so an old count stops
        // surfacing on this tablet. Anything still owed stays until it lands.
        await clearStaleAssignments(chain, assignments, payload.session.id).catch(() => {
          // Cleanup, not correctness: the same sweep runs on the next wake.
        });
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
  }, [api, chain, assignments, counterId, payload.session.id]);

  const group = open ? catalogue.groups.get(open.codigo) ?? [open] : [];
  const browser = outsideChrome(globalThis.navigator?.userAgent) as 'app' | 'otro' | null;

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

      {browser && (
        <div className="banner" role="status">
          {outsideChromeAdvice(
            browser,
            snapshot.events.some((event) => event.counterId === store.counterId),
          )}
        </div>
      )}

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
              storage={storage}
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
