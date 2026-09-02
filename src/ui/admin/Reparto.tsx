/**
 * Getting a draft from «archivo importado» to «tabletas en la bodega».
 *
 * Since P2.6 the screen is built around one fact: **the bodega is divided
 * outside the app.** The counters coordinate on the floor, by the layout in
 * front of them, and every tablet receives the whole catalogue — so there are
 * no sections to draw, no coverage to complete, and the plan is exactly the
 * list of people counting today. The sectioned planner this replaces is
 * disabled rather than removed; the server still serves sessions dispatched
 * under it.
 *
 * The layout is two columns because the task is still two-sided: the
 * **catalogue** (families, articles, exposure — what there is to walk) on the
 * left as context, and the **plan** in a rail on the right. The rail is two
 * numbered steps because that really is the sequence: who is here today, and
 * the button that mints their links.
 *
 * The families are informational. They are derived from `codigo` digits
 * (`deriveFamilies`) and ranked by exposure, so the admin can see what the
 * file holds before handing it to five people — but nothing here assigns them
 * to anybody, on purpose.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { exposureValue, type FamilyGroup, type Item } from '../../domain';
import { formatMoneyShort } from '../format';
import { describeBlocker } from './blockers';
import { dispatchBody, loadPlan, planState, savePlan, type Plan } from './plan';
import type { DispatchResult, SessionDetail } from './types';
import { ApiError, type Api } from '../api';

/** Sum of `exposureValue` over a set of ids — the §5 figure, not book value. */
function exposureOf(items: readonly Item[], ids: Iterable<number>): number {
  const wanted = new Set(ids);
  let total = 0;
  for (const item of items) if (wanted.has(item.idarticulo)) total += exposureValue(item);
  return total;
}

