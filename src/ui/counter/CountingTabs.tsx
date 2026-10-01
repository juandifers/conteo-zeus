/**
 * The four tabs, and the stop that replaces them.
 *
 *     Contar         search → keypad → confirm → registered
 *     Mis registros  what I did, in order, and how to correct it
 *     Notas          what does not fit in a quantity
 *     Terminar       my own gaps, then whatever comes next
 *
 * One component for both ways a count runs on a tablet, because the rules that
 * matter are the same in both and are worth having exactly once:
 *
 *   - every quantity is an **independent registro** — the keypad opens empty,
 *     and a second pile of the same article is a second entry, never an edit of
 *     the first (DOMAIN.md §6.3);
 *   - no running total for any article reaches the screen (§2.1);
 *   - a write that failed stops new entries until it lands, because the next
 *     one would chain onto it.
 *
 * What differs is only what «Terminar» leads to, and so that is the one thing
 * the caller passes. A dispatched counter finishes to the server (`FinishPanel`);
 * a single-device count goes on to the review on the same tablet (`LocalCount`).
 */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { registeredArticles, type CountEvent, type CounterItem } from '../../domain';
import type { CountStore } from '../store';
import { Entry } from './Entry';
import { MyEntries } from './MyEntries';
import { Notes } from './Notes';
import { Search } from './Search';
import type { CounterCatalogue } from './assignment';

type Tab = 'contar' | 'registros' | 'notas' | 'terminar';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'contar', label: 'Contar' },
  { id: 'registros', label: 'Mis registros' },
  { id: 'notas', label: 'Notas' },
  { id: 'terminar', label: 'Terminar' },
];

export function CountingTabs({
  store,
  catalogue,
  mostrarMarca,
  terminar,
}: {
  store: CountStore;
  catalogue: CounterCatalogue;
  /** Whether the neutral «registrado» checkmark is drawn (session config). */
  mostrarMarca: boolean;
  /**
   * The «Terminar» tab's body. `onCount` jumps to the keypad for one gap row,
   * so a gap list can send somebody straight back to the shelf.
   */
  terminar: (props: {
    events: readonly CountEvent[];
    onCount: (idarticulo: number) => void;
  }) => ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('contar');
  const [open, setOpen] = useState<CounterItem | null>(null);
  const [echo, setEcho] = useState<string | null>(null);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Membership only — never a resolution, never a quantity (§2.1).
  const registrados = useMemo(
    () => registeredArticles(snapshot.events, store.counterId),
    [snapshot.events, store.counterId],
  );

  const group = open ? catalogue.groups.get(open.codigo) ?? [open] : [];

  function pick(item: CounterItem): void {
    setOpen(item);
    setEcho(null);
  }

  /*
    Halted: the tabs are gone, not disabled. Accumulating unsaved work behind a
    warning is worse than stopping, and a greyed-out screen still reads as «keep
    going, it will come back».
  */
  if (snapshot.halted) {
    return (
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
    );
  }

  return (
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
            mostrarMarca={mostrarMarca}
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
            mostrarMarca={mostrarMarca}
            echo={echo}
            onPick={pick}
          />
        ))}

      {tab === 'registros' && (
        <MyEntries store={store} catalogue={catalogue} events={snapshot.events} />
      )}

      {tab === 'notas' && <Notes store={store} catalogue={catalogue} events={snapshot.events} />}

      {tab === 'terminar' &&
        terminar({
          events: snapshot.events,
          onCount: (idarticulo) => {
            const item = catalogue.byId.get(idarticulo);
            if (!item) return;
            setTab('contar');
            pick(item);
          },
        })}
    </>
  );
}
