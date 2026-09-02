/**
 * Changing who counts what, while people are counting — P2.3.5.
 *
 * One screen for one operation. «Luis se fue enfermo», «metamos a Carla»,
 * «María nunca llegó» and «Ana que ayude con abarrotes» are all *reassigning
 * articles between counters while a session is open*, sometimes with a counter
 * created or retired alongside; four separate flows would be four partial
 * answers that disagree.
 *
 * ## The warning is the point
 *
 * §4b is a hole that cannot be closed, and this screen exists as much to say so
 * as to do anything. Luis is in the cold room with no signal; his articles are
 * reassigned to Pedro; his tablet does not know and **cannot** know, because
 * counter sync is push-only and there is no channel to a device down there. If
 * Pedro counts what Luis already counted, the fold sums both and the total is
 * wrong.
 *
 * Nothing in the software can prevent that — prevention means reaching an
 * unreachable device. What it can do is put the risk in front of the person at
 * the moment of the decision, name whose work is at stake and when they were
 * last heard from, and record the same list in the action payload so P2.4
 * reports an *explained* overlap rather than an anomaly. Operationally the
 * answer is a radio and a person: reassign when the counter can be told.
 *
 * ## What moves, and in what units
 *
 * Whole sections. The endpoint takes per-article moves and will honour them —
 * that is the primitive, and it is what the swap and the rebalance are both
 * built out of — but a section is the unit an admin actually thinks in, and it
 * is the unit that keeps `zona` meaningful: a section changing hands entire is
 * *repointed*, same name and same zone, so Pedro counting Luis's ALMACEN is
 * still standing in ALMACEN.
 *
 * ## The two things this screen will not do
 *
 * It will not retire somebody who still holds articles — retirement is not a way
 * to abandon coverage, so the move comes first — and it will not offer
 * `sellar_sin_registros` as an ordinary button. That one is an admin signing a
 * line that will be printed on the acta saying the count is missing a named
 * person's work; it is offered only for a retired counter whose chain the server
 * knows has a hole in it, and only after the screen has said that waiting for
 * the tablet is the right answer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionActionRecord, SellarSinRegistrosPayload } from '../../domain';
import { actaLines, handoverRisk } from '../../domain';
import type { Api } from '../api';
import { ApiError } from '../api';
import { formatInstant } from '../format';
import { loadSupervisor, saveSupervisor } from '../identity';
import { describeReassign, describeSeal } from './blockers';
import { counterLink } from './links';
import { counterWord, unos } from './vocabulario';
import type {
  AdminCounter,
  ReassignRefusal,
  ReassignResult,
  SessionDetail,
  SyncSnapshot,
} from './types';

const NEW_COUNTER = '__nuevo__';

/** The poll, plus **when** it arrived — see `risky` below on why the clock is state. */
interface Poll {
  snapshot: SyncSnapshot;
  at: string;
}

