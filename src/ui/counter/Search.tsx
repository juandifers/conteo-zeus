/**
 * Finding the article in front of you.
 *
 * Search is the primary interaction: a counter walks a shelf and looks things
 * up, they do not walk a list. The index is over this counter's own assignment
 * — tens to a few hundred rows for most people, not the 298-row catalogue — and
 * it is built once and held in memory, because somebody typing three letters
 * with gloves on expects the list before their finger leaves the key and
 * IndexedDB on a cheap Android tablet does not promise that.
 *
 * **There is no quantity column in this file.** Not hidden, not conditionally
 * rendered, not passed in and dropped: no resolution, no fold result, no
 * `Resolution` import (DOMAIN.md §2.1). The most a row can say is that this
 * counter — or, after a handover, somebody before them — has registered
 * *something* here, as a neutral `✓` carrying no magnitude, and only when the
 * session was configured to show it. A badge reading «3 registros» would be a
 * magnitude, because entry counts correlate with how big a stack is.
 *
 * `StateChip` is the P1 component for exactly this slot and is deliberately not
 * reused: it prints `contado 70`.
 */
import { useRef, useState } from 'react';

import type { CounterItem } from '../../domain';
import type { CounterCatalogue } from './assignment';
import { Registrado } from './Registrado';
import { resolveEnter, searchItems } from '../search';

/** Enough rows to scroll, few enough to stay a list rather than a catalogue. */
const MAX_ROWS = 50;

export function Search({
  catalogue,
  registrados,
  heredados,
  mostrarMarca,
  echo,
  onPick,
}: {
  catalogue: CounterCatalogue;
  /** Articles this counter has something standing against. Membership only. */
  registrados: ReadonlySet<number>;
  /** Articles somebody else had registered at handover (§6b). Membership only. */
  heredados: ReadonlySet<number>;
  mostrarMarca: boolean;
  /** The line the entry screen prints back on its way out. */
  echo: string | null;
  onPick: (item: CounterItem) => void;
}) {
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);

  const hits = searchItems(catalogue.index, query);

  return (
    <>
      <div className="searchbar">
        <input
          ref={field}
          autoFocus
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="buscar artículo"
          placeholder="buscar por nombre o código"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            // The keyboard-wedge hook, kept from P1: a scanner is a keyboard
            // that types a `codigo` and presses Enter. Barcode support is out
            // of scope here and arrives without touching this screen.
            const target = resolveEnter(catalogue.index, catalogue.groups, query);
            if (target) {
              setQuery('');
              onPick(target.active);
            }
          }}
        />
        {echo && (
          <p className="hint landed" role="status">
            {echo}
          </p>
        )}
      </div>

      <div className="scroll">
        {query.trim().length === 0 ? (
          <div className="empty">
            <div className="empty__title">Busca el artículo que tienes enfrente</div>
            <div className="empty__body">
              Escribe parte del nombre, la presentación o el código.
            </div>
          </div>
        ) : hits.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Sin resultados</div>
            <div className="empty__body">
              Nada de lo que te asignaron coincide con «{query.trim()}». Si el artículo está
              ahí y no aparece, déjalo en una nota.
            </div>
          </div>
        ) : (
          <>
            <Rows
              hits={hits.filter((hit) => hit.tier === 'prefix')}
              registrados={registrados}
              heredados={heredados}
              mostrarMarca={mostrarMarca}
              onPick={onPick}
            />
            {hits.some((hit) => hit.tier === 'partial') && (
              <>
                <div className="divider">coincidencias parciales</div>
                <Rows
                  hits={hits.filter((hit) => hit.tier === 'partial')}
                  registrados={registrados}
                  heredados={heredados}
                  mostrarMarca={mostrarMarca}
                  onPick={onPick}
                />
              </>
            )}
            {hits.length > MAX_ROWS && (
              <p className="divider">
                y {hits.length - MAX_ROWS} más — escribe otra palabra para acotar
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Rows({
  hits,
  registrados,
  heredados,
  mostrarMarca,
  onPick,
}: {
  hits: readonly { item: CounterItem }[];
  registrados: ReadonlySet<number>;
  heredados: ReadonlySet<number>;
  mostrarMarca: boolean;
  onPick: (item: CounterItem) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <ul className="rows">
      {hits.slice(0, MAX_ROWS).map(({ item }) => (
        <li key={item.idarticulo}>
          <button type="button" className="row" onClick={() => onPick(item)}>
            <span className="row__main">
              <span className="row__nombre">{item.nombre}</span>
              <span className="row__meta">
                <span className="num">{item.codigo}</span> · {item.presentacion}
              </span>
            </span>
            <span className="row__right">
              {mostrarMarca && (
                <Registrado
                  propio={registrados.has(item.idarticulo)}
                  heredado={heredados.has(item.idarticulo)}
                />
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
