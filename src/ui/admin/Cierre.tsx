/**
 * Sellar, generar, descargar — P2.5 §1, §2, §4a, §5.
 *
 * ## The ordering is the design
 *
 *     revisión ──sellar──▶ sellado ──generar──▶ cerrado
 *
 * The screen is built around that arrow and offers nothing that would let
 * somebody skip it. «Download the file, then close the session» is the instinct
 * and it cannot be defended: if a tablet can still drain between generating and
 * closing, the `.txt` in the accountant's downloads folder corresponds to no
 * recorded state — and the acta that goes with it would be describing a count
 * that no longer exists.
 *
 * ## Three artifacts, and they are not the same kind of thing
 *
 *     AJUSTE_<bodega>_<fecha>_<hash>.txt   Zeus. Mueve saldos. Es una transacción.
 *     acta_<sesión>.pdf                    el archivo. Dice qué pasó de verdad.
 *     sesion_<sesión>.json                 auditoría. Permite recomputar los hashes.
 *
 * The `.txt` is served from storage, never regenerated: the server hashed
 * particular bytes and those are the bytes it hands over. A second run of the
 * writer would be «a file that ought to be identical», which is precisely the
 * claim `fileHash` exists to replace with a fact.
 *
 * ## There is no button that forces a seal
 *
 * The blocking list is shown here, again, because this is where the button is.
 * The only way past a blocking reason is `sellar_sin_registros` — an action on
 * the chain with a person's name and a typed reason on it, printed on the acta
 * and never collapsed. The value of the gate is that it cannot be satisfied by
 * assertion, so nothing on this screen lets an admin assert their way past it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  codigoSello,
  reviewSession,
  type CountEvent,
  type CounterEstado,
  type Review,
} from '../../domain';
import verificadorHtml from '../../../tools/verificador.html?raw';
import { ApiError, type Api } from '../api';
import { browserDownload, type Downloader } from '../download';
import { fromBase64 } from '../../lib/base64';
import { formatInstant, formatMoney, formatQty } from '../format';
import { loadSupervisor, saveSupervisor } from '../identity';
import { Acta } from './Acta';
import { describeSeal } from './blockers';
import { EventFeed } from './feed';
import type {
  BundleFile,
  ExportFile,
  ExportResult,
  SealResult,
  SessionDetail,
  SyncSnapshot,
} from './types';

interface Loaded {
  sync: SyncSnapshot;
  review: Review;
  /** The log as it stood when this loaded. Captured here, never read off the ref
      during render — the acta and the review have to describe the same moment. */
  events: CountEvent[];
  at: string;
}

