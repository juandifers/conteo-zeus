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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CountRepository,
  DeviceRepository,
  ExportRepository,
  Item,
} from '../domain';
import { browserDownload, type Downloader } from './download';
import { loadUsuario, loadZona } from './identity';
import { localOutbox, replayOutbox, type Outbox } from './outbox';
import { CountScreen } from './screens/CountScreen';
import { FaltantesScreen } from './screens/FaltantesScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SessionsScreen } from './screens/SessionsScreen';
import { CountStore } from './store';

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
}: {
  repo: CountRepository & DeviceRepository & ExportRepository;
  outbox?: Outbox;
  /** Injected so a test can catch the bytes that would have reached the disk. */
  download?: Downloader;
}) {
  // Memoised, not defaulted in the signature: a fresh `localOutbox()` on every
  // render is a new identity in the effects' dependency arrays below, and both
  // effects then tear themselves down and restart forever — the app boots to a
  // blank screen and no error, because nothing actually failed.
  const outbox = useMemo(() => injected ?? localOutbox(), [injected]);
  const download = useMemo(() => injectedDownload ?? browserDownload(), [injectedDownload]);

  const [boot, setBoot] = useState<Boot>({ phase: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route>({ name: 'sessions' });
  const [store, setStore] = useState<CountStore | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          zona: loadZona(sessionId),
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

  if (boot.phase === 'starting') return <div className="app" />;

  if (boot.phase === 'refused') {
    return (
      <div className="app">
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
      </div>
    );
  }

  if (route.name === 'sessions') {
    return (
      <div className="app">
        <SessionsScreen
          repo={repo}
          stranded={boot.stranded}
          onOpen={(id) => setRoute({ name: 'count', sessionId: id })}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="banner" role="alert">
          {error}
        </div>
      </div>
    );
  }

  // Never render a screen against the previous session's store: opening B
  // while A is still loaded would show A's items under B's header for a tick.
  if (!store || store.getSnapshot().session.id !== sessionId) {
    return <div className="app" />;
  }

  return (
    <div className="app">
      {route.name === 'count' ? (
        <CountScreen
          key={route.sessionId}
          store={store}
          initial={route.focus}
          onBack={() => setRoute({ name: 'sessions' })}
          onFaltantes={() => setRoute({ name: 'faltantes', sessionId: route.sessionId })}
          onRevision={() => setRoute({ name: 'revision', sessionId: route.sessionId })}
        />
      ) : route.name === 'revision' ? (
        <ReviewScreen
          store={store}
          repo={repo}
          download={download}
          onBack={() => setRoute({ name: 'count', sessionId: route.sessionId })}
        />
      ) : (
        <FaltantesScreen
          store={store}
          onBack={() => setRoute({ name: 'count', sessionId: route.sessionId })}
          onCount={(item) =>
            setRoute({ name: 'count', sessionId: route.sessionId, focus: item })
          }
        />
      )}
    </div>
  );
}
