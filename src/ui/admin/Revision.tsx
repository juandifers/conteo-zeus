/**
 * The review — where the count becomes a decision (P2.4 §2, §4, §6).
 *
 * ## The two figures, side by side, always
 *
 * `pendiente` and `sinVerificar` sit next to each other because of what happens
 * next: as the admin waives rows **`pendiente` falls and `sinVerificar` does
 * not**. That is the honest picture — a waiver records who accepted a risk, it
 * does not reduce the risk — and a screen whose only visible number went down as
 * you clicked would be a screen that talks somebody into waiving 1 800 rows.
 *
 * ## What waiving does, said plainly
 *
 * The Zeus format has no way to say «we did not look». A waived row is written
 * with its book quantity, as though counted and found to match. The confirmation
 * says that sentence, in those words, before every bulk waiver rather than once
 * in a manual — it is the reason the acta exists.
 *
 * ## What this screen will not do
 *
 * Edit a count. Not deferred, refused: the count is what somebody saw, and an
 * admin adjusting it here would be entering a number nobody observed, under a
 * counter's identity or under none. If a count is wrong the counter reopens and
 * corrects it, or the admin records a note and the acta says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  familyPrefix,
  reviewChecklist,
  reviewSession,
  waiverPreview,
  type CounterEstado,
  type Review,
  type ReviewRow,
  type RetirarContadorPayload,
} from '../../domain';
import type { Api } from '../api';
import { ApiError } from '../api';
import { formatInstant, formatMoney, formatQty } from '../format';
import { loadSupervisor, saveSupervisor } from '../identity';
import { Aggregate } from './Aggregate';
import { describeAdvisory, describeSeal } from './blockers';
import { EventFeed } from './feed';
import { counterWord } from './vocabulario';
import { Amendments, Notas, Overlaps, Superseded, Trailing, Zeros } from './Hallazgos';
import type { SessionDetail, SyncSnapshot } from './types';

type EstadoFilter = 'todos' | 'counted' | 'unchanged' | 'untouched';

interface Filters {
  estado: EstadoFilter;
  flag: string;
  contador: string;
  seccion: string;
  familia: string;
  q: string;
}

const EMPTY: Filters = {
  estado: 'todos',
  flag: '',
  contador: '',
  seccion: '',
  familia: '',
  q: '',
};

interface Loaded {
  review: Review;
  sync: SyncSnapshot;
  /** When this arrived. Read here rather than during render — see `Cambios`. */
  at: string;
}

