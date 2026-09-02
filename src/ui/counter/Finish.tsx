/**
 * «Terminar»: the gap review, the confirmation, and the banner behind them.
 *
 * Two rules meet on this screen.
 *
 * **Finishing must degrade, never hang.** There is no connectivity in the
 * bodega. A blocking spinner is a force-close, and a force-close is the one
 * thing that loses data — so the button always returns, and whatever did not
 * upload becomes a persistent banner with a retry beside it (`SyncBar`).
 *
 *     [ TERMINAR ]
 *          │
 *          ├─ intenta drenar la bandeja (tope ~8s, con reintentos)
 *          │
 *          ├─ ack ──────────▶  ✓ TERMINADO Y CONFIRMADO
 *          │
 *          └─ sin respuesta ▶  ⏳ TERMINADO — 147 registros sin subir
 *                               banner persistente, reintento automático
 *                               «Acércate a la zona con señal antes de irte»
 *                               [ Reintentar ahora ]
 *
 * The `finish` event is appended **before** the attempt, not after it. Finishing
 * is something the counter did; whether the network cooperated is a separate
 * fact, and conflating them is how somebody ends up pressing a button twice to
 * have finished once.
 *
 * **The gap review reads differently under the two dispatch modes.** In a
 * sectioned session it is the articles *in this counter's own sections* with
 * nothing standing against them — shelves this person physically walked past.
 * In a shared session (P2.6) everybody holds the whole catalogue, so «faltan
 * 240» is not a debt this person owes: the list becomes «what nobody had
 * registered when this tablet last fetched, and you have not touched», the
 * screen says so, and finishing over it is the ordinary case rather than the
 * excused one. And because the sectioning happened physically in the bodega,
 * the list itself stays behind a «Ver lista completa» button: what a counter
 * reviews to terminar is their own work, and two hundred rows of other
 * people's shelves would only bury it.
 *
 * There is deliberately **no «sin novedad»** here. The only resolutions are
 * counting it or declaring the location empty; waiving an uncounted row means
 * vouching for a book figure, and the book figure is not on this device (§2.1).
 * That decision belongs to the admin at review, with one name on it.
 *
 * Finishing with gaps is allowed. The gap is a fact the admin needs, and a
 * screen that blocked it would only teach people to type something.
 *
 * **After a handover the gap list is scoped twice** (P2.3.5 §6b): to this
 * counter's sections, and then minus the articles somebody else had already
 * registered when the tablet fetched. Pedro inheriting 120 of Luis's articles,
 * sixty of them already counted, must not be sent to recount those sixty.
 */
import { useState, useSyncExternalStore } from 'react';

import { ownSummary, sectionProgress, type CountEvent } from '../../domain';
import type { CountStore } from '../store';
import type { CounterCatalogue } from './assignment';
import type { CounterSync } from './sync';

