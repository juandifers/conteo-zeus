/**
 * Entry for one `codigo`.
 *
 * 188 of 232 codes carry exactly one presentation, so the common case is a
 * single readout: type, Enter, gone. The other 44 render every presentation at
 * once, each bound to its own `idarticulo` — that grouping is the whole
 * defence against posting a count to the wrong balance (ZEUS_FORMAT.md §4).
 * The active presentation owns the big readout; the rest stay visible below
 * it with their own book figures and their own states, so nobody types 60 into
 * `KILO` when they weighed `PORCION X 350 GRAMOS`.
 *
 * Three actions, and the distance between the first two is the design:
 *
 *   Guardar / Coincide con el sistema   a count. Somebody looked.
 *   Modo conteo                         a count, accumulated a tap at a time.
 *   dejar sin verificar                 a *waiver*. Not a count, and it carries
 *                                       a name (DOMAIN.md §4). Rendered as a
 *                                       plain underlined link below the two
 *                                       counts: an escape hatch, not a shortcut.
 */
import { useEffect, useRef, useState } from 'react';
import type { Item, Resolution } from '../../domain';
import { formatQty, parseQty } from '../format';
import type { CountStore } from '../store';
import { StateChip } from './StateChip';
import { Expected, VarianceReadout } from './VarianceReadout';

export interface EntryCardProps {
  group: readonly Item[];
  active: Item;
  onActive: (item: Item) => void;
  /** Leave the card. `echo` is the one line the search screen prints back. */
  onFinish: (echo: string | null) => void;
  store: CountStore;
  resolutions: ReadonlyMap<number, Resolution>;
}

const UNTOUCHED: Resolution = { state: 'untouched' };

