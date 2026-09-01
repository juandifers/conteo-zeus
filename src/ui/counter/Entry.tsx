/**
 * Recording what is on the shelf.
 *
 * Three things a counter can do to an article, and this screen is two of them:
 *
 *     registrar cantidad   add(qty)   «encontré 8»
 *     registrar cero       add(0)     «fui al estante, está vacío»
 *
 * The third is a note, which has its own tab. **`unchanged` is not here and is
 * not reachable from here** (P2.3): a waiver asserts the book figure is right
 * without counting, and this device has never seen the book figure — asking
 * somebody to vouch for a number redacted from their tablet is incoherent, and
 * it is the exact judgment blindness exists to prevent. Waivers are the admin's,
 * at review, with one name on them.
 *
 * **Nothing on this card is a total.** The field starts empty on every visit,
 * including the second visit to an article already counted — P1 pre-filled it
 * with the running value, which on a shared shelf is precisely the anchor §2.1
 * removes. What the counter sees is the number they are typing and, afterwards,
 * the number they just entered.
 *
 * `add` and not `set`, always. Two entries on one article are two locations, not
 * a correction: the same product sits on a shelf and in a cold room, and the
 * count is the sum of what was found. Correcting is Mis registros' job, and it
 * withdraws a named event rather than overwriting a number.
 *
 * After a handover that additivity stops being invisible, so it is said out
 * loud. An article somebody else already registered (P2.3.5 §6b) gets one more
 * ask before the write — «tu cantidad se sumará a la suya» — which is the plain
 * truth about the fold, names the consequence, and reveals no number.
 *
 * ## Why `add(0)` is the right primitive for an empty shelf
 *
 * It folds to `(current ?? 0) + 0`. First entry on an untouched article →
 * `counted` at 0, which writes 0 to `toma` and zeroes the balance (§7.4) —
 * correct, and what the counter meant. A later entry on an article already at 5
 * → still 5, also correct: *this other location* is empty and adds nothing. The
 * counter cannot tell which case they are in and does not need to; both are
 * right. Hence the copy, which says «este lugar» and not «este artículo».
 */
import { useState } from 'react';

import type { CounterItem } from '../../domain';
import { formatQty, parseQty, unusualQty } from '../format';
import type { CountStore } from '../store';
import { Registrado } from './Registrado';

type Phase =
  | { name: 'typing' }
  | { name: 'confirm'; qty: number }
  /** The soft second ask. Only ever reached from `confirm` with an odd number. */
  | { name: 'unusual'; qty: number }
  /**
   * Somebody else already registered this article (P2.3.5 §6b).
   *
   * The last step before the write, so it catches the zero action too: a
   * counter who declares an inherited shelf empty is *adding* a zero to
   * somebody else's number, which changes nothing and is exactly what the
   * sentence says.
   */
  | { name: 'otro'; qty: number }
  | { name: 'zero' };

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', ',', '0', '⌫'] as const;

