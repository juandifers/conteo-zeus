/**
 * The counting screen.
 *
 * Search is the primary interaction, because the counter walks the shelf and
 * looks things up — they do not walk a list. The search runs over the session's
 * items in memory; the repository is never consulted for a read after the
 * session is open.
 *
 * Enter is the keyboard-wedge hook: an industrial scanner is a keyboard that
 * types a `codigo` and presses Enter, so `resolveEnter` prefers an exact code
 * over the ranking. Nothing on this screen has to change when one arrives.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { catalogueFaults } from '../../app';
import type { Item } from '../../domain';
import { EntryCard } from '../components/EntryCard';
import { ResultRows } from '../components/ResultRows';
import { Topbar } from '../components/Topbar';
import { saveZona } from '../identity';
import { buildIndex, groupByCodigo, resolveEnter, searchItems } from '../search';
import { atRisk, type StorageReport } from '../storage';
import type { CountStore } from '../store';

/** Enough rows to scroll, few enough to stay a list rather than a catalogue. */
const MAX_ROWS = 50;

interface Open {
  items: Item[];
  active: Item;
}

export function CountScreen({
  store,
  storage,
  initial,
  onBack,
  onFaltantes,
  onRevision,
}: {
  store: CountStore;
  /** What the browser promised about the database (storage.ts). */
  storage: StorageReport;
  /** Open straight onto this item — how the faltantes list hands work over. */
  initial?: Item;
  onBack: () => void;
  onFaltantes: () => void;
  onRevision: () => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Open | null>(null);
  const [echo, setEcho] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const items = snapshot.session.items;
  const index = useMemo(() => buildIndex(items), [items]);
  const groups = useMemo(() => groupByCodigo(items), [items]);

  const hits = useMemo(() => searchItems(index, query), [index, query]);

  // A file whose names have come loose from its keys (ZEUS_FORMAT.md §4.1) is
  // refused at import now, and refused again before it can produce an
  // adjustment. This banner is what is left for the sessions that were
  // imported before the check existed: they are in the database, somebody may
  // be halfway through counting one, and finding out at posting time that
  // every quantity landed on the wrong article is too late.
  //
  // Asked of the same function the importer asks, so there is one definition of
  // what a coherent catalogue is. Kind-agnostic on purpose: a legacy session
  // can fail either signal, and a banner that counted only one of them would
  // read `0 códigos` on a file caught by the other.
  const faults = useMemo(() => catalogueFaults(items), [items]);

  // Opened once, on mount: arriving from the faltantes list means the item to
  // count has already been chosen, and re-choosing it on every render would
  // make the close button useless.
  const [openedInitial, setOpenedInitial] = useState(false);
  if (initial && !openedInitial) {
    setOpenedInitial(true);
    setOpen({ items: (groups.get(initial.codigo) ?? [initial]).slice(), active: initial });
  }

  // Back to the one control that is always the next thing touched. Closing the
  // card and leaving focus nowhere costs a tap on every single item.
  useEffect(() => {
    if (!open) search.current?.focus();
  }, [open]);

  function pick(item: Item): void {
    setOpen({ items: (groups.get(item.codigo) ?? [item]).slice(), active: item });
    setEcho(null);
  }

  function finish(message: string | null): void {
    setOpen(null);
    setEcho(message);
    setQuery('');
  }

  return (
    <div className="screen">
      <Topbar
        snapshot={snapshot}
        onBack={onBack}
        onZona={(zona) => {
          store.setZona(zona);
          saveZona(snapshot.session.id, zona);
        }}
      />

      {faults.length > 0 && !open && (
        <div className="banner" role="alert">
          Este archivo no cuadra consigo mismo: sus nombres no corresponden a sus códigos.
          Lo que cuentes aquí puede quedar en el artículo equivocado, y esta sesión no va a
          poder generar un archivo. Vuelve a importar la bodega.
        </div>
      )}

      {!snapshot.protected && !snapshot.halted && (
        <div className="banner" role="alert">
          Esta tableta no puede guardar una copia local. Si se cierra la pestaña antes de
          tiempo, se pierde lo que no haya llegado a la base de datos.
        </div>
      )}

      {/*
        A different failure from the one above, and both can be true at once.
        That one is about the seconds between a tap and a write; this one is
        about the browser deleting the whole database later, under storage
        pressure, without asking (storage.ts). Said here as well as on the
        sessions screen because a count that runs all afternoon is a count
        nobody went back to the sessions screen during, and the instruction —
        generate the file today — is one the counter can act on.
      */}
      {atRisk(storage) && !snapshot.halted && (
        <div className="banner" role="status">
          El navegador puede borrar este conteo si la tableta se queda sin espacio. Genera
          el archivo de ajuste hoy mismo.
        </div>
      )}

      {snapshot.failures.length > 0 && !snapshot.halted && (
        <div className="banner" role="alert">
          {snapshot.failures.length} registros no se guardaron todavía.{' '}
          <button type="button" className="btn btn--small" onClick={() => store.retryFailures()}>
            Reintentar
          </button>
        </div>
      )}

      {/*
        Halted: the search box and the entry card are gone, not disabled.
        Accumulating unsaved work behind a warning is worse than stopping, and a
        greyed-out screen still reads as "keep going, it will come back".
      */}
      {snapshot.halted ? (
        <>
          <div className="empty" role="alert">
            <div className="empty__title">{snapshot.halted.title}</div>
            <div className="empty__body">{snapshot.halted.detail}</div>
          </div>
          <div className="spacer" />
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => store.retryFailures()}
            >
              Reintentar guardado ({snapshot.failures.length})
            </button>
            <button type="button" className="btn" onClick={onBack}>
              Salir a sesiones
            </button>
          </div>
        </>
      ) : open ? (
        <EntryCard
          group={open.items}
          active={open.active}
          onActive={(item) => setOpen({ items: open.items, active: item })}
          onFinish={finish}
          store={store}
          resolutions={snapshot.resolutions}
        />
      ) : (
        <>
          <div className="searchbar">
            <input
              ref={search}
              autoFocus
              type="search"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="buscar artículo"
              placeholder="buscar por nombre o código"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setEcho(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const target = resolveEnter(index, groups, query);
                if (target) setOpen({ items: target.items, active: target.active });
              }}
            />
            {echo && (
              <p className="hint landed" role="status">
                registrado — {echo}
              </p>
            )}
          </div>

          <div className="scroll">
            {query.trim().length === 0 ? (
              <div className="empty">
                <div className="empty__title">Busca el artículo que tienes enfrente</div>
                <div className="empty__body">
                  Escribe parte del nombre, la presentación o el código. Un lector de código de
                  barras también sirve: teclea y da Enter.
                </div>
              </div>
            ) : hits.length === 0 ? (
              <div className="empty">
                <div className="empty__title">Sin resultados</div>
                <div className="empty__body">
                  Nada en esta bodega coincide con «{query.trim()}».
                </div>
              </div>
            ) : (
              <>
                <ResultRows
                  hits={hits.slice(0, MAX_ROWS)}
                  resolutions={snapshot.resolutions}
                  onPick={pick}
                />
                {hits.length > MAX_ROWS && (
                  <p className="divider">
                    y {hits.length - MAX_ROWS} más — escribe otra palabra para acotar
                  </p>
                )}
              </>
            )}
          </div>

          <div className="actions">
            <div className="actions__pair">
              <button type="button" className="btn" onClick={onFaltantes}>
                Faltantes ({snapshot.counts.untouched})
              </button>
              <button type="button" className="btn" onClick={onRevision}>
                Revisar y generar archivo
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