export function Reparto({
  detail,
  api,
  onDispatched,
  onReload,
  onDeleted = () => {
    if (globalThis.location) globalThis.location.hash = '#/admin';
  },
}: {
  detail: SessionDetail;
  api: Api;
  onDispatched: () => void;
  onReload: () => void;
  /** After the draft is deleted. Injected so a test does not drive `location`. */
  onDeleted?: () => void;
}) {
  const sessionId = detail.session.id;
  const [plan, setPlan] = useState<Plan>(() => loadPlan(sessionId));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');

  useEffect(() => {
    savePlan(sessionId, plan);
  }, [sessionId, plan]);

  const items = detail.items;
  const byId = useMemo(() => new Map(items.map((item) => [item.idarticulo, item])), [items]);

  // The server already told us whether the stored file still hashes to what it
  // was imported as, and whether the posting parameters are the verified
  // triple. Neither is knowable here, and a screen that guessed would say
  // "listo" about something dispatch is going to refuse.
  const server = useMemo(
    () => ({
      estado: detail.session.estado,
      archivoIntacto: !detail.blockers.some((blocker) => blocker.kind === 'archivo-cambiado'),
      parametrosVerificados: detail.session.parametrosVerificados,
    }),
    [detail.session.estado, detail.session.parametrosVerificados, detail.blockers],
  );
  const state = useMemo(() => planState(plan, server), [plan, server]);

  const familias: FamilyGroup[] | null = detail.familias;

  const addToRoster = useCallback(() => {
    const nombre = nuevoNombre.trim();
    if (nombre === '') return;
    setPlan((current) =>
      current.roster.includes(nombre)
        ? current
        : { ...current, roster: [...current.roster, nombre] },
    );
    setNuevoNombre('');
  }, [nuevoNombre]);

  const removeFromRoster = useCallback((nombre: string) => {
    setPlan((current) => ({
      ...current,
      roster: current.roster.filter((name) => name !== nombre),
    }));
  }, []);

  const dispatch = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      await api.post<DispatchResult>(`/api/sessions/${sessionId}/dispatch`, dispatchBody(plan));
      // The links come back on the reload rather than out of this response.
      // One source for what the session now is beats two that can disagree.
      onDispatched();
    } catch (cause) {
      if (cause instanceof ApiError) {
        const blockers = (cause.detalle as { blockers?: Parameters<typeof describeBlocker>[0][] })
          ?.blockers;
        setError(
          blockers
            ? `${cause.message}: ${blockers.map((blocker) => describeBlocker(blocker)).join(' ')}`
            : cause.message,
        );
        // The server saw something this screen did not. Re-reading is how the
        // two get back into agreement rather than the admin retrying blind.
        onReload();
      } else {
        setError(String(cause));
      }
    } finally {
      setSending(false);
    }
  }, [api, sessionId, plan, onDispatched, onReload]);

  const ready = state.blockers.length === 0;
  const roster = plan.roster;

  return (
    <div className="screen screen--desk">
      <div className="masthead">
        <a className="backlink" href="#/admin">
          ← Conteos
        </a>
        <div className="masthead__title">
          Bodega {detail.session.bodega} · corte {detail.session.fechaCorte}
        </div>
        <div className="hint">
          {detail.session.itemCount} artículos · {detail.session.sourceName ?? 'sin nombre'}
        </div>
      </div>

      <div className="desksplit">
        <div className="desksplit__main">
          <div className="panel">
            <div className="panel__title">
              {familias === null ? 'Artículos' : `Lo que hay que contar (${familias.length} familias)`}
            </div>
            <div className="panel__body">
              <div className="hint">
                Todo el catálogo va en cada tableta: quién cuenta qué se coordina en la bodega,
                sobre los estantes, no aquí. Esta lista es para saber qué contiene el archivo —
                agrupado por los dígitos 3 y 4 del código, con la exposición por delante del
                valor en libros.
              </div>

              <ul className="rows">
                {(
                  familias ?? [
                    {
                      prefix: '',
                      idarticulos: items.map((i) => i.idarticulo),
                      rows: items.length,
                      valor: 0,
                      exposicion: exposureOf(
                        items,
                        items.map((i) => i.idarticulo),
                      ),
                      ejemplos: [],
                    },
                  ]
                ).map((family) => (
                  <FamilyRow
                    key={family.prefix}
                    family={family}
                    byId={byId}
                    expanded={expanded === family.prefix}
                    onExpand={() => setExpanded(expanded === family.prefix ? null : family.prefix)}
                  />
                ))}
              </ul>
              {items.length === 0 && <div className="hint">Este archivo no tiene artículos.</div>}
            </div>
          </div>

          <SessionSettings detail={detail} api={api} onSaved={onReload} />

          <DeleteSession
            api={api}
            sessionId={sessionId}
            estado={detail.session.estado}
            onDeleted={onDeleted}
          />
        </div>

        <aside className="desksplit__rail" aria-label="El plan del reparto">
          <div className="panel">
            <div className="panel__title">El conteo</div>
            <div className="panel__body">
              <div className="hint">
                Cada persona recibe un enlace con el catálogo completo y registra lo que cuenta.
                Los registros de todos se juntan en el servidor, artículo por artículo, con el
                nombre de quien contó cada uno.
              </div>
            </div>

            <div className="panel__section">
              <div className="panel__subtitle">
                <span className="stepno">1</span> Quiénes cuentan hoy
              </div>
              {roster.length === 0 && (
                <div className="hint">
                  Escribe los nombres de las personas que van a contar — una por tableta. Cada
                  una recibe su enlace al despachar.
                </div>
              )}
              {roster.length > 0 && (
                <ul className="roster">
                  {roster.map((nombre) => (
                    <li className="roster__row" key={nombre}>
                      <span className="roster__nombre">{nombre}</span>
                      <span className="roster__meta">todo el catálogo</span>
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-label={`Quitar a ${nombre}`}
                        onClick={() => removeFromRoster(nombre)}
                      >
                        quitar
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="roster__add"
                onSubmit={(event) => {
                  event.preventDefault();
                  addToRoster();
                }}
              >
                <input
                  aria-label="Nombre de un contador nuevo"
                  className="tinput"
                  placeholder="nombre, p. ej. Ana"
                  value={nuevoNombre}
                  onChange={(event) => setNuevoNombre(event.target.value)}
                />
                <button type="submit" className="btn btn--small">
                  Agregar
                </button>
              </form>
            </div>

            <div className="panel__section">
              <div className="panel__subtitle">
                <span className="stepno">2</span> Despachar
              </div>
              {state.blockers.length > 0 ? (
                <ul className="checklist">
                  {state.blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}:${index}`} className="checkrow">
                      {describeBlocker(blocker)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hint">
                  {roster.length} {roster.length === 1 ? 'contador' : 'contadores'}, cada uno con
                  los {items.length} artículos. Al despachar se abre la sesión y se generan los
                  enlaces; después se puede agregar o retirar gente desde «Cambios».
                </div>
              )}
              {error && (
                <div className="banner" role="alert">
                  {error}
                </div>
              )}
              <div className="actions actions--flat">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!ready || sending}
                  onClick={() => void dispatch()}
                >
                  {sending ? 'Despachando…' : 'Despachar y generar enlaces'}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function FamilyRow({
  family,
  byId,
  expanded,
  onExpand,
}: {
  family: FamilyGroup;
  byId: Map<number, Item>;
  expanded: boolean;
  onExpand: () => void;
}) {
  return (
    <li className="fam">
      <div className="fam__head">
        <span className="fam__label">
          {family.prefix === '' ? 'todo el catálogo' : `familia ${family.prefix}`}
        </span>
        <span className="fam__stats">
          {family.rows} filas · {formatMoneyShort(family.exposicion)}
        </span>
      </div>
      {family.ejemplos.length > 0 && (
        <div className="fam__ejemplos hint">{family.ejemplos.join(', ')}</div>
      )}
      <div className="fam__controls">
        <button type="button" className="btn btn--small" onClick={onExpand}>
          {expanded ? 'cerrar' : 'ver artículos'}
        </button>
      </div>
      {expanded && (
        <table className="grid">
          <tbody>
            {family.idarticulos.map((idarticulo) => {
              const item = byId.get(idarticulo)!;
              return (
                <tr key={idarticulo}>
                  <td className="grid__nombre">{item.nombre}</td>
                  <td className="grid__meta">{item.presentacion}</td>
                  <td className="num">{formatMoneyShort(exposureValue(item))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </li>
  );
}

/**
 * The session's own settings.
 *
 * `mostrarMarcaRegistrado` lives here rather than in the build because the jefe
 * may want the neutral checkmark gone after seeing it in use, and that has to
 * be a toggle rather than a deploy (P2.1 §4d). At the foot of the catalogue
 * column: it is read once per session, and the reparto is what this screen is
 * for.
 */
function SessionSettings({
  detail,
  api,
  onSaved,
}: {
  detail: SessionDetail;
  api: Api;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <div className="panel">
      <div className="panel__title">Ajustes</div>
      <div className="panel__body">
        <label className="checkrow">
          <input
            type="checkbox"
            checked={detail.session.mostrarMarcaRegistrado}
            disabled={saving}
            onChange={async (event) => {
              setSaving(true);
              try {
                await api.patch(`/api/sessions/${detail.session.id}`, {
                  mostrarMarcaRegistrado: event.target.checked,
                });
                onSaved();
              } finally {
                setSaving(false);
              }
            }}
          />
          Mostrar la marca «registrado» en la pantalla de conteo
        </label>
        <div className="hint">
          En un conteo compartido la marca también avisa cuando otra persona ya registró un
          artículo — al descargar y al actualizar en wifi, no en vivo.
        </div>
        <div className="hint">
          Los parámetros de subida son {detail.session.parameters.countTargetColumn} ·{' '}
          {detail.session.parameters.uncountedPolicy} ·{' '}
          {detail.session.parameters.differenceColumn}
          {detail.session.parametrosVerificados
            ? ' — los verificados contra Zeus (§7.1).'
            : ` — SIN verificar: ${detail.session.parametrosSinVerificar.join(', ')}.`}
        </div>
      </div>
    </div>
  );
}

/**
 * Deleting a junk session — shared by the draft screen and the dispatched one.
 *
 * Never a browser dialog (the product rule), and never adjacent to the primary
 * action: the confirm strip appears in place, says what is destroyed, and the
 * server refuses a sealed session regardless of what this component believes
 * (`DELETE /api/sessions/:id`).
 */
export function DeleteSession({
  api,
  sessionId,
  estado,
  onDeleted,
}: {
  api: Api;
  sessionId: string;
  estado: string;
  onDeleted: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The seal is a signed claim about a completed count; its session is the
  // evidence. The server enforces this — hiding the button just keeps the
  // screen from offering what will be refused.
  if (estado === 'sellado' || estado === 'cerrado') return null;

  const texto =
    estado === 'borrador'
      ? 'Se borra este borrador y el archivo importado. No hay nada contado que perder.'
      : 'Se borran sus contadores, sus enlaces y todo lo que ya registraron en el servidor. ' +
        'Las tabletas que tengan trabajo sin subir se quedan sin dónde subirlo.';

  return (
    <div className="panel">
      <div className="panel__body">
        {!asking ? (
          <button type="button" className="btn--waiver" onClick={() => setAsking(true)}>
            {estado === 'borrador' ? 'Eliminar este borrador' : 'Eliminar esta sesión'}
          </button>
        ) : (
          <div className="confirm">
            <div className="confirm__text">{texto}</div>
            {problem && (
              <div className="banner" role="alert">
                {problem}
              </div>
            )}
            <div className="actions__pair">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setAsking(false);
                  setProblem(null);
                }}
              >
                Conservar
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setProblem(null);
                  try {
                    await api.del(`/api/sessions/${sessionId}`);
                    onDeleted();
                  } catch (cause) {
                    setProblem(cause instanceof Error ? cause.message : String(cause));
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Eliminando…' : 'Sí, eliminar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
