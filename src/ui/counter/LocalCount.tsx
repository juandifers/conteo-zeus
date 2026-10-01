/**
 * A single-device count on the counter screens — the file came in on this
 * tablet, and the `.txt` goes out from it.
 *
 *     Sesiones ──▶ LocalCount
 *                   ├─ Contar · Mis registros · Notas · Terminar   (CountingTabs)
 *                   │                                    │
 *                   │                     «Revisar y generar archivo»
 *                   │                                    ▼
 *                   └──────────── ‹ ───────────  ReviewScreen  (the reveal)
 *
 * The four tabs are the dispatched counter's, unchanged. What is missing is
 * everything that exists because a server does: no sync bar, no handover
 * drain, no «terminar» manifest to upload. «Terminar» here is the same gap
 * review a dispatched counter sees, with the next step under it being the
 * review on this same tablet instead of a finish.
 *
 * The review is **the existing one**, against the same store. Its gate still
 * opens closed while anything is uncounted (ReviewScreen.tsx), because the
 * person counting and the person reviewing are holding one device; and its
 * waiver is the signed bulk one, which this store accepts because it was
 * opened `sinServidor` (local.ts).
 *
 * The same one-writer lock as a dispatched tablet. Two tabs writing one chain
 * would each continue it from the same head, and the second write would land
 * on a sequence number the first already took: the store halts, and one tab's
 * entry is lost. The store is opened only once the lock is held, so the chain
 * start it reads cannot be moved under it by another tab.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import type {
  CounterChainRepository,
  CountRepository,
  DeviceRepository,
  ExportRepository,
  Session,
} from '../../domain';
import type { Downloader } from '../download';
import type { Outbox } from '../outbox';
import { ReviewScreen } from '../screens/ReviewScreen';
import type { StorageReport } from '../storage';
import { CountingTabs } from './CountingTabs';
import { GapReview } from './Finish';
import { useCounterLock, type LockManagerLike } from './counterLock';
import { openLocalCount, type LocalCountState } from './local';

export function LocalCount({
  repo,
  chain,
  session,
  usuario,
  outbox,
  download,
  storage = null,
  onBack,
  locks,
}: {
  repo: CountRepository & DeviceRepository & ExportRepository;
  chain: CounterChainRepository;
  /** A session with `contadorLocal`, items and source loaded. */
  session: Session;
  /** Whoever is set to count on this tablet now (the sessions screen's field). */
  usuario: string;
  outbox: Outbox;
  download: Downloader;
  storage?: StorageReport | null;
  onBack: () => void;
  /** `navigator.locks` unless a test passes its own (see counterLock.ts). */
  locks?: LockManagerLike;
}) {
  const [attempt, setAttempt] = useState(0);
  const lock = useCounterLock(session.contadorLocal?.id ?? null, attempt, locks);
  const [live, setLive] = useState<LocalCountState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<'contar' | 'revision'>('contar');

  useEffect(() => {
    // Not before this screen is the only one writing this counter's chain.
    if (lock !== 'held' && lock !== 'unsupported') return;
    let alive = true;
    openLocalCount({ repo, chain, session, usuario, outbox }).then(
      (opened) => {
        if (alive) setLive(opened);
      },
      (cause: unknown) => {
        if (alive) setFailed(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [lock, repo, chain, session, usuario, outbox]);

  if (failed) {
    return (
      <div className="screen">
        <Masthead nombre={null} session={session} onBack={onBack} />
        <div className="empty" role="alert">
          <div className="empty__title">No se pudo abrir el conteo en esta tableta</div>
          <div className="empty__body">{failed}</div>
        </div>
      </div>
    );
  }

  if (lock === 'busy') {
    return (
      <div className="screen">
        <Masthead nombre={null} session={session} onBack={onBack} />
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
              onClick={() => setAttempt((n) => n + 1)}
            >
              Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!live) return null;

  if (view === 'revision') {
    return (
      <ReviewScreen
        store={live.store}
        repo={repo}
        download={download}
        onBack={() => setView('contar')}
      />
    );
  }

  return <Counting live={live} storage={storage} onBack={onBack} onReview={() => setView('revision')} />;
}

function Counting({
  live,
  storage,
  onBack,
  onReview,
}: {
  live: LocalCountState;
  storage: StorageReport | null;
  onBack: () => void;
  onReview: () => void;
}) {
  const { store, catalogue, payload } = live;
  const { session, usuario } = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div className="screen">
      <Masthead nombre={usuario || payload.counter.nombre} session={session} onBack={onBack} />

      <CountingTabs
        store={store}
        catalogue={catalogue}
        mostrarMarca={payload.session.mostrarMarcaRegistrado}
        terminar={({ events, onCount }) => (
          <>
            <GapReview
              store={store}
              catalogue={catalogue}
              events={events}
              onCount={onCount}
              storage={storage}
              sinServidor
            />
            <div className="panel">
              <div className="panel__body">
                <div className="hint">
                  La revisión muestra lo que dice Zeus de cada artículo. La hace quien supervisa,
                  no quien cuenta: allí se firman las exenciones y se genera el archivo para
                  subir a Zeus.
                </div>
              </div>
            </div>
            <div className="actions">
              <button type="button" className="btn btn--primary" onClick={onReview}>
                Revisar y generar archivo
              </button>
            </div>
          </>
        )}
      />
    </div>
  );
}

function Masthead({
  nombre,
  session,
  onBack,
}: {
  nombre: string | null;
  session: Pick<Session, 'bodega' | 'fechaCorte'>;
  onBack: () => void;
}) {
  return (
    <div className="masthead">
      <button
        type="button"
        className="entry__close"
        aria-label="volver a las sesiones"
        onClick={onBack}
      >
        ‹
      </button>
      <div>
        {nombre && <div className="masthead__title">{nombre}</div>}
        <div className="hint">
          Bodega {session.bodega} · corte {session.fechaCorte}
        </div>
      </div>
    </div>
  );
}
