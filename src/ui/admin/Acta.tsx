/**
 * El acta de conteo — P2.5 §3.
 *
 * The artifact that does not exist today. Zeus can produce the `.txt`; nothing
 * currently produces the document that says what actually happened, and the
 * information dies in a stack of printed Excel.
 *
 * Written for a reader who was not there and may be an auditor. That reader
 * cannot ask a question, so every figure on the page carries its own definition
 * and every claim carries its grade of evidence.
 *
 * ## Printable HTML, rendered to PDF by the browser
 *
 * No server-side PDF library. The document has to stay editable in source and
 * legible in a repository in three years, and a template in a binary-adjacent
 * DSL is neither. The browser's own print dialogue produces the PDF, and
 * `@media print` in `admin.css` is the whole of the layout difference.
 *
 * ## §8 is the reason the rest is honest
 *
 * The `.txt` will assert something false about thousands of rows — not through
 * dishonesty, but because a flat file has no way to express «we did not look»
 * (ZEUS_FORMAT.md §9). This is the only document that distinguishes the rows
 * somebody walked from the rows a policy filled in, and §8 says so in as many
 * words rather than leaving it to be inferred from a table.
 */
import {
  ownSummary,
  type AssignedSection,
  type CountEvent,
  type Review,
  type SessionActionRecord,
  type SellarSinRegistrosPayload,
  type WaiverPayload,
} from '../../domain';
import { formatInstant, formatMoney, formatQty, formatSignedQty } from '../format';
import { describeFlag } from './blockers';
import type { SessionDetail, Sello, SyncSnapshot } from './types';

/** How many variance rows §3 names before it stops. The largest by exposure. */
const TOP_VARIANCES = 20;

export interface ActaProps {
  detail: SessionDetail;
  review: Review;
  sync: SyncSnapshot;
  sello: Sello;
  events: readonly CountEvent[];
  /** The `.txt`'s name, once it exists. Null between the seal and the export. */
  filename: string | null;
  /** Rendered on the page rather than read from a clock, so a reprint is identical. */
  generadaAt: string;
}