export function EntryCard({
  group,
  active,
  onActive,
  onFinish,
  store,
  resolutions,
}: EntryCardProps) {
  const [draft, setDraft] = useState('');
  const [tally, setTally] = useState(false);
  const [confirmZero, setConfirmZero] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const resolution = resolutions.get(active.idarticulo) ?? UNTOUCHED;
  // Both derived from the fold, not from a rule this component keeps: a
  // control is available exactly when the event behind it would change
  // something (DOMAIN.md §3).
  const canUndo = store.canUndo(active.idarticulo);
  const canDiscard = store.canRetract(active.idarticulo);

  // A second visit shows what was recorded, ready to be corrected rather than
  // retyped from nothing.
  useEffect(() => {
    const current = resolutions.get(active.idarticulo);
    setDraft(current?.state === 'counted' ? formatQty(current.qty!) : '');
    setConfirmZero(false);
    // Deliberately keyed on the item only: re-running this when `resolutions`
    // changes would overwrite what the person is halfway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.idarticulo]);

  useEffect(() => {
    if (!tally) field.current?.focus();
  }, [tally, active.idarticulo]);

  /** Live preview: what the variance would be if this draft landed. */
  const typed = parseQty(draft);
  const preview: Resolution =
    !tally && typed !== null ? { state: 'counted', qty: typed } : resolution;

  const index = group.findIndex((item) => item.idarticulo === active.idarticulo);

  // ZEUS_FORMAT.md §4 offers "nombre is stable per codigo" as an import
  // integrity check; §5 records the sample .txt failing it on 43 of 232 codes,
  // because two differently-sorted blocks were pasted together by hand. Where a
  // group disagrees with itself the card prints every name, because a card
  // headed PANCETA SV whose second row is a different product is how a count
  // reaches the wrong balance without anybody noticing.
  const mixedNames = new Set(group.map((item) => item.nombre)).size > 1;

  function advance(echo: string): void {
    if (index >= 0 && index < group.length - 1) onActive(group[index + 1]);
    else onFinish(echo);
  }

  function commit(qty: number): void {
    // DOMAIN.md §2's UI rule, derived rather than modelled: a count of zero
    // against a non-zero book figure is both the genuine write-off and what a
    // mis-tap produces, so it is the one entry that gets asked twice.
    if (qty === 0 && active.existencia > 0 && !confirmZero) {
      setConfirmZero(true);
      return;
    }
    store.setCount(active.idarticulo, qty);
    setConfirmZero(false);
    advance(`${active.nombre} · ${formatQty(qty)}`);
  }

  function waive(): void {
    store.markUnchanged(active.idarticulo);
    advance(`${active.nombre} · sin verificar`);
  }

  return (
    <>
      <div className={`entry ${tally ? 'entry--tally' : ''}`}>
        <div className="entry__head">
          <div className="entry__nombre">
            {active.nombre}
            <div className="entry__codigo num">
              {active.codigo} · {active.presentacion}
            </div>
          </div>
          <StateChip item={active} resolution={resolution} />
          <button
            type="button"
            className="entry__close"
            aria-label="volver a buscar"
            onClick={() => onFinish(null)}
          >
            ✕
          </button>
        </div>

        {tally ? (
          <button
            type="button"
            className="tallypad"
            onClick={() => store.addCount(active.idarticulo, 1)}
            aria-label={`sumar uno a ${active.nombre}`}
          >
            <span className="tallypad__value num landed" key={resolution.qty ?? 0}>
              {formatQty(resolution.qty ?? 0)}
            </span>
            <span className="tallypad__hint">toca aquí para sumar 1</span>
          </button>
        ) : (
          <div className="readout">
            <Expected item={active} />
            <div className="readout__field">
              <input
                ref={field}
                className="readout__input num"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`cantidad contada de ${active.nombre}`}
                placeholder="0"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setConfirmZero(false);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (typed !== null) commit(typed);
                }}
              />
              <span className="readout__unit">{active.presentacion}</span>
            </div>
          </div>
        )}

        <VarianceReadout item={active} resolution={preview} />

        {group.length > 1 && (
          <div className="presentaciones">
            <div className="presentaciones__label">
              {group.length} presentaciones bajo <span className="num">{active.codigo}</span> —
              cada una cuenta aparte
              {mixedNames && ' · ojo: no todas son el mismo artículo'}
            </div>
            {group.map((item) => {
              const each = resolutions.get(item.idarticulo) ?? UNTOUCHED;
              return (
                <button
                  type="button"
                  key={item.idarticulo}
                  className={`presrow ${item.idarticulo === active.idarticulo ? 'presrow--active' : ''}`}
                  onClick={() => onActive(item)}
                >
                  <span className="presrow__name">
                    {mixedNames && <strong>{item.nombre} · </strong>}
                    {item.presentacion}
                  </span>
                  <span className="presrow__qty num">{formatQty(item.existencia)}</span>
                  <StateChip item={item} resolution={each} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!tally && <div className="spacer" />}

      {confirmZero && (
        <div className="confirm">
          <div className="confirm__text">
            El sistema dice <span className="num">{formatQty(active.existencia)}</span> y vas a
            registrar <span className="num">0</span>. ¿El estante está vacío?
          </div>
          <div className="actions__pair">
            <button type="button" className="btn" onClick={() => setConfirmZero(false)}>
              Volver
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                store.setCount(active.idarticulo, 0);
                setConfirmZero(false);
                advance(`${active.nombre} · 0`);
              }}
            >
              Sí, registrar 0
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        {tally ? (
          <div className="actions__pair">
            <button
              type="button"
              className="btn"
              onClick={() => store.addCount(active.idarticulo, -1)}
              disabled={(resolution.qty ?? 0) <= 0}
            >
              −1
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => advance(`${active.nombre} · ${formatQty(resolution.qty ?? 0)}`)}
            >
              Listo
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={typed === null}
            onClick={() => typed !== null && commit(typed)}
          >
            Guardar{typed !== null ? ` ${formatQty(typed)}` : ''}
          </button>
        )}

        <div className="actions__pair">
          <button type="button" className="btn" onClick={() => commit(active.existencia)}>
            Coincide con el sistema
          </button>
          <button
            type="button"
            className={`btn ${tally ? 'btn--on' : ''}`}
            aria-pressed={tally}
            onClick={() => setTally((on) => !on)}
          >
            Modo conteo
          </button>
        </div>

        <button type="button" className="btn btn--waiver" onClick={waive}>
          Dejar sin verificar
        </button>

        {/*
          Corrections, in their own register.

          Adding a third quiet control forced this rule. The three *outcomes* —
          count, accept, waive — are ranked by fill, border and underline, and
          that ranking only reads if nothing else shares the bottom of the
          screen with them. `Deshacer` and `Descartar conteo` are not outcomes;
          they undo one. Below the line, and neither is a fast path.

          They are also left-packed, out of the right-hand column. That column
          holds the mode's primary action — `Guardar`, which spans it, or
          `Listo` in tally mode — and nothing else, because the thumb goes there
          without looking. `Descartar conteo` used to sit in it, one row below
          where `Listo` had just been.
        */}
        <div className="corrections">
          <button
            type="button"
            className="btn btn--small"
            disabled={!canDiscard}
            onClick={() => store.retract(active.idarticulo)}
          >
            Descartar conteo
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={!canUndo}
            onClick={() => store.undo(active.idarticulo)}
          >
            Deshacer
          </button>
        </div>
      </div>
    </>
  );
}
