/**
 * Dividing a bodega between the people who will count it.
 *
 * The screen is built around one fact: **coverage is a hard gate**. Every
 * article in the catalogue belongs to exactly one counter or nothing is
 * dispatched, and the gap is shown as places to go — family, row count,
 * exposure, example names — rather than as a number, because "23 sin asignar"
 * is not something anybody can act on.
 *
 * The families are a **proposal**. They are derived from `codigo` digits
 * (`deriveFamilies`) and the labels are the admin's; nothing in the file says
 * "abarrotes". When the derivation's guards refuse to propose anything the
 * screen says so and the same controls still build sections by hand.
 *
 * There is no drag-and-drop. The three motions the task describes are all here
 * — a whole family into a section, a family split across several, single
 * articles moved — as selects and buttons, which work on a laptop trackpad at
 * six in the evening and can be exercised by a test.
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

  const addSection = useCallback(
    (nombre: string, counterNombre = '') => {
      setPlan((current) => {
        const id = newSectionId(current);
        return {
          ...current,
          sections: [...current.sections, { id, nombre, counterNombre }],
        };
      });
    },
    [],
  );

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

  return (
    <div className="screen screen--desk">
      <div className="masthead">
        <div className="masthead__title">
          Bodega {detail.session.bodega} · corte {detail.session.fechaCorte}
        </div>
        <div className="hint">
          {detail.session.itemCount} artículos · {detail.session.sourceName ?? 'sin nombre'}
        </div>
      </div>

      <SessionSettings detail={detail} api={api} onSaved={onReload} />

      <div className="panel">
        <div className="panel__title">
          Cobertura: {state.coverage.assigned} de {items.length}
        </div>
        <div className="panel__body">
          <div className="progressbar">
            <div
              className="progressbar__fill"
              style={{ width: `${(state.coverage.assigned / Math.max(1, items.length)) * 100}%` }}
            />
          </div>
          {state.huecos.length > 0 ? (
            <>
              <div className="hint">
                Sin asignar, por familia y por exposición — no por valor en libros: las 31 filas
                de fruta y verdura están en cero y valdrían nada en esa lista (DOMAIN.md §5).
              </div>
              <ul className="corrections">
                {state.huecos.map((hueco) => (
                  <li key={hueco.prefix}>
                    <strong>{plan.etiquetas[hueco.prefix] ?? hueco.prefix}</strong> — {hueco.rows}{' '}
                    filas, {formatMoneyShort(hueco.exposicion)} · {hueco.ejemplos.join(', ')}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="hint">Todos los artículos tienen dueño.</div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">Secciones</div>
        <div className="panel__body">
          {plan.sections.length === 0 && (
            <div className="hint">
              Todavía no hay secciones. Crea una y mete familias en ella, o reparte una familia
              grande en varias de una vez.
            </div>
          )}
          <table className="grid">
            <tbody>
              {plan.sections.map((section) => {
                const ids = Object.entries(plan.asignado)
                  .filter(([, id]) => id === section.id)
                  .map(([idarticulo]) => Number(idarticulo));
                return (
                  <tr key={section.id}>
                    <td>
                      <input
                        aria-label={`Nombre de la sección ${section.nombre}`}
                        className="readout__input"
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
                    </td>
                    <td>
                      <input
                        aria-label={`Contador de ${section.nombre}`}
                        className="readout__input"
                        placeholder="quién la cuenta"
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
                    </td>
                    <td className="num">{ids.length} art.</td>
                    <td className="num">{formatMoneyShort(exposureOf(items, ids))}</td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => addSection(`SECCIÓN ${plan.sections.length + 1}`)}
            >
              Nueva sección
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">
          {familias === null ? 'Artículos' : `Familias propuestas (${familias.length})`}
        </div>
        <div className="panel__body">
          {familias === null ? (
            <div className="hint">
              El catálogo no está numerado como para proponer familias — los códigos no miden
              todos siete caracteres, o casi todo cae en un solo grupo. Arma las secciones a mano
              con la lista de abajo.
            </div>
          ) : (
            <div className="hint">
              Un punto de partida, no una clasificación. Los dígitos 3 y 4 del código agrupan;
              los nombres los pones tú. La exposición manda sobre el valor en libros.
            </div>
          )}

          <ul className="rows">
            {(familias ?? [{ prefix: '', idarticulos: items.map((i) => i.idarticulo), rows: items.length, valor: 0, exposicion: 0, ejemplos: [] }]).map(
              (family) => (
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
                  onMove={(ids, sectionId) => setPlan((current) => move(current, ids, sectionId))}
                  onSplit={(parts) =>
                    setPlan((current) => {
                      const label = current.etiquetas[family.prefix] ?? family.prefix;
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
              ),
            )}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel__title">Despachar</div>
        <div className="panel__body">
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
              {countersIn(plan).length} contadores, {plan.sections.length} secciones, los{' '}
              {items.length} artículos repartidos. Al despachar se abre la sesión y se generan los
              enlaces; después no se agregan ni se cambian contadores.
            </div>
          )}
          {error && (
            <div className="banner" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
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
  onSplit,
}: {
  family: FamilyGroup;
  plan: Plan;
  items: readonly Item[];
  byId: Map<number, Item>;
  expanded: boolean;
  onExpand: () => void;
  onLabel: (label: string) => void;
  onMove: (ids: readonly number[], sectionId: string | null) => void;
  onSplit: (parts: number) => void;
}) {
  const [parts, setParts] = useState(2);
  const assigned = family.idarticulos.filter((id) => plan.asignado[id] !== undefined).length;

  return (
    <li className="row row--static">
      <div className="row__main">
        <div className="row__nombre">
          <input
            aria-label={`Nombre de la familia ${family.prefix}`}
            className="readout__input"
            value={plan.etiquetas[family.prefix] ?? ''}
            placeholder={family.prefix === '' ? 'todo el catálogo' : `familia ${family.prefix}`}
            onChange={(event) => onLabel(event.target.value)}
          />
        </div>
        <div className="row__meta">
          {family.rows} filas · {assigned} asignadas ·{' '}
          {formatMoneyShort(family.exposicion)} de exposición
          {family.ejemplos.length > 0 && <> · {family.ejemplos.slice(0, 3).join(', ')}</>}
        </div>
      </div>
      <div className="row__right">
        <select
          aria-label={`Mover la familia ${family.prefix}`}
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') return;
            onMove(family.idarticulos, value === '__ninguna' ? null : value);
            event.target.value = '';
          }}
        >
          <option value="">mover a…</option>
          {plan.sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.nombre}
            </option>
          ))}
          <option value="__ninguna">— sin asignar —</option>
        </select>
        <input
          aria-label={`Partes para la familia ${family.prefix}`}
          className="readout__input"
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
                        onMove([idarticulo], event.target.value === '' ? null : event.target.value)
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
 * be a toggle rather than a deploy (P2.1 §4d).
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