export function Cierre({
  detail,
  api,
  onReload,
  download = browserDownload(),
  now = () => new Date().toISOString(),
}: {
  detail: SessionDetail;
  api: Api;
  onReload: () => void;
  /** Injected so a test can catch the bytes instead of driving a download. */
  download?: Downloader;
  now?: () => string;
}) {
  const feed = useRef<EventFeed>(new EventFeed());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** The .txt download's own ask — it posts balances to Zeus once uploaded. */
  const [descargando, setDescargando] = useState(false);
  const [usuario, setUsuario] = useState(loadSupervisor);
  const [motivo, setMotivo] = useState('');
  const [sinRegistros, setSinRegistros] = useState('');
  const [exported, setExported] = useState<ExportResult | null>(null);

  const sessionId = detail.session.id;

  const load = useCallback(async () => {
    const sync = await api.get<SyncSnapshot>(`/api/sessions/${sessionId}/sync`);
    await feed.current.pull(api, sessionId);
    setLoaded({
      sync,
      events: feed.current.events,
      review: reviewSession({
        sessionId,
        items: detail.items,
        events: feed.current.events,
        actions: sync.acciones,
        counters: sync.counters.map((counter) => ({
          id: counter.id,
          nombre: counter.nombre,
          estado: counter.estado as CounterEstado,
        })),
      }),
      at: now(),
    });
  }, [api, detail.items, now, sessionId]);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setProblem(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [load]);

  const fail = (cause: unknown) =>
    setProblem(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  const seal = () =>
    run(async () => {
      const body =
        sinRegistros === ''
          ? {}
          : { sinRegistros: { counterId: sinRegistros, usuario, motivo } };
      await api.post<SealResult>(`/api/sessions/${sessionId}/sellar`, body);
      if (usuario.trim() !== '') saveSupervisor(usuario);
      setConfirming(false);
      await load();
      onReload();
    });

  const generate = () =>
    run(async () => {
      const result = await api.post<ExportResult>(`/api/sessions/${sessionId}/exportar`);
      setExported(result);
      await load();
      onReload();
    });

  const downloadTxt = () =>
    run(async () => {
      const file = await api.get<ExportFile>(`/api/sessions/${sessionId}/exportar`);
      // The `Blob` is built from bytes, never from a string: the file is CP850
      // (ZEUS_FORMAT.md §3) and a string would put every `Ñ` through the
      // platform's UTF-8 encoder on the way to the disk.
      download.save(file.filename, fromBase64(file.base64));
    });

  const downloadBundle = () =>
    run(async () => {
      const file = await api.get<BundleFile>(`/api/sessions/${sessionId}/bundle`);
      // Saved verbatim, not re-serialised: `canonicalJson` sorted the keys and
      // refused the floats, and a `JSON.stringify` on the way out would undo
      // both. Two downloads of one sealed session are byte-identical.
      download.save(file.filename, new TextEncoder().encode(file.canonical));
    });

  // The acta's «cómo comprobarlo» tells the operator to open verificador.html,
  // so the screen that prints the acta has to be able to hand it over — the
  // file lives in the repository, not on any server the operator can reach.
  // Bundled into this build verbatim; it stays a single self-contained page.
  const downloadVerificador = () =>
    download.save('verificador.html', new TextEncoder().encode(verificadorHtml));

  if (!loaded) {
    return (
      <div className="panel">
        <div className="panel__body">
          {problem ? (
            <div className="banner" role="alert">
              {problem}
            </div>
          ) : (
            <div className="hint">Leyendo el conteo…</div>
          )}
        </div>
      </div>
    );
  }

  const { sync, review } = loaded;
  const estado = sync.session.estado;
  const sello = sync.sello;
  const blockers = sync.session.readyToSeal;
  const retirados = sync.counters.filter((counter) => counter.estado === 'retirado');
  const overrideReady = sinRegistros === '' || (usuario.trim() !== '' && motivo.trim() !== '');

  return (
    <>
      {problem && (
        <div className="banner" role="alert">
          {problem}
        </div>
      )}

      {(estado === 'abierto' || estado === 'revision') && (
        <div className="panel" id="sellar">
          <div className="panel__title">Sellar el conteo</div>
          <div className="panel__body">
            {/*
              §4.3: a checklist, not an essay. Every line is a condition and
              its status; what sealing does mechanically is said once, inside
              the confirmation, to the one person about to do the irreversible
              thing. The Bloquea / no-bloquea split survives as ✕ against ⚠.
            */}
            <ul className="gates">
              {blockers.map((blocker, index) => (
                <li className="gate gate--stop" key={`${blocker.kind}-${index}`}>
                  <span className="gate__mark" aria-hidden="true">
                    ✕
                  </span>
                  <span>{describeSeal(blocker)}</span>
                </li>
              ))}
              {blockers.length === 0 && (
                <li className="gate gate--ok">
                  <span className="gate__mark" aria-hidden="true">
                    ✓
                  </span>
                  <span>El trabajo de todos está completo en el servidor.</span>
                </li>
              )}
              {review.pendiente.items > 0 ? (
                <li className="gate gate--warn">
                  <span className="gate__mark" aria-hidden="true">
                    ⚠
                  </span>
                  <span>
                    {`${formatQty(review.pendiente.items)} filas sin contar · ` +
                      `${formatMoney(review.pendiente.exposicion)} COP. No bloquea: se exonera ` +
                      'en Revisión o se sella así, y el acta lo dice.'}
                  </span>
                </li>
              ) : (
                <li className="gate gate--ok">
                  <span className="gate__mark" aria-hidden="true">
                    ✓
                  </span>
                  <span>Todas las filas del catálogo tienen registro o exoneración.</span>
                </li>
              )}
            </ul>

            {/* §1a — the one way past a blocking reason, and it is a signature
                rather than a flag. Offered only when a retired counter exists:
                if somebody might still come back, the answer is to wait for
                the tablet — and an empty case is not explained, it is absent. */}
            {retirados.length > 0 && (
              <>
                <div className="panel__subtitle">Sellar sin los registros de alguien</div>
                <label className="field__label" htmlFor="sellar-sin">
                  Contador cuyo tramo falta
                </label>
                <select
                  id="sellar-sin"
                  className="field"
                  value={sinRegistros}
                  onChange={(event) => setSinRegistros(event.target.value)}
                >
                  <option value="">ninguno</option>
                  {retirados.map((counter) => (
                    <option key={counter.id} value={counter.id}>
                      {counter.nombre}
                    </option>
                  ))}
                </select>
                {sinRegistros !== '' && (
                  <div className="banner" role="alert">
                    Vas a cerrar el conteo aceptando que parte del trabajo de esa persona
                    no está en el archivo y no va a llegar. Queda firmado con tu nombre
                    y sale en el acta <strong>sin resumir</strong>.
                  </div>
                )}
              </>
            )}

            {confirming && (
              <div className="confirm">
                <div className="confirm__text">
                  {`Vas a sellar ${formatQty(review.rows.length)} filas: ` +
                    `${formatQty(review.counts.counted)} contadas, ` +
                    `${formatQty(review.counts.unchanged)} exoneradas, ` +
                    `${formatQty(review.counts.untouched)} sin tocar.`}
                </div>
                <div>
                  <strong>
                    Sin verificar: {formatMoney(review.sinVerificar.exposicion)} COP.
                  </strong>{' '}
                  Esas filas se van a escribir con la cantidad de Zeus, como si se
                  hubieran contado y coincidido. Después del sello no se puede añadir
                  nada, ni desde una tableta ni desde aquí: ninguna tableta puede
                  volver a escribir y ninguna decisión se puede firmar después. El
                  archivo se genera <strong>después</strong> del sello, y por eso
                  corresponde a un estado que quedó registrado.
                </div>
                <label className="field__label" htmlFor="sellar-usuario">
                  Quién firma
                </label>
                <input
                  id="sellar-usuario"
                  className="field"
                  value={usuario}
                  onChange={(event) => setUsuario(event.target.value)}
                  placeholder="tu nombre"
                />
                <label className="field__label" htmlFor="sellar-motivo">
                  Motivo
                </label>
                <input
                  id="sellar-motivo"
                  className="field"
                  value={motivo}
                  onChange={(event) => setMotivo(event.target.value)}
                  placeholder={
                    sinRegistros === ''
                      ? 'p. ej. corte del 30 de agosto completo'
                      : 'por qué se puede cerrar sin ese tramo'
                  }
                />
                <div className="actions__pair">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || blockers.length > 0 || !overrideReady}
                    onClick={seal}
                  >
                    Sí, sellar
                  </button>
                </div>
              </div>
            )}
          </div>
          {!confirming && (
            <div className="actions">
              {/* Opening the confirmation never requires the signature — the
                  fields live inside it. Only «Sí, sellar» gates on them. */}
              <button
                type="button"
                className="btn"
                disabled={busy || blockers.length > 0}
                onClick={() => setConfirming(true)}
              >
                Sellar
              </button>
              {blockers.length > 0 && (
                <div className="hint">
                  {blockers.length === 1
                    ? 'Desactivado hasta resolver 1 bloqueo.'
                    : `Desactivado hasta resolver ${blockers.length} bloqueos.`}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {sello && (
        <div className="panel" id="sello">
          {/*
            §4.4: the admin is producing an official document, so this reads
            as a receipt. The hash is a credential, not debug output — short
            form on the line, the full chain behind one disclosure.
          */}
          <div className="panel__title">
            {`${estado === 'cerrado' ? 'Conteo cerrado' : 'Conteo sellado'} · ${formatInstant(sello.sealedAt)}`}
          </div>
          <div className="panel__body">
            <div className="hint">
              {`${formatQty(detail.session.itemCount)} artículos · ` +
                (sync.counters.length === 1
                  ? '1 contador'
                  : `${sync.counters.length} contadores`) +
                (review.exoneradas > 0 ? ` · ${formatQty(review.exoneradas)} exoneradas` : '') +
                (sello.exportedAt ? ` · archivo generado ${formatInstant(sello.exportedAt)}` : '')}
            </div>

            <details className="sello">
              <summary className="sello__line">
                {'Código de verificación '}
                <code className="acta__hash">{codigoSello(sello.sessionHash)}</code>
                <span className="hint"> Ver ⌄</span>
              </summary>
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
                      <code className="acta__hash">
                        {sello.fileHash ?? 'todavía no se generó el archivo'}
                      </code>
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
            </details>

            {exported && (
              <div className="hint">
                {`${formatQty(exported.filas)} filas escritas · ` +
                  `${formatQty(exported.contados)} contadas · ` +
                  `${formatQty(exported.exonerados)} exoneradas · ` +
                  `${formatQty(exported.sinTocar)} con la cantidad de Zeus.`}
              </div>
            )}

            {descargando && (
              // Irreversible in effect: once uploaded, this file moves
              // balances in Zeus. The confirmation also says what re-download
              // means, which used to be a standing paragraph.
              <div className="confirm">
                <div className="confirm__text">
                  Este archivo escribe los saldos del conteo en Zeus al subirlo.
                </div>
                <div className="hint">
                  Volver a descargar entrega <strong>los mismos bytes</strong>: el archivo
                  se guardó al generarlo y nunca se vuelve a construir, y por eso el sello
                  dice cuál de los archivos de la carpeta se subió.
                </div>
                <div className="actions__pair">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => setDescargando(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => {
                      setDescargando(false);
                      void downloadTxt();
                    }}
                  >
                    Sí, descargar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="actions">
            {estado === 'sellado' && (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={generate}>
                Generar el archivo para Zeus
              </button>
            )}
            {estado === 'cerrado' && !descargando && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => setDescargando(true)}
              >
                Descargar archivo para Zeus
              </button>
            )}
            <button type="button" className="btn btn--small" disabled={busy} onClick={downloadBundle}>
              Descargar el paquete de auditoría
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={downloadVerificador}
            >
              Descargar el verificador
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => globalThis.print?.()}
            >
              Imprimir acta de conteo
            </button>
          </div>

          {/* §5. Should always be empty; rendered because «no puede pasar» is not
              something a screen about integrity gets to say. */}
          {sello.tardios.length > 0 && (
            <div className="panel__body">
              <div className="panel__subtitle">Registros que llegaron después del sello</div>
              <div className="banner" role="alert">
                {`${formatQty(sello.tardios.length)} eventos entraron después de sellar. ` +
                  'No están dentro de sessionHash y no están en el archivo. Son trabajo ' +
                  'real de alguien: avisa a sistemas antes de conciliar nada.'}
              </div>
              <ul className="rows">
                {sello.tardios.map((event) => (
                  <li className="row row--static" key={event.id}>
                    <div className="row__main">
                      <div className="row__meta">
                        {`${nameOf(sync, event.counterId)} · seq ${event.seq} · ${formatInstant(event.serverAt)}`}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {estado === 'cerrado' && (
        <div className="panel">
          <div className="panel__title">Si aparece una tableta ahora</div>
          <div className="panel__body">
            <div className="hint">
              Su enlace responde que la sesión está sellada y{' '}
              <strong>no borra nada</strong>: los registros siguen en la tableta y se
              pueden exportar desde ahí. Ese trabajo existió y no entró al archivo, y eso
              no es culpa de quien contó. Si hace falta corregirlo, es un conteo nuevo con
              su propia acta y las dos se concilian en papel.
            </div>
          </div>
        </div>
      )}

      {sello && (
        <Acta
          detail={detail}
          review={review}
          sync={sync}
          sello={sello}
          events={loaded.events}
          filename={exported?.filename ?? null}
          generadaAt={loaded.at}
        />
      )}
    </>
  );
}

function nameOf(sync: SyncSnapshot, counterId: string): string {
  return sync.counters.find((counter) => counter.id === counterId)?.nombre ?? counterId;
}
