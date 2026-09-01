/**
 * Dividing a bodega between the people who will count it.
 *
 * The screen is built around one fact: **coverage is a hard gate**. Every
 * article in the catalogue belongs to exactly one counter or nothing is
 * dispatched, and the gap is shown as places to go — family, row count,
 * exposure, example names — rather than as a number, because "23 sin asignar"
 * is not something anybody can act on.
 *
 * The layout is two columns because the task is two-sided: the **catalogue**
 * (families, articles — what there is to walk) on the left, and the **plan**
 * (sections, who counts each, coverage, the gate) in a rail on the right that
 * stays put while the left side scrolls. Every move made on the left is
 * visible in the rail the moment it happens; before this the sections lived
 * above the families and checking one meant losing the other.
 *
 * The families are a **proposal**. They are derived from `codigo` digits
 * (`deriveFamilies`) and the labels are the admin's; nothing in the file says
 * "abarrotes". When the derivation's guards refuse to propose anything the
 * screen says so and the same controls still build sections by hand.
 *
 * There is no drag-and-drop. The three motions the task describes are all here
 * — a whole family into a section (existing or minted on the spot), a family
 * split across several, single articles moved — as selects and buttons, which
 * work on a laptop trackpad at six in the evening and can be exercised by a
 * test.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { exposureValue, type FamilyGroup, type Item } from '../../domain';
import { formatMoneyShort } from '../format';
import { describeBlocker } from './blockers';
import {
  chunk,
  countersIn,
  dispatchBody,
  loadPlan,
  move,
  newSectionId,
  planState,
  savePlan,
  type Plan,
} from './plan';
import type { DispatchResult, SessionDetail } from './types';
import { ApiError, type Api } from '../api';

/** Sum of `exposureValue` over a set of ids — the §5 figure, not book value. */
function exposureOf(items: readonly Item[], ids: Iterable<number>): number {
  const wanted = new Set(ids);
  let total = 0;
  for (const item of items) if (wanted.has(item.idarticulo)) total += exposureValue(item);
  return total;
}

/** The select value that means «mint a section and move it there», not a section id. */
const NUEVA = '__nueva';
/** The select value that means «out of every section». */
const NINGUNA = '__ninguna';

