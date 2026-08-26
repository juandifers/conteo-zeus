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
import type { Item } from '../../domain';
import { EntryCard } from '../components/EntryCard';
import { ResultRows } from '../components/ResultRows';
import { Topbar } from '../components/Topbar';
import { saveZona } from '../identity';
import { buildIndex, groupByCodigo, resolveEnter, searchItems } from '../search';
import type { CountStore } from '../store';

/** Enough rows to scroll, few enough to stay a list rather than a catalogue. */
const MAX_ROWS = 50;

interface Open {
  items: Item[];
  active: Item;
}

export function CountScreen({
  store,
  initial,
  onBack,
  onFaltantes,
  onRevision,
}: {
  store: CountStore;
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

  // ZEUS_FORMAT.md §4 offers "nombre is stable per codigo" as an import
  // integrity check, and §5 records the sample .txt failing it on 43 of 232
  // codes because two differently-sorted blocks were pasted together by hand.
  // A count taken against a file in that state lands on the wrong balances, so
  // the screen says so up front rather than letting somebody find out at
  // posting time. Non-blocking: it is the hotel's file, and refusing to open it
  // helps nobody standing in the storeroom.
  const mixedCodes = useMemo(() => {
    const names = new Map<string, string>();
    const bad = new Set<string>();
    for (const item of items) {
      const seen = names.get(item.codigo);
      if (seen === undefined) names.set(item.codigo, item.nombre);
      else if (seen !== item.nombre) bad.add(item.codigo);
    }
    return bad.size;
  }, [items]);

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

      {mixedCodes > 0 && !open && (
        <div className="banner" role="status">
          {mixedCodes} códigos de este archivo tienen más de un nombre. Revisa la presentación
          antes de guardar.
        </div>
      )}

      {!snapshot.protected && !snapshot.halted && (
        <div className="banner" role="alert">
          Esta tableta no puede guardar una copia local. Si se cierra la pestaña antes de
          tiempo, se pierde lo que no haya llegado a la base de datos.
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
