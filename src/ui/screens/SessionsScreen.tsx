/**
 * Sessions, and the way in.
 *
 * A session is a Zeus export frozen at a cutoff; re-importing makes a new one
 * rather than mutating an old one (DOMAIN.md §6), so this list only ever grows
 * and each row is a snapshot somebody can still be held to.
 *
 * The empty state invites the import. There is nothing to apologise for on a
 * tablet that has never been used.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { importZeusBytes } from '../../app';
import { resolveAll, type CountRepository, type SessionMeta } from '../../domain';
import { loadUsuario, saveUsuario } from '../identity';

interface Progress extends SessionMeta {
  verificados: number;
}

export function SessionsScreen({
  repo,
  stranded,
  onOpen,
}: {
  repo: CountRepository;
  /** Events the boot replay could not push into the database. */
  stranded: number;
  onOpen: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<Progress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usuario, setUsuario] = useState(loadUsuario);
  const picker = useRef<HTMLInputElement>(null);

  /**
   * Read the list and, for each session, how far it has got.
   *
   * The progress figure comes from folding the log, not from a stored
   * counter: a count has exactly one source of truth and it is the events
   * (DOMAIN.md §3). A session's log is a few hundred rows.
   */
  const reload = useCallback(async (): Promise<Progress[]> => {
    const metas = await repo.listSessions();
    const rows = await Promise.all(
      metas.map(async (meta) => {
        const events = await repo.eventsForSession(meta.id);
        return { ...meta, verificados: resolveAll(events).size };
      }),
    );
    // Newest first: the count somebody is in the middle of is the one they want.
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows;
  }, [repo]);

  useEffect(() => {
    let live = true;
    reload().then(
      (rows) => {
        if (live) setSessions(rows);
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [reload]);

  async function importFile(file: File): Promise<void> {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The name travels with the session and becomes the default name of the
      // adjustment file at the other end: the hotel already has a habit for
      // what these files are called, and matching it is safer than teaching
      // them a convention of ours.
      const session = importZeusBytes(bytes, file.name);
      await repo.createSession(session);
      setSessions(await reload());
      onOpen(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="screen">
      <div className="masthead">
        <h1 className="masthead__title">conteo</h1>
        <label className="who">
          quién cuenta
          <input
            aria-label="quién cuenta"
            value={usuario}
            placeholder="nombre"
            onChange={(e) => {
              setUsuario(e.target.value);
              saveUsuario(e.target.value);
            }}
          />
        </label>
      </div>

      {stranded > 0 && (
        <div className="banner" role="alert">
          {stranded} registros de una sesión anterior siguen sin guardarse. Se
          reintentan cada vez que abres la aplicación.
        </div>
      )}

      {error && (
        <div className="banner" role="alert">
          No se pudo importar: {error}
        </div>
      )}

      <div className="scroll">
        {sessions === null ? null : sessions.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Trae un archivo de Zeus y empieza</div>
            <div className="empty__body">
              Exporta la bodega desde Zeus y ábrela aquí. El archivo puede ser el{' '}
              <span className="num">.txt</span> o el <span className="num">.xls</span>: los dos
              sirven.
            </div>
          </div>
        ) : (
          sessions.map((meta) => (
            <button
              type="button"
              key={meta.id}
              className="sessioncard"
              onClick={() => onOpen(meta.id)}
            >
              <span className="sessioncard__top">
                <span className="sessioncard__bodega">
                  Bodega <span className="num">{meta.bodega}</span>
                </span>
                <span className="num">{meta.fechaCorte}</span>
              </span>
              <span className="sessioncard__meta">
                <span>
                  <span className="num">{meta.itemCount}</span> artículos
                </span>
                <span>
                  <span className="num">{meta.verificados}</span> verificados
                </span>
              </span>
              <span className="progressbar">
                <span
                  className="progressbar__fill"
                  style={{ width: `${(meta.verificados / Math.max(1, meta.itemCount)) * 100}%` }}
                />
              </span>
            </button>
          ))
        )}
      </div>

      <div className="actions">
        <input
          ref={picker}
          type="file"
          accept=".txt,.xls,.xlsx"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => picker.current?.click()}
        >
          Importar archivo de Zeus
        </button>
      </div>
    </div>
  );
}
