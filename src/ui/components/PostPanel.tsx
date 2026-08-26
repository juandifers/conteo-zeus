/**
 * The last screen before an irreversible ERP posting, and what comes after it.
 *
 * Everything before this task was recoverable inside the app: a count can be
 * retracted, a waiver withdrawn, a session abandoned. This produces a file that
 * changes balances in the hotel's ERP, and once somebody uploads it the app has
 * no say in anything.
 *
 * So the confirmation states the actual numbers rather than a summary of the
 * summary, and it never says "posting to Zeus": the app generates a file and a
 * person uploads it. If the copy pretends otherwise, the first time an upload
 * fails somebody will believe the app already did it.
 */
import type { ExportRecord, SessionSummary } from '../../domain';
import { formatInstant, formatMoney, formatQty } from '../format';
import { describeChanges, formatCoverage, postFigures } from '../posting';

/** How many write-offs are listed by name before the list is summarised. */
const NAMED_WRITE_OFFS = 12;

export function PostConfirm({
  summary,
  filename,
  previous,
  ordinal,
  eventCount,
  onFilename,
  onGenerate,
  onCancel,
}: {
  summary: SessionSummary;
  filename: string;
  /** The most recent file generated for this session, if there is one. */
  previous: ExportRecord | null;
  /** Which file of this session this one would be. `1` for the first. */
  ordinal: number;
  eventCount: number;
  onFilename: (name: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}) {
  const figures = postFigures(summary);
  const writeOffs = summary.writeOffs;
  const changes = previous ? describeChanges(previous, summary, eventCount) : [];

  return (
    <section className="panel" aria-label="generar el archivo para Zeus">
      <h2 className="panel__title">Generar el archivo para Zeus</h2>

      {previous && (
        <p className="panel__body">
          Sería el archivo n.º <span className="num">{ordinal}</span> de esta sesión. Desde
          el anterior, del <span className="num">{formatInstant(previous.at)}</span>:{' '}
          {changes.length > 0 ? changes.join(', ') : 'no cambió nada'}.
        </p>
      )}

      <p className="panel__body">
        <span className="num">{summary.itemCount}</span> artículos.{' '}
        <span className="num">{figures.changed}</span> salen con una cantidad distinta a
        la del sistema y <span className="num">{figures.matched + figures.waived}</span>{' '}
        salen sin cambio (<span className="num">{figures.matched}</span> contados iguales,{' '}
        <span className="num">{figures.waived}</span> exentos).
      </p>

      {figures.waived > 0 && (
        <p className="panel__body">
          Los <span className="num">{figures.waived}</span> exentos salen con la existencia
          que el sistema ya tiene. Van firmados: quedan en el registro con un nombre, una
          hora y un motivo.
        </p>
      )}

      <div className="panel__figures">
        {/*
          `sinVerificar` leads (DOMAIN.md §5). It is the only figure here that a
          waiver cannot move: signing one takes a row out of `pendiente` and
          leaves it in this scope, which is the difference between accepting an
          exposure and retiring it.
        */}
        <div>
          <div className="total__label">sin verificar</div>
          <div className="total__value num">{formatMoney(summary.sinVerificar.exposicion)}</div>
          <div className="total__note">
            <span className="num">{summary.sinVerificar.items}</span> filas que nadie contó ·
            libros <span className="num">{formatMoney(summary.sinVerificar.valor)}</span>
          </div>
        </div>
        <div>
          <div className="total__label">cobertura</div>
          <div className="total__value num">
            {formatCoverage(summary.cobertura.fraccionValor)}
          </div>
          <div className="total__note">
            del valor · <span className="num">
              {formatCoverage(summary.cobertura.fraccionFilas)}
            </span>{' '}
            de las filas
          </div>
        </div>
        <div>
          <div className="total__label">diferencia neta</div>
          <div
            className={`total__value num${
              summary.netVarianceValue < 0
                ? ' figure--short'
                : summary.netVarianceValue > 0
                  ? ' figure--over'
                  : ''
            }`}
          >
            {formatMoney(summary.netVarianceValue)}
          </div>
          <div className="total__note">lo que cuesta el conteo</div>
        </div>
        <div>
          <div className="total__label">diferencia bruta</div>
          <div className="total__value num">{formatMoney(summary.grossVarianceValue)}</div>
          <div className="total__note">cuánto se movió, sin compensar</div>
        </div>
      </div>

      {writeOffs.length > 0 && (
        <div className="panel__section">
          <h3 className="panel__subtitle">
            <span className="num">{writeOffs.length}</span> bajas totales ·{' '}
            <span className="num">{formatMoney(summary.writeOffValue)}</span> COP
          </h3>
          <p className="panel__body">
            Contados en cero contra una existencia que el sistema sí tiene. Cada uno da
            de baja la línea completa, y son los renglones que produce un toque en falso.
          </p>
          <ul className="rows">
            {writeOffs.slice(0, NAMED_WRITE_OFFS).map((row) => (
              <li key={row.item.idarticulo} className="row row--static">
                <span className="row__main">
                  <span className="row__nombre">{row.item.nombre}</span>
                  <span className="row__meta">
                    <span className="num">{row.item.codigo}</span> · {row.item.presentacion}
                  </span>
                </span>
                <span className="row__right">
                  <span className="row__existencia num figure--short">
                    {formatMoney(row.variance!.valorVariance)}
                  </span>
                  <span className="chip">
                    sistema <span className="num">{formatQty(row.item.existencia)}</span> →
                    contado <span className="num">0</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {writeOffs.length > NAMED_WRITE_OFFS && (
            <p className="hint">
              y <span className="num">{writeOffs.length - NAMED_WRITE_OFFS}</span> más, todas
              en la tabla de arriba.
            </p>
          )}
        </div>
      )}

      <label className="field">
        <span className="field__label">Nombre del archivo</span>
        <input
          value={filename}
          onChange={(e) => onFilename(e.target.value)}
          aria-label="nombre del archivo"
        />
      </label>

      <div className="confirm">
        <p className="confirm__text">
          El archivo se descarga a este computador. Subirlo a Zeus lo hace una persona,
          igual que hoy.
        </p>
        <div className="actions__pair">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={filename.trim().length === 0}
            onClick={onGenerate}
          >
            Generar archivo
          </button>
        </div>
      </div>
    </section>
  );
}

/** After the bytes exist. Same verb as the button that produced them. */
export function PostDone({
  record,
  onClose,
}: {
  record: ExportRecord;
  onClose: () => void;
}) {
  return (
    <section className="panel" aria-label="archivo generado">
      <h2 className="panel__title">Archivo generado</h2>
      <p className="panel__body">
        <span className="num">{record.filename}</span> ·{' '}
        <span className="num">{record.byteLength}</span> bytes · generado por{' '}
        {record.usuario || 'sin nombre'} el <span className="num">{formatInstant(record.at)}</span>.
      </p>
      <p className="panel__body">
        Cubre <span className="num">{formatCoverage(record.coberturaValor)}</span> del valor
        de la bodega y <span className="num">{formatCoverage(record.coberturaFilas)}</span> de
        las filas. Queda anotado con el archivo.
      </p>
      <p className="panel__body">
        Búscalo en las descargas y súbelo a Zeus como lo haces hoy. Esta aplicación no
        sube nada.
      </p>
      <p className="hint">
        huella del archivo <span className="num">{record.sha256.slice(0, 16)}</span>
      </p>
      <div className="actions">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Listo
        </button>
      </div>
    </section>
  );
}

/**
 * The same file, again.
 *
 * People export, count some more, and export again — and sometimes they export
 * twice having done nothing in between, because the first download went to a
 * folder they cannot find. Producing a second identical file silently is how
 * two copies of one adjustment end up in circulation with nothing to tell them
 * apart, so this says it is the same file and still lets them have it.
 */
export function PostRepeat({
  previous,
  onDownload,
  onClose,
}: {
  previous: ExportRecord;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <section className="panel" aria-label="archivo idéntico">
      <h2 className="panel__title">Este archivo ya lo generaste</h2>
      <p className="panel__body">
        Sale byte por byte igual al que generó {previous.usuario || 'alguien'} el{' '}
        <span className="num">{formatInstant(previous.at)}</span> como{' '}
        <span className="num">{previous.filename}</span>. Desde entonces no se registró
        ningún conteo, así que no hay nada nuevo que subir a Zeus.
      </p>
      <div className="actions__pair">
        <button type="button" className="btn" onClick={onClose}>
          Cerrar
        </button>
        <button type="button" className="btn btn--primary" onClick={onDownload}>
          Descargar otra vez
        </button>
      </div>
    </section>
  );
}
