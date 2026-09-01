/**
 * The lists behind the flags — P2.4 §3, §4b and §5.
 *
 * Each of these is a set the admin walks before sealing. None of them blocks,
 * none of them offers a correction, and every one of them shows the arithmetic
 * rather than a verdict: an admin who could press a button here would be
 * entering a number nobody observed.
 *
 * They are separate panels rather than one "findings" list because they ask for
 * different things. An overlap wants a question asked over a radio; a zero wants
 * somebody to walk to a shelf; a loose note wants a decision about stock the
 * file cannot represent at all.
 */
import type {
  Amendment,
  ExplicitZero,
  Overlap,
  ReviewNotes,
  SupersededWaiver,
  TrailingRetraction,
} from '../../domain';
import { formatInstant, formatMoney, formatQty } from '../format';

export function Overlaps({ overlaps }: { overlaps: readonly Overlap[] }) {
  if (overlaps.length === 0) return null;
  return (
    <div className="panel" id="hallazgo-overlap">
      <div className="panel__title">{`Artículos con dos contadores (${overlaps.length})`}</div>
      <div className="panel__body">
        <div className="hint">
          {/* The two causes want opposite reactions, which is the whole reason
              they are told apart instead of counted together. */}
          El reparto es disjunto, así que un artículo con registros de dos
          personas siempre vale una mirada. Si cambió de manos durante el conteo,
          es el residuo esperado de un relevo. Si nadie lo reasignó, o las
          secciones se tocaron físicamente o alguien contó fuera de su pasillo —
          y ese es el conteo doble que la suma no puede detectar sola.
        </div>
      </div>
      <ul className="rows">
        {overlaps.map((overlap) => (
          <li className="row row--static" key={overlap.item.idarticulo}>
            <div className="row__main">
              <div className="row__nombre">{overlap.item.nombre}</div>
              <div className="row__meta">
                {overlap.causa === 'reasignado' && overlap.movimiento
                  ? `cambió de manos ${formatInstant(overlap.movimiento.at)} · ` +
                    `${overlap.movimiento.from} → ${overlap.movimiento.to} ` +
                    `(${overlap.movimiento.usuario}): ${overlap.movimiento.motivo}`
                  : 'nadie lo reasignó — dos secciones, o alguien contó fuera de su pasillo'}
              </div>
              {overlap.contribuciones.map((part) => (
                <div className="row__meta" key={part.counterId}>
                  {`${part.nombre}: ${part.cantidad === null ? '—' : formatQty(part.cantidad)} ` +
                    `en ${part.entradas} registros · ${formatInstant(part.primero)}`}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Amendments({ amendments }: { amendments: readonly Amendment[] }) {
  if (amendments.length === 0) return null;
  return (
    <div className="panel" id="hallazgo-post-finish">
      <div className="panel__title">{`Registros después de terminar (${amendments.length})`}</div>
      <div className="panel__body">
        <div className="hint">
          Esto es el registro de enmiendas. Se deriva de la posición en la
          bitácora de cada contador, no de una marca guardada: una marca puesta
          al llegar diría «después de terminar» sobre un registro que se hizo
          antes y llegó tarde.
        </div>
      </div>
      <ul className="rows">
        {amendments.map((amendment) => (
          <li className="row row--static" key={amendment.event.id}>
            <div className="row__main">
              <div className="row__nombre">
                {amendment.item ? amendment.item.nombre : 'nota de sesión'}
              </div>
              <div className="row__meta">
                {`${amendment.nombre} · ${amendment.event.kind}` +
                  ('qty' in amendment.event ? ` ${formatQty(amendment.event.qty)}` : '') +
                  ` · ${formatInstant(amendment.event.at)}` +
                  (amendment.reabierto ? ' · reabrió antes' : ' · sin reabrir')}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * §3c — every standing zero, as its own list.
 *
 * A zero is a stock deletion: under ZEUS_FORMAT.md §7.4, writing `0` into `toma`
 * zeroes the balance. It is the highest-consequence entry in the system and the
 * one a mis-tap produces, so it gets a screen somebody walks rather than a flag
 * in a column — sorted by what each line writes off.
 *
 * **No bulk dismiss.** The list is short by nature and every line is a
 * write-off; a button that cleared it would be a button that clears attention.
 */
export function Zeros({ zeros }: { zeros: readonly ExplicitZero[] }) {
  if (zeros.length === 0) return null;
  const total = zeros.reduce((sum, zero) => sum + zero.valor, 0);
  return (
    <div className="panel" id="hallazgo-ceros">
      <div className="panel__title">{`Registrados en cero (${zeros.length})`}</div>
      <div className="panel__body">
        <div className="hint">
          {`Cada línea borra el saldo en libros de una fila. En total ${formatMoney(total)} COP. ` +
            'Léelas una por una antes de sellar: no hay forma de deshacerlas desde aquí, y ' +
            'tampoco debería haberla — quien contó es quien puede corregir.'}
        </div>
      </div>
      <ul className="rows">
        {zeros.map((zero) => (
          <li className="row row--static" key={zero.event.id}>
            <div className="row__main">
              <div className="row__nombre">{zero.item.nombre}</div>
              <div className="row__meta">
                {`${zero.nombre} · ${formatInstant(zero.event.at)} · libros ` +
                  `${formatQty(zero.item.existencia)} = ${formatMoney(zero.valor)} COP`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Trailing({ trailing }: { trailing: readonly TrailingRetraction[] }) {
  if (trailing.length === 0) return null;
  return (
    <div className="panel" id="hallazgo-retraccion">
      <div className="panel__title">{`Terminaron deshaciendo (${trailing.length})`}</div>
      <div className="panel__body">
        <div className="hint">
          Lo último que hicieron fue retirar un registro y no pusieron otro. O es
          una corrección que quedó a medias, o su reemplazo se perdió. La tableta
          ya no manda un retiro sin su reemplazo, así que lo que quede aquí hay
          que preguntarlo.
        </div>
      </div>
      <ul className="rows">
        {trailing.map((mark) => (
          <li className="row row--static" key={mark.event.id}>
            <div className="row__main">
              <div className="row__nombre">
                {mark.item ? mark.item.nombre : `artículo ${mark.event.idarticulo ?? '—'}`}
              </div>
              <div className="row__meta">
                {`${mark.nombre} · ${mark.estado} · ${formatInstant(mark.event.at)}` +
                  (mark.retirado && 'qty' in mark.retirado
                    ? ` · retiró ${formatQty(mark.retirado.qty)}`
                    : '')}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * §4b — waivers a count overtook.
 *
 * The projection already refuses to let one of these suppress the count: a
 * waiver applies only where nothing was counted, which is what makes the outcome
 * independent of when a tablet reached wifi. What is left is a fact about a
 * person's decision — they signed for a row that turned out to have data — and
 * they have to see it before sealing.
 */
export function Superseded({ superseded }: { superseded: readonly SupersededWaiver[] }) {
  if (superseded.length === 0) return null;
  return (
    <div className="panel" id="hallazgo-waiver">
      <div className="panel__title">{`Exoneraciones que un conteo dejó sin efecto (${superseded.length})`}</div>
      <div className="panel__body">
        <div className="hint">
          La exoneración no borró nada: el conteo manda, siempre, llegue cuando
          llegue. Está aquí porque alguien firmó por una fila que sí tenía datos.
        </div>
      </div>
      <ul className="rows">
        {superseded.map((waiver) => (
          <li className="row row--static" key={`${waiver.actionId}-${waiver.item.idarticulo}`}>
            <div className="row__main">
              <div className="row__nombre">{waiver.item.nombre}</div>
              <div className="row__meta">
                {`exonerada por ${waiver.usuario} ${formatInstant(waiver.at)}: ${waiver.motivo}`}
              </div>
              <div className="row__meta">
                {`contada: ${waiver.qty === undefined ? waiver.state : formatQty(waiver.qty)}` +
                  (waiver.contadores.length > 0 ? ` · ${waiver.contadores.join(', ')}` : '')}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * §5 — notes, grouped by counter, with the loose ones pulled out.
 *
 * A note with no `idarticulo` is the important kind: physical stock with no
 * catalogue row. There is nowhere in the Zeus file to put one — `Observacion` is
 * dropped and `Grupo1..5` are forbidden — so it is either in the log and on the
 * acta, or it is nowhere. It gets its own section for that reason and not
 * because there are few of them.
 */
export function Notas({ notes }: { notes: ReviewNotes }) {
  if (notes.porContador.length === 0) return null;
  return (
    <>
      {notes.sueltas.length > 0 && (
        <div className="panel" id="hallazgo-notas">
          <div className="panel__title">{`Notas sin artículo (${notes.sueltas.length})`}</div>
          <div className="panel__body">
            <div className="hint">
              Mercancía que el archivo no puede representar: no hay fila en el
              catálogo para ponerla. Decídelo antes de sellar, no después.
            </div>
          </div>
          <ul className="rows">
            {notes.sueltas.map((note) => (
              <li className="row row--static" key={note.event.id}>
                <div className="row__main">
                  <div className="row__nombre">{note.event.texto}</div>
                  <div className="row__meta">
                    {`${note.nombre} · ${formatInstant(note.event.at)}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel">
        <div className="panel__title">Notas por contador</div>
        {notes.porContador.map((group) => (
          <div key={group.counterId ?? 'sin-contador'}>
            <div className="panel__subtitle">{group.nombre}</div>
            <ul className="rows">
              {group.notas.map((note) => (
                <li className="row row--static" key={note.event.id}>
                  <div className="row__main">
                    <div className="row__nombre">{note.event.texto}</div>
                    <div className="row__meta">
                      {(note.item ? `${note.item.nombre} · ` : 'sin artículo · ') +
                        formatInstant(note.event.at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