export function Revision({
  detail,
  api,
  onReload,
}: {
  detail: SessionDetail;
  api: Api;
  onReload: () => void;
}) {
  const feed = useRef<EventFeed>(new EventFeed());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [usuario, setUsuario] = useState(loadSupervisor);
  const [motivo, setMotivo] = useState('');

  const sessionId = detail.session.id;

  const load = useCallback(async () => {
    const sync = await api.get<SyncSnapshot>(`/api/sessions/${sessionId}/sync`);
    await feed.current.pull(api, sessionId);
    setLoaded({
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
      sync,
      at: new Date().toISOString(),
    });
  }, [api, detail.items, sessionId]);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setProblem(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [load]);

  /** Every article's section and family, for the filters. Built once per detail. */
  const where = useMemo(() => {
    const sections = new Map(detail.sections.map((section) => [section.id, section.nombre]));
    const byArticle = new Map<number, string>();
    for (const assignment of detail.assignments) {
      byArticle.set(assignment.idarticulo, sections.get(assignment.sectionId) ?? '');
    }
    return byArticle;
  }, [detail.assignments, detail.sections]);

  const familias = useMemo(
    () => [...new Set(detail.items.map((item) => familyPrefix(item.codigo)))].sort(),
    [detail.items],
  );
  const secciones = useMemo(
    () => [...new Set(detail.sections.map((section) => section.nombre))].sort(),
    [detail.sections],
  );

  const rows = loaded?.review.rows ?? [];
  const shown = rows.filter((row) => matches(row, filters, where));

  const preview = waiverPreview(rows, [...chosen]);
  const ready = usuario.trim() !== '' && motivo.trim() !== '' && chosen.size > 0;

  async function send(body: unknown): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`/api/sessions/${sessionId}/acciones`, body);
      saveSupervisor(usuario);
      setChosen(new Set());
      setConfirming(false);
      setMotivo('');
      await load();
      onReload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      setBusy(false);
    }
  }

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

  const { review, sync } = loaded;
  const advisory = reviewChecklist(review);

  return (
    <>
      {problem && (
        <div className="banner" role="alert">
          {problem}
        </div>
      )}

      {/* §2a, presented per brief §4.2: one figure while the two are equal,
          the split only when a waiver has made them differ — a three-line
          explanation of why two identical numbers differ explained nothing.
          Recomputed live, so the second one visibly does not move when the
          first one does. */}
      <div className="panel" id="cifras">
        <div className="panel__figures">
          <div>
            <div className="figure__label">Sin verificar</div>
            <div className="figure__value num">{formatMoney(review.sinVerificar.exposicion)}</div>
            <div className="hint">
              {review.exoneradas > 0
                ? `${review.sinVerificar.items} filas`
                : `${review.sinVerificar.items} de ${review.rows.length} filas`}
            </div>
          </div>
          {review.exoneradas > 0 && (
            <div>
              <div className="figure__label">Pendiente</div>
              <div className="figure__value num">{formatMoney(review.pendiente.exposicion)}</div>
              <div className="hint">
                {`${review.pendiente.items} filas · ${review.exoneradas} exon.`}
              </div>
            </div>
          )}
        </div>
        <div className="panel__body">
          {review.exoneradas > 0 && (
            <div className="hint">↳ Exonerar acepta el riesgo, no lo retira.</div>
          )}
          <div className="hint">
            {`Cobertura ${Math.round(review.cobertura.fraccionValor * 100)}% del valor · ` +
              `${Math.round(review.cobertura.fraccionFilas * 100)}% de las filas · ` +
              `diferencia neta ${formatMoney(review.netVarianceValue)} COP · ` +
              `bruta ${formatMoney(review.grossVarianceValue)} COP`}
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void load()}
          >
            Actualizar
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">Filtrar</div>
        <div className="panel__body">
          <label className="field__label" htmlFor="rev-q">
            Buscar
          </label>
          <input
            id="rev-q"
            className="field"
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            placeholder="nombre, código o presentación"
          />
          <div className="chips">
            {(
              [
                ['todos', 'todos'],
                ['counted', 'contados'],
                ['unchanged', 'exonerados'],
                ['untouched', 'sin contar'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={filters.estado === key ? 'chipbtn chipbtn--on' : 'chipbtn'}
                onClick={() => setFilters({ ...filters, estado: key })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="chips">
            {(
              [
                ['', 'sin filtro de marca'],
                ['overlap', 'dos contadores'],
                ['post-finish', 'después de terminar'],
                ['cero', 'en cero'],
                ['retraccion-final', 'terminó deshaciendo'],
                ['waiver-superado', 'exoneración superada'],
                ['outlier', 'atípicos'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key || 'ninguna'}
                type="button"
                className={filters.flag === key ? 'chipbtn chipbtn--on' : 'chipbtn'}
                onClick={() => setFilters({ ...filters, flag: key })}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="field__label" htmlFor="rev-contador">
            Contador
          </label>
          <select
            id="rev-contador"
            className="field"
            value={filters.contador}
            onChange={(event) => setFilters({ ...filters, contador: event.target.value })}
          >
            <option value="">todos</option>
            {sync.counters.map((counter) => (
              <option key={counter.id} value={counter.nombre}>
                {counter.nombre}
              </option>
            ))}
          </select>
          {/* A shared session (P2.6) has no sections: a filter over an empty
              list is a control that teaches people controls do nothing. */}
          {secciones.length > 0 && (
            <>
              <label className="field__label" htmlFor="rev-seccion">
                Sección
              </label>
              <select
                id="rev-seccion"
                className="field"
                value={filters.seccion}
                onChange={(event) => setFilters({ ...filters, seccion: event.target.value })}
              >
                <option value="">todas</option>
                {secciones.map((nombre) => (
                  <option key={nombre} value={nombre}>
                    {nombre}
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="field__label" htmlFor="rev-familia">
            Familia
          </label>
          <select
            id="rev-familia"
            className="field"
            value={filters.familia}
            onChange={(event) => setFilters({ ...filters, familia: event.target.value })}
          >
            <option value="">todas</option>
            {familias.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Aggregate
        rows={shown}
        compartido={detail.sections.length === 0}
        chosen={chosen}
        onToggle={(idarticulo) =>
          setChosen((current) => {
            const next = new Set(current);
            if (next.has(idarticulo)) next.delete(idarticulo);
            else next.add(idarticulo);
            return next;
          })
        }
      />

      <div className="panel">
        <div className="panel__title">Exonerar lo que nadie contó</div>
        <div className="panel__body">
          <div className="actions">
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() =>
                setChosen(
                  new Set(
                    shown
                      .filter((row) => row.state === 'untouched')
                      .map((row) => row.item.idarticulo),
                  ),
                )
              }
            >
              {`Elegir las ${shown.filter((row) => row.state === 'untouched').length} sin contar del filtro`}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || chosen.size === 0}
              onClick={() => setChosen(new Set())}
            >
              Quitar la selección
            </button>
          </div>
          <label className="field__label" htmlFor="rev-usuario">
            Quién firma
          </label>
          <input
            id="rev-usuario"
            className="field"
            value={usuario}
            onChange={(event) => setUsuario(event.target.value)}
            placeholder="tu nombre"
          />
          <label className="field__label" htmlFor="rev-motivo">
            Motivo
          </label>
          <input
            id="rev-motivo"
            className="field"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
            placeholder="no alcanzó el turno; se acepta el saldo de Zeus"
          />

          {confirming && (
            // §4d, in front of the person, before every bulk waiver. The
            // sentence is the consequence in the file, not a summary of it —
            // and the «firmar por filas que nadie caminó» paragraph lives
            // here now, attached to the decision (§5.2).
            <div className="banner" role="alert">
              <div>
                {`Vas a exonerar ${preview.filas} filas por ${formatMoney(preview.valor)} COP ` +
                  `en libros (${formatMoney(preview.exposicion)} COP de exposición). Es firmar ` +
                  'por filas que nadie caminó: queda con tu nombre y tu motivo, y sale ' +
                  'impreso en el acta.'}
              </div>
              <div>
                <strong>
                  Esas filas se van a escribir en el archivo con la cantidad de
                  Zeus, como si se hubieran contado y coincidido.
                </strong>{' '}
                El formato no tiene forma de decir «no fuimos». Por eso existe el
                acta, y por eso «sin verificar» no va a bajar. Un conteo nunca se
                pierde por una exoneración: si una tableta sincroniza después,
                manda el conteo.
              </div>
            </div>
          )}
        </div>
        <div className="actions">
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !ready}
                onClick={() =>
                  void send({
                    kind: 'waiver',
                    usuario,
                    motivo,
                    idarticulo: [...chosen],
                  })
                }
              >
                {`Sí, exonerar ${preview.filas} filas`}
              </button>
              <button
                type="button"
                className="btn btn--small"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy || !ready}
              onClick={() => setConfirming(true)}
            >
              {`Exonerar ${chosen.size} filas`}
            </button>
          )}
        </div>
      </div>

      {review.waivers.length > 0 && (
        <div className="panel">
          <div className="panel__title">Exoneraciones firmadas</div>
          <ul className="rows">
            {review.waivers.map((waiver) => (
              <li className="row row--static" key={waiver.actionId}>
                <div className="row__main">
                  <div className="row__nombre">
                    {`${waiver.idarticulo.length} filas · ${waiver.usuario}`}
                  </div>
                  <div className="row__meta">
                    {`${formatInstant(waiver.at)} · ${waiver.motivo}`}
                  </div>
                </div>
                <div className="corrections">
                  <button
                    type="button"
                    className="btn btn--small"
                    aria-label={`anular la exoneración de ${waiver.usuario}`}
                    disabled={busy || usuario.trim() === '' || motivo.trim() === ''}
                    onClick={() =>
                      void send({
                        kind: 'anular_waiver',
                        usuario,
                        motivo,
                        waiverId: waiver.actionId,
                      })
                    }
                  >
                    Anular
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="panel__body">
            <div className="hint">
              Anular no borra nada: la exoneración original se queda en la
              cadena y esta anulación se escribe encima de ella, igual que un
              retiro con destino.
            </div>
          </div>
        </div>
      )}

      <Overlaps overlaps={review.overlaps} compartido={detail.sections.length === 0} />
      <Zeros zeros={review.zeros} />
      <Amendments amendments={review.amendments} />
      <Trailing trailing={review.trailing} />
      <Superseded superseded={review.superseded} />
      <Notas notes={review.notes} />

      <Readiness review={review} sync={sync} advisory={advisory} />
    </>
  );
}

/**
 * §6 — two tiers, and the difference has to be legible.
 *
 * **Blocking** is `sessionReadyToSeal`, which cannot be clicked past.
 * **Advisory** is the review checklist, which blocks nothing. Presenting them
 * under one heading would teach the reader that neither means much.
 *
 * §6a is the second half: `terminado_confirmado` and `retirado` are not the same
 * grade of evidence and are not shown as though they were. A confirmed finish is
 * a chain checked against a manifest the device could not have written without
 * the events behind it. A retirement is contiguity — no hole — which cannot see
 * a missing tail. Presenting proven and unverifiable under one checkmark invites
 * confidence that was not earned, which is the discipline ZEUS_FORMAT.md §7.1
 * established for the Zeus evidence and the same one P2.5 carries onto the acta.
 */
function Readiness({
  review,
  sync,
  advisory,
}: {
  review: Review;
  sync: SyncSnapshot;
  advisory: ReturnType<typeof reviewChecklist>;
}) {
  const motivoOf = (counterId: string): string | null => {
    const action = [...sync.acciones]
      .reverse()
      .find(
        (entry) =>
          entry.kind === 'retirar_contador' &&
          (entry.payload as RetirarContadorPayload).counterId === counterId,
      );
    return action ? (action.payload as RetirarContadorPayload).motivo : null;
  };

  return (
    <div className="panel" id="sellado">
      <div className="panel__title">Antes de sellar</div>
      <div className="panel__body">
        <div className="panel__subtitle">Bloquea</div>
        {sync.session.readyToSeal.length === 0 ? (
          <div className="hint">Nada. Las cadenas de todos están completas.</div>
        ) : (
          <ul className="checklist">
            {sync.session.readyToSeal.map((blocker, index) => (
              <li className="checkrow" key={`${blocker.kind}-${index}`}>
                <span>{describeSeal(blocker)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="panel__subtitle">No bloquea, pero míralo</div>
        {advisory.length === 0 ? (
          <div className="hint">Nada pendiente de revisar.</div>
        ) : (
          <ul className="checklist">
            {advisory.map((item) => (
              <li className="checkrow" key={item.kind}>
                <span>{describeAdvisory(item)}</span>
                <span className="num">{item.valor > 0 ? formatMoney(item.valor) : ''}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="panel__subtitle">Qué respalda el trabajo de cada uno</div>
        {/* §6a in the admin's words (§5.3): the two grades of evidence stay
            apart, but nobody is taught «cadena» or «manifiesto» to read them. */}
        <ul className="rows">
          {sync.counters.map((counter) => {
            const retirado = counter.estado === 'retirado';
            const motivo = retirado ? motivoOf(counter.id) : null;
            return (
              <li className="row row--static" key={counter.id}>
                <div className="row__main">
                  <div className="row__nombre">{`${counter.nombre} · ${counterWord(counter.estado)}`}</div>
                  <div className="row__meta">
                    {counter.estado === 'terminado_confirmado'
                      ? 'verificado: su tableta declaró cuánto registró y el servidor lo tiene todo'
                      : retirado
                        ? 'sin verificar: se retiró sin tocar «Terminar», y un tramo final que ' +
                          'no alcanzó a subir no se puede descartar' +
                          (motivo ? ` · retirado: ${motivo}` : '')
                        : 'todavía contando'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="hint">
          {`${review.counts.counted} contados · ${review.counts.unchanged} exonerados · ` +
            `${review.counts.untouched} sin tocar · ${formatQty(review.rows.length)} filas`}
        </div>
      </div>
    </div>
  );
}

/** Whether a row survives the current filter. Pure, so the table is a projection. */
function matches(
  row: ReviewRow,
  filters: Filters,
  where: ReadonlyMap<number, string>,
): boolean {
  if (filters.estado !== 'todos' && row.state !== filters.estado) return false;
  if (filters.flag !== '' && !row.flags.some((flag) => flag.kind === filters.flag)) return false;
  if (filters.contador !== '' && !row.contadores.includes(filters.contador)) return false;
  if (filters.seccion !== '' && where.get(row.item.idarticulo) !== filters.seccion) return false;
  if (filters.familia !== '' && familyPrefix(row.item.codigo) !== filters.familia) return false;
  if (filters.q !== '') {
    const needle = filters.q.trim().toLowerCase();
    const hay = `${row.item.nombre} ${row.item.codigo} ${row.item.presentacion}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}