export function Cambios({
  detail,
  api,
  onReload,
}: {
  detail: SessionDetail;
  api: Api;
  onReload: () => void;
}) {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [usuario, setUsuario] = useState(loadSupervisor);
  const [motivo, setMotivo] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** Who is about to be retired, while the screen asks for the free upgrade (§6a). */
  const [retirando, setRetirando] = useState<AdminCounter | null>(null);
  const [done, setDone] = useState<ReassignResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<SyncSnapshot>(`/api/sessions/${detail.session.id}/sync`)
      // The clock is read here, not during render: «how long since Luis synced»
      // is a fact about the moment this answer arrived, and reading it while
      // rendering makes the same tree draw differently on every pass.
      .then((snapshot) => setPoll({ snapshot, at: new Date().toISOString() }))
      .catch(() => setPoll(null));
  }, [api, detail.session.id]);

  useEffect(load, [load]);
  const sync = poll?.snapshot ?? null;

  const nombres = useMemo(
    () => new Map(detail.counters.map((counter) => [counter.id, counter.nombre])),
    [detail.counters],
  );
  const holding = useCallback(
    (counterId: string) =>
      detail.assignments.filter((assignment) => assignment.counterId === counterId).length,
    [detail.assignments],
  );
  const sectionsOf = useCallback(
    (counterId: string) => detail.sections.filter((section) => section.counterId === counterId),
    [detail.sections],
  );

  // No sections means a shared session (P2.6): there is no partition to move,
  // so «metamos a Carla» is its own action and the reassignment panel is gone.
  const compartido = detail.sections.length === 0;
  const activos = detail.counters.filter((counter) => counter.estado !== 'retirado');
  const source = detail.counters.find((counter) => counter.id === from) ?? null;
  const mine = source ? sectionsOf(source.id) : [];

  /** The moves the chosen sections come to, per article. */
  const moves = useMemo(() => {
    const wanted = new Set(chosen);
    return detail.assignments
      .filter((assignment) => wanted.has(assignment.sectionId))
      .map((assignment) => ({
        idarticulo: assignment.idarticulo,
        from: assignment.counterId,
        to: to === NEW_COUNTER ? 'nuevo' : to,
      }));
  }, [chosen, detail.assignments, to]);

  /**
   * Whose tablet has not been heard from lately (§4b).
   *
   * Computed here as well as on the server so the sentence appears *before* the
   * button is pressed. The server computes it again at the moment of the write
   * and records that version, because the two can differ by however long the
   * admin spent reading this.
   */
  const risky =
    source && poll && moves.length > 0
      ? // The same function the endpoint runs, so the sentence on this screen and
        // the list recorded in the action payload cannot drift apart. Not
        // memoised: it is a filter over a handful of counters, and the clock it
        // compares against is state rather than a read during render.
        (handoverRisk({
          counters: poll.snapshot.counters.map((counter) => ({
            id: counter.id,
            nombre: counter.nombre,
            lastServerAt: counter.lastServerAt,
          })),
          moves,
          now: poll.at,
        })[0] ?? null)
      : null;

  async function send(body: unknown, onOk: (result: unknown) => void): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      onOk(await api.post(`/api/sessions/${detail.session.id}/acciones`, body));
      load();
      onReload();
    } catch (cause) {
      setProblem(refusalText(cause, nombres));
    } finally {
      setBusy(false);
    }
  }

  const reasignar = () =>
    void send(
      {
        kind: 'reasignar',
        usuario,
        motivo,
        version: detail.session.assignmentsVersion,
        moves,
        ...(to === NEW_COUNTER
          ? { nuevos: [{ ref: 'nuevo', nombre: nuevoNombre }] }
          : {}),
      },
      (result) => {
        saveSupervisor(usuario);
        setDone(result as ReassignResult);
        setChosen([]);
        setMotivo('');
        setNuevoNombre('');
      },
    );

  const agregar = () =>
    void send(
      { kind: 'agregar_contador', usuario, motivo, nombre: nuevoNombre },
      (result) => {
        saveSupervisor(usuario);
        const counter = result as { id: string; nombre: string; token: string };
        setDone({
          assignmentsVersion: detail.session.assignmentsVersion,
          movidos: 0,
          seccionesCreadas: [],
          seccionesReapuntadas: [],
          sinSincronizar: [],
          nuevos: [counter],
        });
        setMotivo('');
        setNuevoNombre('');
      },
    );

  const retirar = (counter: AdminCounter) =>
    void send(
      { kind: 'retirar_contador', usuario, motivo, counterId: counter.id },
      () => {
        saveSupervisor(usuario);
        setMotivo('');
        setRetirando(null);
      },
    );

  const sellarSin = (counter: AdminCounter) =>
    void send(
      { kind: 'sellar_sin_registros', usuario, motivo, counterId: counter.id },
      () => {
        saveSupervisor(usuario);
        setMotivo('');
      },
    );

  const ready = usuario.trim() !== '' && motivo.trim() !== '';
  // Every action below is gated on the signature fields, which live in their
  // own card above — a disabled button two panels away from the reason it is
  // disabled reads as broken (reported 2026-09-02: «agregar y generar enlace
  // is not responsive»). Same discipline as the Sellar button (§4.3): a gate
  // says what opens it.
  const firmaHint = ready ? null : (
    <div className="hint">Desactivado hasta llenar «Quién decide» y «Motivo», arriba.</div>
  );
  const overrides = new Map(
    (sync?.acciones ?? [])
      .filter((action) => action.kind === 'sellar_sin_registros')
      .map((action) => [
        (action.payload as SellarSinRegistrosPayload).counterId,
        action.payload as SellarSinRegistrosPayload,
      ]),
  );

  return (
    <>
      <div className="panel">
        <div className="panel__title">Cambios durante el conteo</div>
        <div className="panel__body">
          <div className="hint">
            Todo lo de aquí queda firmado con tu nombre y tu motivo, y sale en el acta.
          </div>
          <label className="field__label" htmlFor="cambios-usuario">
            Quién decide
          </label>
          <input
            id="cambios-usuario"
            className="field"
            value={usuario}
            onChange={(event) => setUsuario(event.target.value)}
            placeholder="tu nombre"
          />
          <label className="field__label" htmlFor="cambios-motivo">
            Motivo
          </label>
          <input
            id="cambios-motivo"
            className="field"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
            placeholder="Luis se fue enfermo"
          />
        </div>
      </div>

      {problem && (
        <div className="banner" role="alert">
          {problem}
        </div>
      )}

      {compartido && (
        <div className="panel">
          <div className="panel__title">Agregar contador</div>
          <div className="panel__body">
            <label className="field__label" htmlFor="cambios-agregar">
              Nombre
            </label>
            <input
              id="cambios-agregar"
              className="field"
              value={nuevoNombre}
              onChange={(event) => setNuevoNombre(event.target.value)}
              placeholder="Carla"
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !ready || nuevoNombre.trim() === ''}
              onClick={agregar}
            >
              Agregar y generar enlace
            </button>
            {firmaHint}
          </div>
        </div>
      )}

      {!compartido && (
      <div className="panel">
        <div className="panel__title">Mover secciones</div>
        <div className="panel__body">
          <label className="field__label" htmlFor="cambios-from">
            De
          </label>
          <select
            id="cambios-from"
            className="field"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setChosen([]);
            }}
          >
            <option value="">…</option>
            {activos.map((counter) => (
              <option key={counter.id} value={counter.id}>
                {`${counter.nombre} · ${holding(counter.id)} artículos`}
              </option>
            ))}
          </select>

          {risky && (
            // §4b, said in words and before the button. This is the one warning
            // on the screen that is not about something the software can fix.
            <div className="banner" role="alert">
              {risky.lastServerAt === null
                ? `${risky.nombre} no ha sincronizado nada todavía. Los artículos que ` +
                  'reasignes pueden ser contados dos veces, y nada en el sistema puede ' +
                  'evitarlo: su tableta no se entera. Avísale antes de mover.'
                : `${risky.nombre} no ha sincronizado desde ${formatInstant(risky.lastServerAt)}. ` +
                  'Los artículos que reasignes pueden ser contados dos veces, y nada en el ' +
                  'sistema puede evitarlo: su tableta no se entera. Avísale antes de mover.'}
            </div>
          )}

          {mine.length > 0 && (
            <ul className="checklist">
              {mine.map((section) => {
                const rows = detail.assignments.filter(
                  (assignment) => assignment.sectionId === section.id,
                ).length;
                return (
                  <li className="checkrow" key={section.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen.includes(section.id)}
                        onChange={(event) =>
                          setChosen((current) =>
                            event.target.checked
                              ? [...current, section.id]
                              : current.filter((id) => id !== section.id),
                          )
                        }
                      />{' '}
                      {section.nombre}
                    </label>
                    <span className="num">{rows}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <label className="field__label" htmlFor="cambios-to">
            A
          </label>
          <select
            id="cambios-to"
            className="field"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            <option value="">…</option>
            {activos
              .filter((counter) => counter.id !== from)
              .map((counter) => (
                <option key={counter.id} value={counter.id}>
                  {counter.nombre}
                </option>
              ))}
            <option value={NEW_COUNTER}>alguien nuevo…</option>
          </select>

          {to === NEW_COUNTER && (
            <>
              <label className="field__label" htmlFor="cambios-nuevo">
                Nombre del contador nuevo
              </label>
              <input
                id="cambios-nuevo"
                className="field"
                value={nuevoNombre}
                onChange={(event) => setNuevoNombre(event.target.value)}
                placeholder="Carla"
              />
              <div className="hint">
                {/* P2.1 leaves nothing unassigned, so a new counter cannot arrive
                    empty-handed: the link and the work are minted together. */}
                Se crea con su propio enlace y hoja imprimible, en la misma operación que le
                entrega estas secciones.
              </div>
            </>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !ready || moves.length === 0 || to === '' || (to === NEW_COUNTER && nuevoNombre.trim() === '')}
            onClick={reasignar}
          >
            {`Mover ${moves.length} artículos`}
          </button>
          {firmaHint}
        </div>
      </div>
      )}

      {done && (
        <div className="panel">
          <div className="panel__title">Listo</div>
          <div className="panel__body">
            {done.movidos > 0 && <div className="hint">{`Se movieron ${done.movidos} artículos.`}</div>}
            {done.movidos === 0 && done.nuevos.length > 0 && (
              // §5.2: the wifi paragraph compressed to the one line that
              // matters, attached to the link it is about.
              <div className="hint">Ábrelo con wifi antes de entrar a la bodega.</div>
            )}
            {done.sinSincronizar.length > 0 && (
              <div className="banner" role="alert">
                {`Quedó registrado que ${done.sinSincronizar
                  .map((risk) => risk.nombre)
                  .join(', ')} no había sincronizado. Si alcanzó a contar algo de lo que ` +
                  'moviste, va a aparecer como conteo doble en la revisión — y ahí se sabrá ' +
                  'por qué.'}
              </div>
            )}
            {done.nuevos.map((counter) => (
              <div key={counter.id}>
                <div className="row__nombre">{counter.nombre}</div>
                <code className="sheet__link">{counterLink(counter.token)}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {retirando && (
        /*
         * P2.4 §6a — ask for the free upgrade before taking the weaker one.
         *
         * A retired counter's chain is verified by **contiguity**: no hole
         * between 1 and the highest seq the server holds. That cannot see a
         * missing tail — a tablet holding 61 to 83 and nothing after leaves a
         * chain that looks complete — and only a `finish` manifest can. Ten
         * seconds of somebody's time converts one into the other, so the screen
         * asks for it rather than quietly settling for the weaker evidence.
         *
         * Retirement is the path for a tablet that already left, not the default
         * for a person walking out of the door.
         */
        <div className="panel">
          <div className="panel__title">{`Retirar a ${retirando.nombre}`}</div>
          <div className="panel__body">
            <div className="banner" role="alert">
              <div>
                <strong>¿Tienes la tableta a mano?</strong> Pídele que toque
                «Terminar» antes de irse. Son diez segundos y cambian lo que el
                acta puede afirmar: con «Terminar» su tableta declara cuánto
                registró en total, y el servidor puede comprobar que llegó todo;
                sin eso, un tramo final que no alcanzó a subir no se detecta.
              </div>
            </div>
            <div className="hint">
              <strong>Retirar no tiene vuelta atrás.</strong> Si vuelve a las dos
              de la tarde, entra como contador nuevo, con enlace nuevo y registro
              aparte; lo de la mañana se queda con su identidad anterior y los dos
              salen en el acta.
            </div>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !ready}
              onClick={() => retirar(retirando)}
            >
              {`Sí, retirar a ${retirando.nombre}`}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => setRetirando(null)}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel__title">Contadores</div>
        {firmaHint && <div className="panel__body">{firmaHint}</div>}
        <ul className="rows">
          {detail.counters.map((counter) => {
            const row = sync?.counters.find((entry) => entry.id === counter.id);
            const held = holding(counter.id);
            const retirado = counter.estado === 'retirado';
            const override = overrides.get(counter.id);
            return (
              <li className="row row--static" key={counter.id}>
                <div className="row__main">
                  {/* One string, not two nodes: a sentence assembled out of JSX
                      expressions renders as separate text nodes, which reads the
                      same and is a different thing to anything querying by text. */}
                  <div className="row__nombre">{`${counter.nombre} · ${counterWord(counter.estado)}`}</div>
                  <div className="row__meta">
                    {`${compartido ? 'todo el catálogo' : `${held} artículos`} · ${unos(row?.storedMaxSeq ?? 0, 'registro')}`}
                    {row?.lastServerAt ? ` · visto ${formatInstant(row.lastServerAt)}` : ' · sin sincronizar'}
                    {row && !row.chainComplete && ' · faltan registros suyos'}
                  </div>
                  {override && (
                    <div className="row__meta">{`sellado sin sus registros: faltan ${override.faltan}`}</div>
                  )}
                </div>
                <div className="corrections">
                  {!retirado && (
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-label={`retirar a ${counter.nombre}`}
                      disabled={busy || !ready || held > 0}
                      onClick={() => setRetirando(counter)}
                    >
                      Retirar
                    </button>
                  )}
                  {retirado && row && !row.chainComplete && !override && (
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-label={`sellar sin los registros de ${counter.nombre}`}
                      disabled={busy || !ready}
                      onClick={() => sellarSin(counter)}
                    >
                      Sellar sin sus registros
                    </button>
                  )}
                </div>
                {!retirado && held > 0 && (
                  <div className="hint">
                    Todavía tiene {held} artículos. Reasígnalos antes de retirarlo: retirar no
                    es una forma de dejar estantes sin dueño.
                  </div>
                )}
                {retirado && row && !row.chainComplete && !override && (
                  <div className="hint">
                    Al servidor le faltan registros suyos. Lo correcto es esperar la tableta;
                    «sellar sin sus registros» deja escrito en el acta, con tu nombre, que este
                    conteo va incompleto.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* The routine «Para poder sellar» list is the Monitor's, a few panels up
          on this same tab; repeating all of it here taught people to read
          neither copy. What *is* repeated — on purpose, in a second voice — is
          the one blocker this screen's own gravest action answers: a retired
          counter whose records are missing, which is the line
          «sellar sin sus registros» would put in the acta. */}
      {sync &&
        (() => {
          const graves = sync.session.readyToSeal.filter(
            (blocker) => blocker.kind === 'contador-retirado-incompleto',
          );
          if (graves.length === 0) return null;
          return (
            <div className="panel">
              <div className="panel__title">Para poder sellar</div>
              <div className="panel__body">
                <ul className="checklist">
                  {graves.map((blocker, index) => (
                    <li className="checkrow" key={index}>
                      <span>{describeSeal(blocker)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })()}

      <Bitacora acciones={sync?.acciones ?? []} />
    </>
  );
}

/**
 * The admin's own log, in the words the acta will print.
 *
 * `actaLines` rather than a second rendering: the sentence somebody signs and
 * the sentence on this screen have to be the same sentence, or the screen is a
 * summary of a document nobody read.
 */
function Bitacora({ acciones }: { acciones: readonly SessionActionRecord[] }) {
  if (acciones.length === 0) return null;
  return (
    <div className="panel">
      <div className="panel__title">Bitácora del conteo</div>
      <ul className="rows">
        {actaLines(acciones).map((line, index) => (
          <li className="row row--static" key={acciones[index]?.id ?? index}>
            <div className="row__main">
              <div className="row__nombre">{line}</div>
              <div className="row__meta">{formatInstant(acciones[index].serverAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A refusal, turned back into the list of sentences it came from. */
function refusalText(cause: unknown, nombres: Map<string, string>): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const detalle = cause.detalle as ReassignRefusal | null;
  if (detalle?.blockers && detalle.blockers.length > 0) {
    return detalle.blockers
      .map((blocker) => describeReassign(blocker, { counters: nombres }))
      .join(' ');
  }
  return cause.message;
}
