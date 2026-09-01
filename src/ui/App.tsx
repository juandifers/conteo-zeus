/**
 * The composition root, and all the routing there is.
 *
 * Three screens and a `useState` — no router, because the whole app is one
 * session and two views of it, and a URL that survives a reload buys nothing
 * on a tablet that never leaves the counting screen.
 *
 * It is also the boot sequence, in this order and for these reasons:
 *
 *   1. `identify()` — this install's `deviceId` and sequence watermark. If it
 *      fails, **nothing else runs.** An event stamped with an improvised id is
 *      an event nothing can order afterwards, and a log that cannot be ordered
 *      is worse than a count that never started (DOMAIN.md §6).
 *   2. `replayOutbox()` — flush whatever the last run could not, *before* a
 *      session is loaded, so the session opens against a complete log.
 *
 * `requestPersistence()` runs alongside rather than inside that chain. It asks
 * the browser not to evict the database (storage.ts), which matters a great
 * deal — but a refusal is something to *say*, not something to stop for, and
 * on a browser where the call hangs it must not hold the boot open.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CountRepository,
  DeviceRepository,
  ExportRepository,
  Item,
} from '../domain';
import { UpdateNotice } from './components/UpdateNotice';
import { browserDownload, type Downloader } from './download';
import { loadUsuario } from './identity';
import { noInstall, type Install } from './install';
import { localOutbox, replayOutbox, type Outbox } from './outbox';
import { CountScreen } from './screens/CountScreen';
import { FaltantesScreen } from './screens/FaltantesScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SessionsScreen } from './screens/SessionsScreen';
import { requestPersistence, UNKNOWN_STORAGE, type StorageReport } from './storage';
import { CountStore } from './store';
import { noUpdates, type Updates } from './updates';

type Route =
  | { name: 'sessions' }
  | { name: 'count'; sessionId: string; focus?: Item }
  | { name: 'faltantes'; sessionId: string }
  | { name: 'revision'; sessionId: string };

type Boot =
  | { phase: 'starting' }
  | { phase: 'refused'; message: string }
  | { phase: 'ready'; stranded: number };

export function App({
  repo,
  outbox: injected,
  download: injectedDownload,
  updates: injectedUpdates,
  install: injectedInstall,
  persistence = requestPersistence,
}: {
  repo: CountRepository & DeviceRepository & ExportRepository;
  outbox?: Outbox;
  /** Injected so a test can catch the bytes that would have reached the disk. */
  download?: Downloader;
  /** The waiting service worker, if any. Absent everywhere but the real app. */
  updates?: Updates;
  /** The captured `beforeinstallprompt`, if the browser offered one. */
  install?: Install;
  /** Injected so a test can refuse persistence without a real StorageManager. */
  persistence?: () => Promise<StorageReport>;
}) {
  // Memoised, not defaulted in the signature: a fresh `localOutbox()` on every
  // render is a new identity in the effects' dependency arrays below, and both
  // effects then tear themselves down and restart forever — the app boots to a
  // blank screen and no error, because nothing actually failed.
  const outbox = useMemo(() => injected ?? localOutbox(), [injected]);
  const download = useMemo(() => injectedDownload ?? browserDownload(), [injectedDownload]);
  const updates = useMemo(() => injectedUpdates ?? noUpdates(), [injectedUpdates]);
  const install = useMemo(() => injectedInstall ?? noInstall(), [injectedInstall]);

  const [boot, setBoot] = useState<Boot>({ phase: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route>({ name: 'sessions' });
  const [store, setStore] = useState<CountStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageReport>(UNKNOWN_STORAGE);

  const sessionId = route.name === 'sessions' ? null : route.sessionId;

  useEffect(() => {
    let live = true;
    (async () => {
      await repo.identify();
      const { failed } = await replayOutbox(outbox, repo);
      return failed;
    })().then(
      (stranded) => {
        if (live) setBoot({ phase: 'ready', stranded });
      },
      (cause: unknown) => {
        if (live) {
          setBoot({
            phase: 'refused',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [repo, outbox, attempt]);

  // Asked on every launch, not once. Chrome decides from heuristics rather than
  // by prompting, and installing the app to the home screen changes its mind —
  // so a tablet that was refused on Monday should be asked again on Tuesday
  // (storage.ts). `requestPersistence` never rejects; the guard is for an
  // injected one that might.
  useEffect(() => {
    let live = true;
    persistence().then(
      (report) => {
        if (live) setStorage(report);
      },
      () => {
        if (live) setStorage(UNKNOWN_STORAGE);
      },
    );
    return () => {
      live = false;
    };
  }, [persistence, attempt]);

  useEffect(() => {
    if (sessionId === null || boot.phase !== 'ready') return;
    let live = true;
    // `identify()` again rather than reusing the boot value: `nextSeq` is a
    // watermark the database advances on every write, so the current one is
    // only knowable by asking. `deviceId` never changes.
    repo
      .identify()
      .then((device) =>
        CountStore.open(repo, sessionId, {
          usuario: loadUsuario(),
          deviceId: device.deviceId,
          nextSeq: device.nextSeq,
          outbox,
        }),
      )
      .then((opened) => {
        if (live) setStore(opened);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [repo, outbox, sessionId, boot.phase]);

  const retryBoot = useCallback(() => {
    setBoot({ phase: 'starting' });
    setAttempt((n) => n + 1);
  }, []);

  /**
   * Whichever screen the route names.
   *
   * A function rather than a chain of early returns from the component, so
   * that the shell — and the update notice in it — is written once and appears
   * on every screen, including the two blank ones.
   */
  function screen() {
    if (boot.phase === 'starting') return null;

    if (boot.phase === 'refused') {
      return (
        <div className="screen">
          <div className="empty" role="alert">
            <div className="empty__title">No se puede contar en esta tableta</div>
            <div className="empty__body">
              La tableta no pudo registrar su identidad: «{boot.message}». Sin ella los
              conteos no se pueden ordenar entre dispositivos, así que no se graba
              ninguno. Cierra y vuelve a abrir; si sigue igual, avisa a sistemas.
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={retryBoot}>
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    if (route.name === 'sessions') {
      return (
        <SessionsScreen
          repo={repo}
          stranded={boot.stranded}
          storage={storage}
          install={install}
          download={download}
          onOpen={(id) => setRoute({ name: 'count', sessionId: id })}
        />
      );
    }

    if (error) {
      return (
        <div className="banner" role="alert">
          {error}
        </div>
      );
    }

    // Never render a screen against the previous session's store: opening B
    // while A is still loaded would show A's items under B's header for a tick.
    if (!store || store.getSnapshot().session.id !== sessionId) return null;

    if (route.name === 'count') {
      return (
        <CountScreen
          key={route.sessionId}
          store={store}
          initial={route.focus}
          onBack={() => setRoute({ name: 'sessions' })}
          onFaltantes={() => setRoute({ name: 'faltantes', sessionId: route.sessionId })}
          onRevision={() => setRoute({ name: 'revision', sessionId: route.sessionId })}
        />
      );
    }

    if (route.name === 'revision') {
      return (
        <ReviewScreen
          store={store}
          repo={repo}
          download={download}
          onBack={() => setRoute({ name: 'count', sessionId: route.sessionId })}
        />
      );
    }

    return (
      <FaltantesScreen
        store={store}
        onBack={() => setRoute({ name: 'count', sessionId: route.sessionId })}
        onCount={(item) =>
          setRoute({ name: 'count', sessionId: route.sessionId, focus: item })
        }
      />
    );
  }

  return (
    <div className="app">
      {screen()}
      <UpdateNotice updates={updates} />
    </div>
  );
}