export function Reparto({
  detail,
  api,
  onDispatched,
  onReload,
}: {
  detail: SessionDetail;
  api: Api;
  onDispatched: () => void;
  onReload: () => void;
}) {
  const sessionId = detail.session.id;
  const [plan, setPlan] = useState<Plan>(() => loadPlan(sessionId));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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
  const state = useMemo(() => planState(items, plan, server), [items, plan, server]);

  const familias: FamilyGroup[] | null = detail.familias;
  const sectionNames = useMemo(
    () => new Map(plan.sections.map((section) => [section.id, section.nombre])),
    [plan.sections],
  );
  const counterNames = useMemo(
    () => new Map(countersIn(plan).map((nombre) => [nombre, nombre])),
    [plan],
  );

  const addSection = useCallback((nombre: string, counterNombre = '') => {
    setPlan((current) => {
      const id = newSectionId(current);
      return {
        ...current,
        sections: [...current.sections, { id, nombre, counterNombre }],
      };
    });
  }, []);

  /**
   * A move from a family row. `NUEVA` mints the section right here, named
   * after the family, so «esta familia, para alguien» is one gesture instead
   * of create-section, scroll, find-family, move.
   */
  const moveFamily = useCallback((family: FamilyGroup, target: string | null) => {
    setPlan((current) => {
      if (target !== NUEVA) return move(current, family.idarticulos, target);
      const id = newSectionId(current);
      const label = current.etiquetas[family.prefix] ?? '';
      const nombre =
        label !== ''
          ? label
          : family.prefix === ''
            ? `SECCIÓN ${current.sections.length + 1}`
            : `FAMILIA ${family.prefix}`;
      return {
        ...move(
          { ...current, sections: [...current.sections, { id, nombre, counterNombre: '' }] },
          family.idarticulos,
          id,
        ),
      };
    });
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
            ? `${cause.message}: ${blockers
                .map((blocker) =>
                  describeBlocker(blocker, { counters: counterNames, sections: sectionNames }),
                )
                .join(' ')}`
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
  }, [api, sessionId, plan, onDispatched, onReload, counterNames, sectionNames]);

  const ready = state.blockers.length === 0;
  const counters = countersIn(plan);

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

      <div className="reparto">
        <div className="reparto__catalogo">
          <div className="panel">
            <div className="panel__title">
              {familias === null ? 'Artículos' : `Familias propuestas (${familias.length})`}
            </div>
            <div className="panel__body">
              {familias === null ? (
                <div className="hint">
                  El catálogo no está numerado como para proponer familias — los códigos no miden
                  todos siete caracteres, o casi todo cae en un solo grupo. Arma las secciones a
                  mano con la lista de abajo.
                </div>
              ) : (
                <div className="hint">
                  Un punto de partida, no una clasificación. Los dígitos 3 y 4 del código agrupan;
                  los nombres los pones tú. Mueve cada familia a una sección — «sección nueva» la
                  crea de una — o repártela en varias. La exposición manda sobre el valor en
                  libros.
                </div>
              )}

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
                    plan={plan}
                    items={items}
                    byId={byId}
                    expanded={expanded === family.prefix}
                    onExpand={() => setExpanded(expanded === family.prefix ? null : family.prefix)}
                    onLabel={(label) =>
                      setPlan((current) => ({
                        ...current,
                        etiquetas: { ...current.etiquetas, [family.prefix]: label },
                      }))
                    }
                    onMove={(target) => moveFamily(family, target)}
                    onMoveOne={(ids, sectionId) =>
                      setPlan((current) => move(current, ids, sectionId))
                    }
                    onSplit={(parts) =>
                      setPlan((current) => {
                        // The catch-all pseudo-family has no prefix; «SECCIÓN 1»
                        // beats a section literally named « 1».
                        const etiqueta = current.etiquetas[family.prefix] ?? '';
                        const label =
                          etiqueta !== ''
                            ? etiqueta
                            : family.prefix === ''
                              ? 'SECCIÓN'
                              : family.prefix;
                        let next = current;
                        chunk(family.idarticulos, parts).forEach((slice, index) => {
                          const id = newSectionId(next);
                          next = {
                            ...move(next, slice, id),
                            sections: [
                              ...next.sections,
                              { id, nombre: `${label} ${index + 1}`, counterNombre: '' },
                            ],
                          };
                        });
                        return next;
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          </div>

          <SessionSettings detail={detail} api={api} onSaved={onReload} />
        </div>

        <aside className="reparto__plan" aria-label="El plan del reparto">
          <div className="panel">
            <div className="panel__title">El reparto</div>
            <div className="panel__body">
              <div className="hint">
                Una sección es un pedazo de la bodega; quien la cuenta se escribe en ella. El
                mismo nombre en dos secciones es la misma persona con dos zonas.
              </div>

              {plan.sections.length === 0 && (
                <div className="hint">
                  Todavía no hay secciones. Mueve una familia a «sección nueva», reparte una
                  grande en varias, o crea una vacía aquí.
                </div>
              )}

              <ul className="secrows">
                {plan.sections.map((section) => {
                  const ids = Object.entries(plan.asignado)
                    .filter(([, id]) => id === section.id)
                    .map(([idarticulo]) => Number(idarticulo));
                  return (
                    <li className="secrow" key={section.id}>
                      <div className="secrow__fields">
                        <label className="secrow__field">
                          <span className="secrow__label">sección</span>
                          <input
                            aria-label={`Nombre de la sección ${section.nombre}`}
                            className="tinput"
                            value={section.nombre}
                            onChange={(event) =>
                              setPlan((current) => ({
                                ...current,
                                sections: current.sections.map((s) =>
                                  s.id === section.id ? { ...s, nombre: event.target.value } : s,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label className="secrow__field">
                          <span className="secrow__label">quién la cuenta</span>
                          <input
                            aria-label={`Contador de ${section.nombre}`}
                            className="tinput"
                            placeholder="nombre del contador"
                            value={section.counterNombre}
                            onChange={(event) =>
                              setPlan((current) => ({
                                ...current,
                                sections: current.sections.map((s) =>
                                  s.id === section.id
                                    ? { ...s, counterNombre: event.target.value }
                                    : s,
                                ),
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className="secrow__meta">
                        <span>
                          {ids.length} art. · {formatMoneyShort(exposureOf(items, ids))}
                        </span>
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() =>
                            setPlan((current) => ({
                              // Removing a section releases its articles rather
                              // than losing them: they come straight back as an
                              // uncovered gap the gate refuses.
                              ...move(current, ids, null),
                              sections: current.sections.filter((s) => s.id !== section.id),
                            }))
                          }
                        >
                          quitar
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="actions actions--flat">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => addSection(`SECCIÓN ${plan.sections.length + 1}`)}
                >
                  Nueva sección
                </button>
              </div>
            </div>

            <div className="panel__section">
              <div className="panel__subtitle">
                Cobertura: {state.coverage.assigned} de {items.length}
              </div>
              <div className="progressbar">
                <div
                  className="progressbar__fill"
                  style={{
                    width: `${(state.coverage.assigned / Math.max(1, items.length)) * 100}%`,
                  }}
                />
              </div>
              {state.huecos.length > 0 ? (
                <>
                  <div className="hint">
                    Lo que falta, por familia y por exposición — no por valor en libros: una fila
                    con saldo cero en libros puede ser un estante lleno (DOMAIN.md §5).
                  </div>
                  <ul className="corrections">
                    {state.huecos.map((hueco) => (
                      <li key={hueco.prefix}>
                        <strong>{plan.etiquetas[hueco.prefix] ?? hueco.prefix}</strong> —{' '}
                        {hueco.rows} filas, {formatMoneyShort(hueco.exposicion)} ·{' '}
                        {hueco.ejemplos.join(', ')}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="hint">Todos los artículos tienen dueño.</div>
              )}
            </div>

            <div className="panel__section">
              <div className="panel__subtitle">Despachar</div>
              {state.blockers.length > 0 ? (
                <ul className="checklist">
                  {state.blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}:${index}`} className="checkrow">
                      {describeBlocker(blocker, { counters: counterNames, sections: sectionNames })}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hint">
                  {counters.length} {counters.length === 1 ? 'contador' : 'contadores'},{' '}
                  {plan.sections.length} {plan.sections.length === 1 ? 'sección' : 'secciones'},
                  los {items.length} artículos repartidos. Al despachar se abre la sesión y se
                  generan los enlaces; después no se agregan ni se cambian contadores.
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
  plan,
  items,
  byId,
  expanded,
  onExpand,
  onLabel,
  onMove,
  onMoveOne,
  onSplit,
}: {
  family: FamilyGroup;
  plan: Plan;
  items: readonly Item[];
  byId: Map<number, Item>;
  expanded: boolean;
  onExpand: () => void;
  onLabel: (label: string) => void;
  /** The whole family: to a section, to a fresh one (`NUEVA`), or out (`null`). */
  onMove: (target: string | null) => void;
  /** One article at a time, from the expanded table. */
  onMoveOne: (ids: readonly number[], sectionId: string | null) => void;
  onSplit: (parts: number) => void;
}) {
  const [parts, setParts] = useState(2);

  // Where this family's articles are right now, so the row answers «¿y esta ya
  // quedó?» without scrolling to the rail. Presence and counts, per section.
  const destino = useMemo(() => {
    const bySection = new Map<string, number>();
    let sueltos = 0;
    for (const id of family.idarticulos) {
      const sectionId = plan.asignado[id];
      if (sectionId === undefined) sueltos += 1;
      else bySection.set(sectionId, (bySection.get(sectionId) ?? 0) + 1);
    }
    const names = new Map(plan.sections.map((section) => [section.id, section.nombre]));
    const partes = [...bySection.entries()].map(
      ([sectionId, count]) => `${names.get(sectionId) ?? '?'} (${count})`,
    );
    return { partes, sueltos };
  }, [family.idarticulos, plan.asignado, plan.sections]);

  return (
    <li className="fam">
      <div className="fam__head">
        <input
          aria-label={`Nombre de la familia ${family.prefix}`}
          className="tinput fam__label"
          value={plan.etiquetas[family.prefix] ?? ''}
          placeholder={family.prefix === '' ? 'todo el catálogo' : `familia ${family.prefix}`}
          onChange={(event) => onLabel(event.target.value)}
        />
        <span className="fam__stats">
          {family.rows} filas · {formatMoneyShort(family.exposicion)}
        </span>
        {destino.partes.length === 0 ? (
          <span className="chip">sin asignar</span>
        ) : (
          <span className="chip chip--counted">
            → {destino.partes.join(' · ')}
            {destino.sueltos > 0 && ` · ${destino.sueltos} sin asignar`}
          </span>
        )}
      </div>
      {family.ejemplos.length > 0 && (
        <div className="fam__ejemplos hint">{family.ejemplos.join(', ')}</div>
      )}
      <div className="fam__controls">
        <select
          aria-label={`Mover la familia ${family.prefix}`}
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') return;
            onMove(value === NINGUNA ? null : value);
            event.target.value = '';
          }}
        >
          <option value="">mover a…</option>
          {plan.sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.nombre}
            </option>
          ))}
          <option value={NUEVA}>sección nueva</option>
          <option value={NINGUNA}>— sin asignar —</option>
        </select>
        <input
          aria-label={`Partes para la familia ${family.prefix}`}
          className="tinput tinput--num"
          type="number"
          min={2}
          max={20}
          value={parts}
          onChange={(event) => setParts(Math.max(2, Number(event.target.value) || 2))}
        />
        <button type="button" className="btn btn--small" onClick={() => onSplit(parts)}>
          repartir en {parts}
        </button>
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
                  <td>
                    <select
                      aria-label={`Sección de ${item.nombre} (${idarticulo})`}
                      value={plan.asignado[idarticulo] ?? ''}
                      onChange={(event) =>
                        onMoveOne(
                          [idarticulo],
                          event.target.value === '' ? null : event.target.value,
                        )
                      }
                    >
                      <option value="">— sin asignar —</option>
                      {plan.sections.map((section) => (
                        <option key={section.id} value={section.id}>
                          {section.nombre}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {items.length === 0 && <div className="hint">Este archivo no tiene artículos.</div>}
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
