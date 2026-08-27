/**
 * Review and posting — the screen that closes the loop.
 *
 * A different audience and a different device from the counting screen. That
 * one is a tablet held in one hand in a cold room; this is a laptop on a desk,
 * and the person in front of it wants density — every row, sortable,
 * comparable. Same type system, same two colours, same one meaning for colour.
 * A table, not cards.
 *
 * The materiality ranking *is* the screen. A supervisor opens this to find out
 * where the money went, and the answer is the top rows by |variance x costo| —
 * so the table leads and the totals sit in the footer rail, where they are
 * legible without being the first thing the eye lands on.
 *
 * Nothing here says "posting to Zeus". The app generates a file; a person
 * uploads it, exactly as they do today. Say what actually happens, or the
 * first time an upload fails somebody will believe the app did something it
 * did not.
 *
 * **This screen is the reveal** (DOMAIN.md §2.1). Every book figure in the
 * bodega is on it, because a variance review against hidden expectations is
 * not a review — and every one of them is here for the first time, since no
 * surface the count was taken from printed a single one. That is what makes
 * the variances below evidence rather than a comparison somebody was steered
 * into.
 *
 * Which is also why, **while the count is unfinished, the screen opens closed**
 * and asks. There is one tablet — no backend, one browser's IndexedDB per
 * session — so the counter and the reviewer are holding the same device, and
 * `Revisar y generar archivo` is one tap from the search box. The gate turns
 * an accidental eyeful into a decision somebody made. It is friction and not
 * security: it stops curiosity, it stops nothing that means it, and only auth
 * would (§6). Once every row is counted or waived there is nothing left to
 * protect, so it does not appear at all.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { catalogueFaults, generateAdjustment, sourceIntact } from '../../app';
import {
  compareEvents,
  nowInstant,
  summarizeSession,
  type CountEvent,
  type ExportRecord,
  type ExportRepository,
  type ItemSummary,
} from '../../domain';
import { BulkWaiver } from '../components/BulkWaiver';
import { PostConfirm, PostDone, PostRepeat } from '../components/PostPanel';
import { VarianceTable } from '../components/VarianceTable';
import { formatMoney, formatQty } from '../format';
import { loadSupervisor, saveSupervisor } from '../identity';
import { defaultFilename, formatCoverage, postFigures } from '../posting';
import type { Downloader } from '../download';
import type { CountStore } from '../store';

/** The answer to "where did the money go" is this many rows. The rest are a click away. */
const TOP = 20;

type Filter = 'todos' | 'menos' | 'mas' | 'coincide' | 'exentos';

const FILTERS: Array<[Filter, string]> = [
  ['todos', 'todos'],
  ['menos', 'en menos'],
  ['mas', 'en más'],
  ['coincide', 'coinciden'],
  ['exentos', 'exentos'],
];

function matches(row: ItemSummary, filter: Filter): boolean {
  switch (filter) {
    case 'todos':
      return row.state === 'counted';
    case 'menos':
      return row.variance?.varianceClass === 'shortage';
    case 'mas':
      return row.variance?.varianceClass === 'overage';
    case 'coincide':
      return row.state === 'counted' && row.variance!.varianceClass === 'none';
    case 'exentos':
      return row.state === 'unchanged';
  }
}

type Panel =
  | { kind: 'waiver' }
  | { kind: 'confirm' }
  | {
      kind: 'repeat';
      previous: ExportRecord;
      bytes: Uint8Array;
      sha256: string;
    }
  | { kind: 'done'; record: ExportRecord };