export function Acta({
  detail,
  review,
  sync,
  sello,
  events,
  filename,
  generadaAt,
}: ActaProps) {
  const parameters = detail.session.parameters;
  const verificados = detail.session.parametrosVerificados;

  const waived = waivedArticles(review);
  const contadosEnCero = review.zeros.length;

  return (
    <article className="acta" id="acta">
      <header className="acta__head">
        <h1 className="acta__title">Acta de conteo físico</h1>
        <div className="acta__meta">
          Bodega {detail.session.bodega} · corte {detail.session.fechaCorte}
          {detail.session.nombre ? ` · ${detail.session.nombre}` : ''}
        </div>
        <div className="acta__meta">
          Generada {formatInstant(generadaAt)} · sesión <code>{detail.session.id}</code>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>1 · Alcance</h2>
        <table className="acta__kv">
          <tbody>
            <tr>
              <th scope="row">Archivo de origen</th>
              <td>{detail.session.sourceName ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Filas del catálogo</th>
              <td className="num">{formatQty(review.rows.length)}</td>
            </tr>
            <tr>
              <th scope="row">Contadas</th>
              <td className="num">{formatQty(review.counts.counted)}</td>
            </tr>
            <tr>
              <th scope="row">Contadas en cero</th>
              <td className="num">{formatQty(contadosEnCero)}</td>
            </tr>
            <tr>
              <th scope="row">Exoneradas por el administrador</th>
              <td className="num">{formatQty(waived.size)}</td>
            </tr>
            <tr>
              <th scope="row">Sin contar</th>
              <td className="num">{formatQty(review.counts.untouched)}</td>
            </tr>
            <tr>
              <th scope="row">Sellada</th>
              <td>{formatInstant(sello.sealedAt)}</td>
            </tr>
            <tr>
              <th scope="row">Archivo generado</th>
              <td>
                {sello.exportedAt ? `${formatInstant(sello.exportedAt)} · ${filename ?? ''}` : 'todavía no'}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="acta__note">
          Parámetros de escritura: <code>{parameters.countTargetColumn}</code> para la
          cantidad contada, <code>{parameters.uncountedPolicy}</code> para las filas sin
          contar, <code>{parameters.differenceColumn}</code> para la diferencia.{' '}
          {verificados ? (
            <>Es la combinación verificada contra Zeus (ZEUS_FORMAT.md §7.1).</>
          ) : (
            <strong>
              No es la combinación verificada contra Zeus. Esta sesión se creó con
              parámetros que nunca se han comprobado contra el ERP:{' '}
              {detail.session.parametrosSinVerificar.join(', ')}.
            </strong>
          )}
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>2 · Participantes</h2>
        <ul className="acta__list">
          {sync.counters.map((counter) => {
            const secciones = sectionsOf(detail, counter.id);
            const asignados = secciones.reduce((sum, section) => sum + section.items.length, 0);
            const suyo = ownSummary(secciones, events, counter.id);
            const mine = events.filter((event) => event.counterId === counter.id);
            const primero = mine.reduce<string | null>(
              (min, event) => (min === null || event.at < min ? event.at : min),
              null,
            );
            const ultimo = mine.reduce<string | null>(
              (max, event) => (max === null || event.at > max ? event.at : max),
              null,
            );
            return (
              <li className="acta__participant" key={counter.id}>
                <div className="acta__participantName">{counter.nombre}</div>
                <div className="acta__meta">
                  {secciones.map((section) => section.nombre).join(' · ') || 'sin secciones'}
                </div>
                <div className="acta__meta">
                  {`${formatQty(asignados)} artículos asignados · ${formatQty(suyo.registrados)} registrados · ` +
                    `${formatQty(suyo.registros)} registros · ${formatQty(suyo.ceros)} en cero · ` +
                    `${formatQty(suyo.notas)} notas`}
                </div>
                <div className="acta__meta">
                  {primero
                    ? `de ${formatInstant(primero)} a ${formatInstant(ultimo!)}`
                    : 'sin actividad registrada'}
                  {counter.deviceIds.length > 0
                    ? ` · ${counter.deviceIds.length} tableta(s)`
                    : ''}
                  {counter.clockSkewMs === null
                    ? ''
                    : ` · reloj ${formatSignedQty(Math.round(counter.clockSkewMs / 1000))} s`}
                </div>
                <Evidence counter={counter} acciones={sync.acciones} />
              </li>
            );
          })}
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>3 · Resultado</h2>
        <table className="acta__kv">
          <tbody>
            <tr>
              <th scope="row">Filas contadas</th>
              <td className="num">{formatQty(review.counts.counted)}</td>
            </tr>
            <tr>
              <th scope="row">Diferencia neta</th>
              <td className="num">{formatMoney(review.netVarianceValue)} COP</td>
            </tr>
            <tr>
              <th scope="row">Diferencia bruta (suma de valores absolutos)</th>
              <td className="num">{formatMoney(review.grossVarianceValue)} COP</td>
            </tr>
          </tbody>
        </table>

        {/* §5's pair, with the definitions on the page rather than assumed.
            Somebody reading this in a year cannot ask what «pendiente» means. */}
        <table className="acta__kv">
          <tbody>
            <tr>
              <th scope="row">pendiente</th>
              <td className="num">{formatMoney(review.pendiente.exposicion)} COP</td>
              <td>{`${formatQty(review.pendiente.items)} filas que nadie tocó`}</td>
            </tr>
            <tr>
              <th scope="row">sin verificar</th>
              <td className="num">{formatMoney(review.sinVerificar.exposicion)} COP</td>
              <td>
                {`${formatQty(review.pendiente.items)} sin tocar + ${formatQty(review.exoneradas)} exoneradas`}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="acta__note">
          <strong>pendiente</strong> es lo que todavía se podría ir a contar.{' '}
          <strong>sin verificar</strong> es lo que nadie contó, exonerado o no. Exonerar
          baja la primera y no mueve la segunda: una exoneración registra quién aceptó una
          exposición, no la retira.
        </p>

        <h3>Mayores diferencias, por exposición</h3>
        <table className="acta__grid">
          <thead>
            <tr>
              <th>código</th>
              <th>artículo</th>
              <th className="num">Zeus</th>
              <th className="num">conteo</th>
              <th className="num">diferencia</th>
              <th className="num">exposición</th>
            </tr>
          </thead>
          <tbody>
            {review.rows
              .filter((row) => row.state === 'counted' && row.diferencia !== 0)
              .slice(0, TOP_VARIANCES)
              .map((row) => (
                <tr key={row.item.idarticulo}>
                  <td>{row.item.codigo}</td>
                  <td>{`${row.item.nombre} · ${row.item.presentacion}`}</td>
                  <td className="num">{formatQty(row.item.existencia)}</td>
                  <td className="num">{formatQty(row.conteo ?? 0)}</td>
                  <td className="num">{formatSignedQty(row.diferencia ?? 0)}</td>
                  <td className="num">{formatMoney(row.exposicion)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>4 · Hallazgos</h2>

        <h3>4.1 · Conteos en cero</h3>
        <p className="acta__note">
          Cada línea es una baja de inventario. Escribir <code>0</code> en la columna de
          conteo pone el saldo en cero (ZEUS_FORMAT.md §7.4), así que estas son las
          entradas de mayor consecuencia del conteo y van itemizadas, nunca resumidas.
        </p>
        {review.zeros.length === 0 ? (
          <p className="acta__note">Ninguno.</p>
        ) : (
          <table className="acta__grid">
            <thead>
              <tr>
                <th>código</th>
                <th>artículo</th>
                <th>quién</th>
                <th>cuándo</th>
                <th className="num">Zeus</th>
                <th className="num">valor en libros</th>
              </tr>
            </thead>
            <tbody>
              {review.zeros.map((zero) => (
                <tr key={zero.event.id}>
                  <td>{zero.item.codigo}</td>
                  <td>{`${zero.item.nombre} · ${zero.item.presentacion}`}</td>
                  <td>{zero.nombre}</td>
                  <td>{formatInstant(zero.event.at)}</td>
                  <td className="num">{formatQty(zero.item.existencia)}</td>
                  <td className="num">{formatMoney(zero.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>4.2 · Artículos con registros de más de un contador</h3>
        {review.overlaps.length === 0 ? (
          <p className="acta__note">Ninguno.</p>
        ) : (
          <ul className="acta__list">
            {review.overlaps.map((overlap) => (
              <li key={overlap.item.idarticulo}>
                <div>
                  <strong>{`${overlap.item.codigo} · ${overlap.item.nombre}`}</strong>{' '}
                  {overlap.causa === 'reasignado'
                    ? '— reasignado durante el conteo'
                    : '— dos secciones: nadie lo reasignó'}
                </div>
                {overlap.movimiento && (
                  <div className="acta__meta">
                    {`movido ${formatInstant(overlap.movimiento.at)} por ${overlap.movimiento.usuario}: ${overlap.movimiento.motivo}`}
                  </div>
                )}
                <div className="acta__meta">
                  {overlap.contribuciones
                    .map(
                      (part) =>
                        `${part.nombre}: ${part.cantidad === null ? 'sin cantidad' : formatQty(part.cantidad)}` +
                        ` (${part.entradas} entradas)`,
                    )
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>4.3 · Registros posteriores a «Terminar»</h3>
        {review.amendments.length === 0 ? (
          <p className="acta__note">Ninguno.</p>
        ) : (
          <ul className="acta__list">
            {review.amendments.map((amendment) => (
              <li key={amendment.event.id}>
                <div className="acta__meta">
                  {`${amendment.nombre} · ${formatInstant(amendment.event.at)} · ` +
                    `${amendment.item ? amendment.item.nombre : 'sin artículo'} · ` +
                    (amendment.reabierto ? 'reabrió antes' : 'sin reabrir')}
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>4.4 · Retiros al final de una cadena</h3>
        {review.trailing.length === 0 ? (
          <p className="acta__note">Ninguno.</p>
        ) : (
          <ul className="acta__list">
            {review.trailing.map((entry) => (
              <li key={entry.event.id}>
                <div className="acta__meta">
                  {`${entry.nombre} (${entry.estado}) · ${formatInstant(entry.event.at)} · ` +
                    `${entry.item ? entry.item.nombre : 'sin artículo'}`}
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>4.5 · Exoneraciones superadas por un conteo</h3>
        {review.superseded.length === 0 ? (
          <p className="acta__note">Ninguna.</p>
        ) : (
          <ul className="acta__list">
            {review.superseded.map((entry) => (
              <li key={`${entry.actionId}-${entry.item.idarticulo}`}>
                <div className="acta__meta">
                  {`${entry.item.codigo} · ${entry.item.nombre} — exonerado por ${entry.usuario} ` +
                    `el ${formatInstant(entry.at)}, y contado por ${entry.contadores.join(', ')}. ` +
                    'Manda el conteo.'}
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>4.6 · Cantidades atípicas</h3>
        {(() => {
          const outliers = review.rows.filter((row) =>
            row.flags.some((flag) => flag.kind === 'outlier'),
          );
          return outliers.length === 0 ? (
            <p className="acta__note">Ninguna.</p>
          ) : (
            <ul className="acta__list">
              {outliers.map((row) => (
                <li key={row.item.idarticulo}>
                  <div className="acta__meta">
                    {`${row.item.codigo} · ${row.item.nombre} — `}
                    {row.flags
                      .filter((flag) => flag.kind === 'outlier')
                      .map((flag) => describeFlag(flag))
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          );
        })()}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>5 · Notas</h2>
        {review.notes.sueltas.length > 0 && (
          <>
            <h3>5.1 · Notas sin artículo</h3>
            <p className="acta__note">
              Existencia física que el archivo no puede representar: no hay fila en el
              catálogo a la que atarla. Esta es la única parte del proceso donde queda
              escrita.
            </p>
            <ul className="acta__list">
              {review.notes.sueltas.map((note) => (
                <li key={note.event.id}>
                  <div className="acta__meta">
                    {`${note.nombre} · ${formatInstant(note.event.at)}`}
                  </div>
                  <div>{note.event.texto}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3>5.2 · Notas por contador</h3>
        {/*
          The ones attached to an article. The loose ones are above, in their own
          subsection, and are not repeated here: a note printed twice in one
          document is a reader wondering whether there were two.
        */}
        {(() => {
          const grouped = review.notes.porContador
            .map((group) => ({ ...group, notas: group.notas.filter((note) => note.item !== null) }))
            .filter((group) => group.notas.length > 0);
          return grouped.length === 0 ? (
            <p className="acta__note">Ninguna sobre un artículo del catálogo.</p>
          ) : (
            grouped.map((group) => (
              <div key={group.counterId ?? 'sin-contador'}>
                <div className="acta__participantName">{group.nombre}</div>
                <ul className="acta__list">
                  {group.notas.map((note) => (
                    <li key={note.event.id}>
                      <div className="acta__meta">
                        {`${formatInstant(note.event.at)} · ${note.item!.nombre}`}
                      </div>
                      <div>{note.event.texto}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          );
        })()}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>6 · Decisiones administrativas</h2>
        {sync.acciones.length === 0 ? (
          <p className="acta__note">Ninguna.</p>
        ) : (
          <ul className="acta__list">
            {sync.acciones.map((action) => (
              <Decision key={action.id} action={action} review={review} />
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>7 · Integridad</h2>
        <table className="acta__kv">
          <tbody>
            <tr>
              <th scope="row">sessionHash</th>
              <td>
                <code className="acta__hash">{sello.sessionHash}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">fileHash</th>
              <td>
                <code className="acta__hash">{sello.fileHash ?? 'todavía no se generó'}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">sourceHash</th>
              <td>
                <code className="acta__hash">{sello.sourceHash}</code>
              </td>
            </tr>
          </tbody>
        </table>
        <h3>Cabezas de cadena</h3>
        <table className="acta__grid">
          <thead>
            <tr>
              <th>contador</th>
              <th className="num">eventos</th>
              <th>headHash</th>
            </tr>
          </thead>
          <tbody>
            {sync.counters.map((counter) => (
              <tr key={counter.id}>
                <td>{counter.nombre}</td>
                <td className="num">{formatQty(counter.storedMaxSeq)}</td>
                <td>
                  <code className="acta__hash">{counter.headHash ?? '—'}</code>
                </td>
              </tr>
            ))}
            <tr>
              <td>cadena de decisiones</td>
              <td className="num">{formatQty(sync.acciones.length)}</td>
              <td>
                <code className="acta__hash">
                  {sync.acciones.length > 0
                    ? sync.acciones[sync.acciones.length - 1].hash
                    : '—'}
                </code>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="acta__note">
          Para comprobarlos: abre <code>tools/verificador.html</code> en cualquier
          navegador, sin conexión, y dale el archivo{' '}
          <code>sesion_{detail.session.id}.json</code> y el <code>.txt</code>. Recalcula
          cada cadena desde su origen y compara, y cuando algo no cuadra dice dónde: qué
          cadena, qué contador, qué <code>seq</code>, qué byte.
        </p>
        <p className="acta__note">
          Es un solo archivo, sin conexión y sin instalar nada, y{' '}
          <strong>no usa esta aplicación</strong>: si la necesitara no serviría para
          auditar, porque el momento en que alguien lo busca es justamente aquel en el que
          la aplicación puede ya no existir. Por eso <strong>viaja con el conteo</strong>:
          guárdalo junto al <code>.json</code> y al <code>.txt</code>, no en un servidor.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section acta__section--scope">
        <h2>8 · Alcance de esta certificación</h2>

        <h3>Lo que estos hashes acreditan</h3>
        <p>
          Que los eventos registrados no fueron alterados después del sello, y que el
          archivo <code>.txt</code> generado corresponde exactamente a ese conjunto de
          eventos y a ese catálogo de origen.
        </p>

        <h3>Lo que no acreditan</h3>
        <p>
          Quién registró cada evento. Esta versión identifica a los contadores por nombre
          y por enlace, sin autenticación: la cadena prueba que el registro no cambió, no
          que lo hizo determinada persona.
        </p>

        <h3>Filas no verificadas</h3>
        <p>
          El formato de Zeus exige todas las filas y no tiene forma de decir «no lo
          miramos». Las{' '}
          <strong>{formatQty(review.counts.untouched + review.counts.unchanged)}</strong>{' '}
          filas no contadas se escriben con su cantidad de Zeus, es decir,{' '}
          <strong>como si se hubieran contado y coincidido</strong>. Esta acta es el único
          documento que distingue esas filas de las contadas.
        </p>

        <h3>Modificaciones dentro de Zeus</h3>
        <p>
          Cualquier ajuste hecho en Zeus después de cargar el archivo queda fuera de esta
          certificación.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="acta__section">
        <h2>9 · Firmas</h2>
        <div className="acta__signatures">
          <div className="acta__signature">
            <div className="acta__rule" />
            <div className="acta__meta">Administrador del conteo</div>
          </div>
          <div className="acta__signature">
            <div className="acta__rule" />
            <div className="acta__meta">Jefe de costos</div>
          </div>
          {sync.counters.map((counter) => (
            <div className="acta__signature" key={counter.id}>
              <div className="acta__rule" />
              <div className="acta__meta">{counter.nombre}</div>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

/**
 * §6a, on the page: two grades of evidence, rendered apart.
 *
 * A confirmed finish is a complete, gap-free chain checked against a manifest
 * the device could not have written without the events behind it. A retirement
 * is contiguity — no hole up to the last event received — and a missing tail is
 * undetectable by construction, which is why the typed reason appears beside it.
 *
 * Not two checkmarks. ZEUS_FORMAT.md §7.1 established the discipline for the
 * Zeus evidence and it is the same one here: presenting proven and unverifiable
 * under one mark invites confidence that was not earned.
 */
function Evidence({
  counter,
  acciones,
}: {
  counter: SyncSnapshot['counters'][number];
  acciones: readonly SessionActionRecord[];
}) {
  if (counter.estado === 'terminado_confirmado') {
    return (
      <div className="acta__evidence acta__evidence--proven">
        <strong>Manifiesto verificado.</strong> El servidor tiene la cadena completa, sin
        huecos, y coincide con el manifiesto que firmó su tableta al terminar.
      </div>
    );
  }
  if (counter.estado === 'retirado') {
    const motivo = retirementReason(acciones, counter.id);
    const faltan = sealedOver(acciones, counter.id);
    return (
      <div className="acta__evidence acta__evidence--partial">
        <strong>Contigüidad verificada.</strong> No se encontró ningún hueco hasta el
        último evento recibido. No hay manifiesto, así que un tramo final que nadie ha
        oído nombrar no se puede descartar.
        {motivo ? ` Retirado: ${motivo}.` : ''}
        {faltan ? (
          <>
            {' '}
            <strong>Se selló sin los registros {faltan}.</strong>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className="acta__evidence acta__evidence--partial">
      <strong>Sin manifiesto.</strong> Estado al sellar: {counter.estado}.
    </div>
  );
}

/** One line of §6. A bulk waiver collapses; `sellar_sin_registros` never does. */
function Decision({
  action,
  review,
}: {
  action: SessionActionRecord;
  review: Review;
}) {
  const when = `${formatInstant(action.at)} · ${action.usuario}`;
  const motivo = (action.payload as { motivo?: string }).motivo ?? '';

  if (action.kind === 'waiver') {
    const payload = action.payload as WaiverPayload;
    const value = payload.idarticulo.reduce((sum, idarticulo) => {
      const row = review.rows.find((entry) => entry.item.idarticulo === idarticulo);
      return sum + (row ? row.item.existencia * row.item.costo : 0);
    }, 0);
    return (
      <li>
        <div>
          <strong>Exoneración</strong> — {formatQty(payload.idarticulo.length)} filas por{' '}
          {formatMoney(value)} COP en libros.
        </div>
        <div className="acta__meta">
          {when} · {motivo}
        </div>
        {/* Expandable rather than a wall of ids: 1 800 primary keys would make
            the acta unreadable, and hiding them entirely would make the
            decision uncheckable. */}
        <details>
          <summary>Ver los {formatQty(payload.idarticulo.length)} artículos</summary>
          <div className="acta__ids">{payload.idarticulo.join(', ')}</div>
        </details>
      </li>
    );
  }

  if (action.kind === 'sellar_sin_registros') {
    const payload = action.payload as SellarSinRegistrosPayload;
    return (
      <li className="acta__decision--grave">
        {/* Never collapsed. This line names a person and a range of their work
            that is not in the file. */}
        <div>
          <strong>Sellado sin registros</strong> — {payload.nombre}, faltan{' '}
          {payload.faltan} (el servidor tenía hasta seq {payload.storedMaxSeq}).
        </div>
        <div className="acta__meta">
          {when} · {motivo}
        </div>
        <div className="acta__meta">
          El conteo se cerró aceptando que ese tramo del trabajo de {payload.nombre} no
          está en el archivo y no va a llegar.
        </div>
      </li>
    );
  }

  return (
    <li>
      <div>
        <strong>{action.kind}</strong> — {describePayload(action)}
      </div>
      <div className="acta__meta">
        {when} · {motivo}
      </div>
    </li>
  );
}

function describePayload(action: SessionActionRecord): string {
  const payload = action.payload as unknown as Record<string, unknown>;
  if (action.kind === 'reasignar') {
    const moves = (payload.movimientos as unknown[] | undefined) ?? [];
    return `${moves.length} artículos cambiaron de manos`;
  }
  if (action.kind === 'agregar_contador' || action.kind === 'retirar_contador') {
    return String(payload.nombre ?? '');
  }
  if (action.kind === 'anular_waiver') {
    return `anula la exoneración ${String(payload.waiverId ?? '')}`;
  }
  return '';
}

/** Which articles a standing waiver actually landed on. */
function waivedArticles(review: Review): Set<number> {
  const unchanged = new Set(
    review.rows.filter((row) => row.state === 'unchanged').map((row) => row.item.idarticulo),
  );
  const waived = new Set<number>();
  for (const waiver of review.waivers) {
    for (const idarticulo of waiver.idarticulo) {
      if (unchanged.has(idarticulo)) waived.add(idarticulo);
    }
  }
  return waived;
}

function sectionsOf(detail: SessionDetail, counterId: string): AssignedSection[] {
  return detail.sections
    .filter((section) => section.counterId === counterId)
    .map((section) => ({
      id: section.id,
      nombre: section.nombre,
      items: detail.assignments
        .filter((assignment) => assignment.sectionId === section.id)
        .map((assignment) => ({ idarticulo: assignment.idarticulo })),
    }));
}

function retirementReason(
  acciones: readonly SessionActionRecord[],
  counterId: string,
): string | null {
  const action = [...acciones]
    .reverse()
    .find(
      (entry) =>
        entry.kind === 'retirar_contador' &&
        (entry.payload as { counterId?: string }).counterId === counterId,
    );
  return action ? ((action.payload as { motivo?: string }).motivo ?? null) : null;
}

function sealedOver(
  acciones: readonly SessionActionRecord[],
  counterId: string,
): string | null {
  const action = [...acciones]
    .reverse()
    .find(
      (entry) =>
        entry.kind === 'sellar_sin_registros' &&
        (entry.payload as { counterId?: string }).counterId === counterId,
    );
  return action ? (action.payload as SellarSinRegistrosPayload).faltan : null;
}