export function FinishPanel({
  store,
  sync,
  catalogue,
  events,
  onCount,
}: {
  store: CountStore;
  sync: CounterSync;
  catalogue: CounterCatalogue;
  events: readonly CountEvent[];
  /** Jump to the entry screen for one gap row. */
  onCount: (idarticulo: number) => void;
}) {
  /** The gap row whose «está vacío» is waiting for its second tap. */
  const [emptying, setEmptying] = useState<number | null>(null);
  /** Shared sessions only: whether the whole-catalogue gap list is open. */
  const [listaCompleta, setListaCompleta] = useState(false);
  const { estado, serverEstado } = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  // The gap list is «my articles with nothing standing **from me**» (P2.3 §5a),
  // minus whatever somebody else had already registered when this device
  // fetched (P2.3.5 §6b). Without that subtraction a counter who inherited
  // Luis's 120 articles would be shown all 120 and sent to recount sixty of
  // them, which is the double count of §4b arriving by a second route.
  const progress = sectionProgress(catalogue.sections, events, store.counterId, catalogue.heredados);
  const summary = ownSummary(catalogue.sections, events, store.counterId, catalogue.heredados);

  const terminar = () => {
    // Local first, and unconditionally. The manifest is taken from the store's
    // own running chain, so the claim is one the server can check rather than
    // one it has to believe.
    store.finish();
    sync.setDeviceEstado('terminado_local');
    // `settled()` before the count is read, so «147 registros sin subir» is the
    // number that is actually on disk. The store's write is optimistic — the
    // screen moves first and IndexedDB catches up — and a banner that read the
    // outbox in between would report one event fewer than the counter just
    // caused. Not awaited by the click: the button returns immediately, which
    // is the whole rule this panel exists to obey.
    void store.settled().then(() => sync.refresh()).then(() => sync.drainWithin());
  };

  const reabrir = () => {
    // `seq` carries on unbroken: a new chain would defeat the manifest, and
    // every event after the first `finish` is flagged as an amendment for the
    // admin — derived from the log rather than stored, so it cannot drift out
    // of agreement with the events it describes.
    store.reopen();
    sync.setDeviceEstado('contando');
    void store.settled().then(() => sync.refresh()).then(() => sync.drain());
  };

  const confirmed = estado === 'terminado_confirmado';
  const claimed = estado === 'terminado_local';

  if (claimed || confirmed) {
    return (
      <div className="panel">
        <div className="panel__title">{confirmed ? '✓ Terminado y confirmado' : '⏳ Terminado'}</div>
        <div className="panel__body">
          <div className="hint">
            {confirmed
              ? 'El servidor tiene todo lo que contaste.'
              : 'Tu conteo está guardado en la tableta. Se confirma solo en cuanto haya red.'}
          </div>
          {serverEstado === 'terminado_incompleto' && (
            <div className="banner" role="status">
              El servidor recibió tu «terminar» pero todavía le faltan registros. No apagues la
              tableta: se están reintentando.
            </div>
          )}
          <div className="hint">
            {`Si encuentras algo más, reabre: todo lo que registres después queda marcado como ` +
              'una corrección posterior para el administrador.'}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={reabrir}>
            Reabrir
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <div className="panel__title">Tu trabajo</div>
        <div className="panel__body">
          <ul className="checklist">
            <li className="checkrow">
              <span>artículos registrados</span>
              <span className="num">{summary.registrados}</span>
            </li>
            {summary.heredados > 0 && (
              // Named rather than folded into «registrados», because «I
              // registered 38» and «38 are registered, 12 of them by somebody
              // else» are not the same sentence about the same afternoon.
              <li className="checkrow">
                <span>ya registrados por otra persona</span>
                <span className="num">{summary.heredados}</span>
              </li>
            )}
            <li className="checkrow">
              <span>
                {catalogue.compartido
                  ? 'sin registrar por nadie (a la última descarga)'
                  : 'sin registrar'}
              </span>
              <span className="num">{summary.sinRegistrar}</span>
            </li>
            <li className="checkrow">
              <span>lugares vacíos (cero)</span>
              <span className="num">{summary.ceros}</span>
            </li>
            <li className="checkrow">
              <span>notas</span>
              <span className="num">{summary.notas}</span>
            </li>
          </ul>
        </div>
      </div>

      {/*
        In a shared session the gap list is the whole bodega, and the parts of
        it this counter was responsible for were decided out on the floor where
        the app cannot see them. So terminar shows their own work, and the
        catalogue waits behind one tap for whoever actually wants to sweep it —
        usually the last person standing.
      */}
      {catalogue.compartido && !listaCompleta ? (
        <div className="panel">
          <div className="panel__title">Lista completa</div>
          <div className="panel__body">
            <div className="hint">
              Las zonas se repartieron en la bodega, no aquí: para terminar no te toca revisar
              todo el catálogo. Si quieres ver qué no ha registrado nadie, abre la lista.
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setListaCompleta(true)}>
              Ver lista completa
            </button>
          </div>
        </div>
      ) : (
      progress.map((section) => (
        <div className="panel" key={section.id}>
          <div className="panel__title">
            {catalogue.compartido
              ? `Sin registrar por nadie · ${section.faltan.length} de ${section.total} artículos`
              : `Tu sección: ${section.nombre} · ${section.total} artículos`}
          </div>
          <div className="panel__body">
            {catalogue.compartido && (
              <div className="hint">
                Lo que nadie había registrado cuando esta tableta descargó, y tú tampoco has
                tocado. La lista no se actualiza sin señal: coordina con los demás qué falta de
                verdad.
              </div>
            )}
            <ul className="checklist">
              <li className="checkrow">
                <span>registrados</span>
                <span className="num">{section.registrados}</span>
              </li>
              {section.heredados > 0 && (
                <li className="checkrow">
                  <span>ya registrados por otra persona</span>
                  <span className="num">{section.heredados}</span>
                </li>
              )}
              <li className="checkrow">
                <span>sin registrar</span>
                <span className="num">{section.faltan.length}</span>
              </li>
            </ul>
          </div>
          {section.faltan.length > 0 && (
            <ul className="rows">
              {section.faltan.map((idarticulo) => {
                const item = catalogue.byId.get(idarticulo);
                return (
                  <li className="row row--static" key={idarticulo}>
                    <div className="row__main">
                      <div className="row__nombre">{item?.nombre ?? `artículo ${idarticulo}`}</div>
                      <div className="row__meta">
                        <span className="num">{item?.codigo ?? ''}</span>
                        {item ? ` · ${item.presentacion}` : ''}
                      </div>
                    </div>
                    <div className="corrections">
                      {/*
                        Labelled per article. The visible word is the same on
                        every row, which is right on screen and useless to a
                        screen reader — and to anything else that has to tell
                        one row's button from another's.
                      */}
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-label={`contar ${item?.nombre ?? idarticulo}`}
                        onClick={() => onCount(idarticulo)}
                      >
                        Contar
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-label={`marcar ${item?.nombre ?? idarticulo} como vacío`}
                        onClick={() => setEmptying(idarticulo)}
                      >
                        Está vacío
                      </button>
                    </div>
                    {emptying === idarticulo && (
                      <div className="confirm">
                        <div className="confirm__text">
                          ¿Confirmas que este lugar está vacío?
                          <div className="hint">
                            Queda registrado como cero, que es una cantidad contada y no una
                            excusa. Si no fuiste, déjalo sin registrar.
                          </div>
                        </div>
                        <div className="actions__pair">
                          <button type="button" className="btn" onClick={() => setEmptying(null)}>
                            Volver
                          </button>
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => {
                              store.addCount(idarticulo, 0);
                              setEmptying(null);
                            }}
                          >
                            Sí, está vacío
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))
      )}

      <div className="actions">
        <button type="button" className="btn btn--primary" onClick={terminar}>
          {/* In a shared session a personal gap is the ordinary case — the rest
              of the list is somebody else's afternoon — so the button does not
              apologise for it. */}
          {!catalogue.compartido && summary.sinRegistrar > 0
            ? 'Terminar de todas formas'
            : 'Terminar'}
        </button>
      </div>
    </>
  );
}