export function ReviewScreen({
  store,
  repo,
  download,
  onBack,
}: {
  store: CountStore;
  repo: ExportRepository;
  download: Downloader;
  onBack: () => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { session, events } = snapshot;

  const [filter, setFilter] = useState<Filter>('todos');
  const [showAll, setShowAll] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [usuario, setUsuario] = useState(loadSupervisor);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  // `null` means "still the default". The default carries the export sequence
  // number, so it has to be recomputed as that advances rather than frozen at
  // mount — otherwise the second file of a session is offered under the first
  // one's name and the browser silently resolves the collision with `(1)`.
  const [renamed, setRenamed] = useState<string | null>(null);
  // Per visit, deliberately: leaving for the counting screen unmounts this one,
  // so coming back asks again rather than staying open behind somebody's back.
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeSession(session, events), [session, events]);

  // Who last touched each row. The table prints it under the name: "where did
  // the money go" is always followed by "and who says so", and the event log
  // is the only place that answer exists (DOMAIN.md §4).
  const lastEvents = useMemo(() => {
    const map = new Map<number, CountEvent>();
    for (const event of events) {
      const current = map.get(event.idarticulo);
      if (!current || compareEvents(current, event) < 0) map.set(event.idarticulo, event);
    }
    return map;
  }, [events]);

  // Checked here rather than left to throw inside the writer: a disabled
  // button that says why beats an exception at the moment somebody presses it.
  const intact = useMemo(() => sourceIntact(session), [session]);
  // Only reachable for a session imported before the importer checked this
  // (ZEUS_FORMAT.md §4.1). `generateAdjustment` refuses it too.
  const faults = useMemo(() => catalogueFaults(session.items), [session.items]);

  useEffect(() => {
    let live = true;
    repo.exportsForSession(session.id).then(
      (rows) => {
        if (live) setExports(rows.slice().sort((a, b) => b.at.localeCompare(a.at)));
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [repo, session.id]);

  const previous = exports[0] ?? null;
  const ordinal = exports.length + 1;
  const filename = renamed ?? defaultFilename(session, ordinal);

  const write = useCallback(
    (bytes: Uint8Array, sha256: string) => {
      const record: ExportRecord = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        // The raw clock, deliberately, and the only place in the app that
        // still reads it directly.
        //
        // `CountStore.stamp` clamps event stamps to be non-decreasing per
        // device, because `compareEvents` orders the log by `at` and a
        // backwards clock correction would let an operator's correction lose
        // to the value it corrected. This is not that. An `ExportRecord` is
        // not a `CountEvent`, never reaches the fold, and orders nothing: it
        // is a record of when a file was produced, sorted only to show the
        // list newest-first and to name the previous file. Clamping it would
        // make it agree with the count log about a time neither of them knows,
        // and would quietly overstate when a file was actually generated —
        // which is the one thing this field is asked in an audit.
        at: nowInstant(),
        usuario: usuario.trim(),
        filename: filename.trim(),
        sha256,
        byteLength: bytes.length,
        counts: { ...summary.counts },
        coberturaValor: summary.cobertura.fraccionValor,
        coberturaFilas: summary.cobertura.fraccionFilas,
        netVarianceValue: summary.netVarianceValue,
        grossVarianceValue: summary.grossVarianceValue,
        eventCount: events.length,
      };
      // The bytes first: the record is a statement about a file that exists,
      // and a record written before the download is a claim about something
      // that might never have happened.
      download.save(record.filename, bytes);
      setExports((rows) => [record, ...rows]);
      setRenamed(null);
      setPanel({ kind: 'done', record });
      void repo.recordExport(record).catch((cause: unknown) => {
        setError(
          'El archivo se descargó, pero no se pudo guardar el registro de la ' +
            `descarga: ${cause instanceof Error ? cause.message : String(cause)}. ` +
            'Anota a mano cuál subiste.',
        );
      });
    },
    [download, events.length, filename, repo, session.id, summary, usuario],
  );

  function generate(): void {
    setError(null);
    // Belt as well as braces: the button is disabled without these, and this
    // is the only call site of `generateAdjustment` in the app.
    if (!summary.canPost || !intact || faults.length > 0) return;
    let built;
    try {
      built = generateAdjustment(session, events);
    } catch (cause) {
      setError(
        `No se pudo generar el archivo: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      setPanel(null);
      return;
    }
    if (previous && previous.sha256 === built.sha256) {
      setPanel({
        kind: 'repeat',
        previous,
        bytes: built.bytes,
        sha256: built.sha256,
      });
      return;
    }
    write(built.bytes, built.sha256);
  }

  function waive(idarticulos: number[], motivo: string): void {
    setError(null);
    try {
      store.waiveMany(idarticulos, { motivo, usuario });
      saveSupervisor(usuario.trim());
      setPanel(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const rows = summary.items.filter((row) => matches(row, filter));
  const figures = postFigures(summary);
  const blocked =
    faults.length > 0
      ? 'El archivo de esta sesión se contradice a sí mismo, así que sus conteos no ' +
        'se pueden atribuir a un artículo. Vuelve a importar la bodega y cuenta ' +
        'contra el archivo nuevo.'
      : summary.counts.untouched > 0
        ? `Faltan ${summary.counts.untouched} artículos por contar o exentar.`
        : !intact
          ? session.source
            ? 'El archivo guardado con esta sesión ya no coincide con el conteo. No se puede generar un ajuste contra otro corte.'
            : 'Esta sesión no guardó el archivo de Zeus del que se importó, así que no puede generar un ajuste.'
          : null;

  if (summary.counts.untouched > 0 && !revealed) {
    return (
      <div className="screen screen--desk">
        <div className="topbar">
          <button
            type="button"
            className="entry__close"
            aria-label="volver"
            onClick={onBack}
          >
            ‹
          </button>
          <div className="topbar__where">
            <div className="topbar__bodega">
              Revisión · bodega <span className="num">{session.bodega}</span>
            </div>
            <div className="topbar__corte">
              corte <span className="num">{session.fechaCorte}</span>
            </div>
          </div>
        </div>

        <div className="empty" role="status">
          <div className="empty__title">Esta pantalla muestra lo que dice Zeus</div>
          <div className="empty__body">
            Faltan <span className="num">{summary.counts.untouched}</span> artículos por
            contar. Abajo está la existencia que el sistema tiene de cada uno, y quien
            esté contando no debería verla: un conteo sirve como prueba mientras la
            persona no sepa qué se supone que va a encontrar.
          </div>
        </div>

        <div className="spacer" />

        {/*
          Going back is the filled button and revealing is the plain one, the
          same ranking the entry card gives `Guardar` over `Dejar sin
          verificar`: the safe action owns the weight, and the escape hatch is
          available without being the thing a thumb finds on its own.
        */}
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={onBack}>
            Volver a contar
          </button>
          <button type="button" className="btn" onClick={() => setRevealed(true)}>
            Ver las cifras del sistema
          </button>
        </div>
      </div>
    );
  }

  if (panel) {
    return (
      <div className="screen screen--desk">
        <div className="topbar">
          <button
            type="button"
            className="entry__close"
            aria-label="volver"
            onClick={() => setPanel(null)}
          >
            ‹
          </button>
          <div className="topbar__where">
            <div className="topbar__bodega">
              Bodega <span className="num">{session.bodega}</span>
            </div>
            <div className="topbar__corte">
              corte <span className="num">{session.fechaCorte}</span>
            </div>
          </div>
        </div>
        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}
        <div className="scroll">
          {panel.kind === 'waiver' ? (
            <BulkWaiver
              rows={summary.byExposicion}
              usuario={usuario}
              onUsuario={setUsuario}
              onWaive={waive}
              onCancel={() => setPanel(null)}
            />
          ) : panel.kind === 'confirm' ? (
            <PostConfirm
              summary={summary}
              filename={filename}
              previous={previous}
              ordinal={ordinal}
              eventCount={events.length}
              onFilename={setRenamed}
              onGenerate={generate}
              onCancel={() => setPanel(null)}
            />
          ) : panel.kind === 'repeat' ? (
            <PostRepeat
              previous={panel.previous}
              onDownload={() => write(panel.bytes, panel.sha256)}
              onClose={() => setPanel(null)}
            />
          ) : (
            <PostDone record={panel.record} onClose={() => setPanel(null)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--desk">
      <div className="topbar">
        <button
          type="button"
          className="entry__close"
          aria-label="volver"
          onClick={onBack}
        >
          ‹
        </button>
        <div className="topbar__where">
          <div className="topbar__bodega">
            Revisión · bodega <span className="num">{session.bodega}</span>
          </div>
          <div className="topbar__corte">
            corte <span className="num">{session.fechaCorte}</span> ·{' '}
            <span className="num">{summary.itemCount}</span> artículos
          </div>
        </div>
        <label className="who">
          quién revisa
          <input
            aria-label="quién revisa"
            value={usuario}
            placeholder="nombre"
            onChange={(e) => {
              setUsuario(e.target.value);
              saveSupervisor(e.target.value);
            }}
          />
        </label>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <div className="scroll">
        <div className="chips" role="group" aria-label="filtrar">
          {FILTERS.map(([key, label]) => {
            const count = summary.items.filter((row) => matches(row, key)).length;
            return (
              <button
                type="button"
                key={key}
                className={`chipbtn${filter === key ? ' chipbtn--on' : ''}`}
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(key);
                  setShowAll(false);
                }}
              >
                {label} <span className="num">{count}</span>
              </button>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Nada en este filtro</div>
            <div className="empty__body">Todavía no hay artículos en esta categoría.</div>
          </div>
        ) : (
          <>
            <VarianceTable
              rows={rows}
              lastEvents={lastEvents}
              limit={showAll ? undefined : TOP}
              caption={`Artículos por impacto en pesos — ${rows.length} en este filtro`}
            />
            {!showAll && rows.length > TOP && (
              <div className="tablefoot">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => setShowAll(true)}
                >
                  Ver las {rows.length - TOP} restantes
                </button>
              </div>
            )}
          </>
        )}

        {summary.writeOffs.length > 0 && (
          <section className="section" aria-label="bajas totales">
            <h2 className="section__title">
              Bajas totales · <span className="num">{summary.writeOffs.length}</span> ·{' '}
              <span className="num">{formatMoney(summary.writeOffValue)}</span> COP
            </h2>
            <p className="section__body">
              Contados en cero contra una existencia que el sistema sí tiene. Cada uno da
              de baja la línea completa, y son exactamente los renglones que produce un
              toque en falso. Un artículo que el sistema ya tenía en cero y se contó en
              cero no está aquí: ahí no se pierde nada.
            </p>
            <VarianceTable
              rows={summary.writeOffs}
              lastEvents={lastEvents}
              caption="Artículos contados en cero contra existencia"
            />
          </section>
        )}

        {/*
          Scope first, arithmetic second (DOMAIN.md §5). `sinVerificar` leads
          because it is the figure a signature cannot move: waiving takes a row
          out of `pendiente` and leaves it here, so this is what the count is
          worth as evidence, while `pendiente` is only what is left of the job.
        */}
        <section className="section" aria-label="sin verificar">
          <h2 className="section__title">
            Sin verificar · <span className="num">{summary.sinVerificar.items}</span> de{' '}
            <span className="num">{summary.itemCount}</span>
          </h2>
          <div className="panel__figures">
            <div>
              <div className="total__label">nadie los contó</div>
              <div className="total__value num">
                {formatMoney(summary.sinVerificar.exposicion)}
              </div>
              <div className="total__note">
                sin contar y exentos · libros{' '}
                <span className="num">{formatMoney(summary.sinVerificar.valor)}</span> ·
                firmar una exención no baja esta cifra
              </div>
            </div>
            <div>
              <div className="total__label">cobertura</div>
              <div className="total__value num">
                {formatCoverage(summary.cobertura.fraccionValor)}
              </div>
              <div className="total__note">
                del valor ·{' '}
                <span className="num">
                  {formatCoverage(summary.cobertura.fraccionFilas)}
                </span>{' '}
                de las filas ·{' '}
                <span className="num">{formatMoney(summary.cobertura.valor)}</span> de{' '}
                <span className="num">{formatMoney(summary.cobertura.valorTotal)}</span>
              </div>
            </div>
          </div>
          {summary.counts.untouched === 0 ? (
            <p className="section__body">
              No queda nada por contar: todo tiene un conteo o una exención firmada.
              {figures.waived > 0 && (
                <>
                  {' '}
                  <span className="num">{figures.waived}</span> de esas filas son
                  exenciones, y siguen contadas arriba como sin verificar — una exención
                  acepta la exposición, no la retira.
                </>
              )}
            </p>
          ) : (
            <>
              <div className="panel__figures">
                <div>
                  <div className="total__label">pendiente · en riesgo</div>
                  <div className="total__value num">
                    {formatMoney(summary.pendiente.exposicion)}
                  </div>
                  <div className="total__note">
                    <span className="num">{summary.pendiente.items}</span> filas que
                    todavía se pueden contar — max(existencia, último conteo) × costo,
                    estimación
                  </div>
                </div>
                <div>
                  <div className="total__label">pendiente · valor en libros</div>
                  <div className="total__value num">
                    {formatMoney(summary.pendiente.valor)}
                  </div>
                  <div className="total__note">
                    existencia × costo — la cifra contable
                  </div>
                </div>
              </div>
              {(() => {
                const invisible = summary.byExposicion.filter(
                  (row) => row.valor === 0 && row.exposicion > 0,
                );
                if (invisible.length === 0) return null;
                return (
                  <p className="section__body">
                    <span className="num">{invisible.length}</span> de estos valen{' '}
                    <span className="num">0</span> en libros y{' '}
                    <span className="num">
                      {formatMoney(
                        invisible.reduce((total, row) => total + row.exposicion, 0),
                      )}
                    </span>{' '}
                    COP por su último conteo — el sistema los deja en cero entre compras:{' '}
                    {invisible
                      .slice(0, 6)
                      .map((row) => row.item.nombre)
                      .join(', ')}
                    {invisible.length > 6 ? '…' : ''}
                  </p>
                );
              })()}
              <ul className="rows">
                {summary.byExposicion.slice(0, 10).map((row) => (
                  <li key={row.item.idarticulo} className="row row--static">
                    <span className="row__main">
                      <span className="row__nombre">{row.item.nombre}</span>
                      <span className="row__meta">
                        <span className="num">{row.item.codigo}</span> ·{' '}
                        {row.item.presentacion} · sistema{' '}
                        <span className="num">{formatQty(row.item.existencia)}</span>
                      </span>
                    </span>
                    <span className="row__right">
                      <span className="row__existencia num">
                        {formatMoney(row.exposicion)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="tablefoot">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => setPanel({ kind: 'waiver' })}
                >
                  Exentar artículos sin contar
                </button>
              </div>
            </>
          )}
        </section>

        {exports.length > 0 && (
          <section className="section" aria-label="archivos generados">
            <h2 className="section__title">
              Archivos generados · <span className="num">{exports.length}</span>
            </h2>
            <ul className="rows">
              {exports.map((record) => (
                <li key={record.id} className="row row--static">
                  <span className="row__main">
                    <span className="row__nombre num">{record.filename}</span>
                    <span className="row__meta">
                      {record.usuario || 'sin nombre'} ·{' '}
                      <span className="num">{record.at.slice(0, 10)}</span> ·{' '}
                      <span className="num">{record.counts.counted}</span> contados,{' '}
                      <span className="num">{record.counts.unchanged}</span> exentos
                    </span>
                  </span>
                  <span className="row__right">
                    <span className="chip num">{record.sha256.slice(0, 12)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="reviewbar">
        <div className="reviewbar__figures">
          <div className="reviewbar__figure">
            <span className="total__label">estados</span>
            <span className="reviewbar__value">
              <span className="num">{summary.counts.counted}</span> contados ·{' '}
              <span className="num">{summary.counts.unchanged}</span> exentos ·{' '}
              <span className="num">{summary.counts.untouched}</span> sin contar
            </span>
          </div>
          <div className="reviewbar__figure">
            <span className="total__label">diferencia neta</span>
            <span
              className={`reviewbar__value num${
                summary.netVarianceValue < 0
                  ? ' figure--short'
                  : summary.netVarianceValue > 0
                    ? ' figure--over'
                    : ''
              }`}
            >
              {formatMoney(summary.netVarianceValue)}
            </span>
          </div>
          <div className="reviewbar__figure">
            <span className="total__label">diferencia bruta</span>
            <span className="reviewbar__value num">
              {formatMoney(summary.grossVarianceValue)}
            </span>
          </div>
          <div className="reviewbar__figure">
            <span className="total__label">cobertura</span>
            <span className="reviewbar__value num">
              {formatCoverage(summary.cobertura.fraccionValor)}{' '}
              <span className="reviewbar__aside">
                valor · {formatCoverage(summary.cobertura.fraccionFilas)} filas
              </span>
            </span>
          </div>
          <div className="reviewbar__figure">
            <span className="total__label">se moverán</span>
            <span className="reviewbar__value">
              <span className="num">{figures.changed}</span> de{' '}
              <span className="num">{summary.itemCount}</span>
            </span>
          </div>
        </div>
        <div className="reviewbar__action">
          {blocked && <p className="hint">{blocked}</p>}
          <button
            type="button"
            className="btn btn--primary"
            disabled={blocked !== null}
            onClick={() => setPanel({ kind: 'confirm' })}
          >
            Generar archivo
          </button>
        </div>
      </div>
    </div>
  );
}