export function Entry({
  item,
  group,
  registrados,
  heredados,
  mostrarMarca,
  store,
  onActive,
  onDone,
}: {
  item: CounterItem;
  /** Every presentation under this `codigo` — up to five, each its own balance. */
  group: readonly CounterItem[];
  registrados: ReadonlySet<number>;
  /** Articles somebody else had registered when this device fetched (§6b). */
  heredados: ReadonlySet<number>;
  mostrarMarca: boolean;
  store: CountStore;
  onActive: (item: CounterItem) => void;
  /** Leave the card. The string is the one line the search screen prints back. */
  onDone: (echo: string | null) => void;
}) {
  // A fresh field for every article, and never seeded from what is already
  // recorded — see the module note. `CounterScreen` keys this component on
  // `idarticulo`, so switching article remounts it and the initial state below
  // *is* the reset: no effect, and no render in which the previous article's
  // number is on screen under the new article's name.
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>({ name: 'typing' });

  const typed = parseQty(draft);

  function press(key: (typeof KEYS)[number]): void {
    setPhase({ name: 'typing' });
    setDraft((current) => {
      if (key === '⌫') return current.slice(0, -1);
      if (key === ',') return current.includes(',') || current.includes('.') ? current : `${current || '0'},`;
      return current + key;
    });
  }

  /**
   * The one funnel every path to a write goes through.
   *
   * An inherited article gets one more ask here rather than at each of the
   * three entrances, so the zero action and the unusual-quantity path cannot
   * quietly skip it.
   */
  function record(qty: number): void {
    if (heredados.has(item.idarticulo)) setPhase({ name: 'otro', qty });
    else write(qty);
  }

  function write(qty: number): void {
    store.addCount(item.idarticulo, qty);
    onDone(`registrado — ${item.nombre} · ${formatQty(qty)} ${item.unidad}`);
  }

  const mixedNames = new Set(group.map((row) => row.nombre)).size > 1;

  return (
    <>
      <div className="entry">
        <div className="entry__head">
          <div className="entry__nombre">
            {item.nombre}
            <div className="entry__codigo num">
              {item.codigo} · {item.presentacion}
            </div>
          </div>
          {mostrarMarca && (
            <Registrado
              propio={registrados.has(item.idarticulo)}
              heredado={heredados.has(item.idarticulo)}
            />
          )}
          <button
            type="button"
            className="entry__close"
            aria-label="volver a buscar"
            onClick={() => onDone(null)}
          >
            ✕
          </button>
        </div>

        <div className="readout">
          <div className="readout__field">
            <input
              autoFocus
              className="readout__input num"
              inputMode="decimal"
              autoComplete="off"
              aria-label={`cantidad contada de ${item.nombre}`}
              placeholder="0"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setPhase({ name: 'typing' });
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (typed !== null) setPhase({ name: 'confirm', qty: typed });
              }}
            />
            {/*
              `presentacion`, verbatim (P2.1 deviation 3). `UNIDAD DE 450 A 550
              GRAMOS` is unhelpful and true; a parsed-and-guessed unit beside a
              keypad is a wrong number, because a counter shown `KILO` for a row
              measured in boxes types boxes.
            */}
            <span className="readout__unit">{item.unidad}</span>
          </div>
        </div>

        {/*
          An on-screen decimal pad rather than only the tablet keyboard. Cold
          room, gloves, glare: the OS keyboard puts the digits in a two-hand
          layout with a half-height comma, and much of this catalogue sells by
          weight so an integer pad would silently truncate.
        */}
        <div className="keypad">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="keypad__key"
              aria-label={key === '⌫' ? 'borrar' : key === ',' ? 'coma decimal' : key}
              onClick={() => press(key)}
            >
              {key}
            </button>
          ))}
        </div>

        {group.length > 1 && (
          <div className="presentaciones">
            <div className="presentaciones__label">
              {group.length} presentaciones bajo <span className="num">{item.codigo}</span> —
              cada una cuenta aparte
              {mixedNames && ' · ojo: no todas son el mismo artículo'}
            </div>
            {group.map((row) => (
              <button
                type="button"
                key={row.idarticulo}
                className={`presrow ${row.idarticulo === item.idarticulo ? 'presrow--active' : ''}`}
                onClick={() => onActive(row)}
              >
                <span className="presrow__name">
                  {mixedNames && <strong>{row.nombre} · </strong>}
                  {row.presentacion}
                </span>
                {mostrarMarca && (
                  <Registrado
                    propio={registrados.has(row.idarticulo)}
                    heredado={heredados.has(row.idarticulo)}
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="spacer" />

      {phase.name === 'confirm' && (
        <div className="confirm">
          <div className="confirm__text">
            <div className="confirm__qty num">{formatQty(phase.qty)}</div>
            <div>{`${item.nombre} · ${item.unidad}`}</div>
          </div>
          <div className="actions__pair">
            <button type="button" className="btn" onClick={() => setPhase({ name: 'typing' })}>
              Volver
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() =>
                unusualQty(phase.qty)
                  ? setPhase({ name: 'unusual', qty: phase.qty })
                  : record(phase.qty)
              }
            >
              {`Sí, registrar ${formatQty(phase.qty)}`}
            </button>
          </div>
        </div>
      )}

      {phase.name === 'unusual' && (
        <div className="confirm">
          <div className="confirm__text">
            {`Es una cantidad poco común: ${formatQty(phase.qty)} ${item.unidad}. ¿La escribiste bien?`}
          </div>
          <div className="actions__pair">
            <button type="button" className="btn" onClick={() => setPhase({ name: 'typing' })}>
              Volver a escribir
            </button>
            <button type="button" className="btn btn--primary" onClick={() => record(phase.qty)}>
              Sí, es correcta
            </button>
          </div>
        </div>
      )}

      {phase.name === 'otro' && (
        <div className="confirm">
          <div className="confirm__text">
            Otra persona ya registró este artículo. Tu cantidad se sumará a la suya.
            <div className="hint">
              Si estás en otro lugar del que contó esa persona, está bien: la suma es el
              conteo. Si vas a recontar lo mismo, avisa al administrador en vez de registrar.
            </div>
          </div>
          <div className="actions__pair">
            <button type="button" className="btn" onClick={() => setPhase({ name: 'typing' })}>
              Volver
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => write(phase.qty)}
            >
              {`Sí, sumar ${formatQty(phase.qty)}`}
            </button>
          </div>
        </div>
      )}

      {phase.name === 'zero' && (
        <div className="confirm">
          <div className="confirm__text">
            ¿Confirmas que este lugar está vacío?
            <div className="hint">
              «Cero» significa que aquí no hay nada, no que el artículo esté en cero. Si antes
              registraste algo por error, corrígelo en Mis registros.
            </div>
          </div>
          <div className="actions__pair">
            <button type="button" className="btn" onClick={() => setPhase({ name: 'typing' })}>
              Volver
            </button>
            <button type="button" className="btn btn--primary" onClick={() => record(0)}>
              Sí, está vacío
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={typed === null}
          onClick={() => typed !== null && setPhase({ name: 'confirm', qty: typed })}
        >
          Registrar{typed !== null ? ` ${formatQty(typed)}` : ''}
        </button>
        {/*
          A distinct action, not a `0` typed into the pad. A zero is a stock
          deletion under §7.4 and should cost one deliberate tap more than a
          number does — and «está vacío» is a different sentence from «cero»,
          which is the sentence somebody actually means.
        */}
        <button type="button" className="btn" onClick={() => setPhase({ name: 'zero' })}>
          Está vacío (registrar cero)
        </button>
      </div>
    </>
  );
}
