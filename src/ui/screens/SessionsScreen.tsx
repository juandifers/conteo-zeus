/**
 * Sessions, and the way in.
 *
 * A session is a Zeus export frozen at a cutoff; re-importing makes a new one
 * rather than mutating an old one (DOMAIN.md §6), so this list only ever grows
 * and each row is a snapshot somebody can still be held to.
 *
 * The empty state invites the import. There is nothing to apologise for on a
 * tablet that has never been used.
 *
 * It is also where everything about *the tablet* lives, as opposed to the
 * count: whether the browser has promised to keep the database, how full it
 * is, which build this is, the install offer and the debug export. None of it
 * belongs on the counting screen — a person mid-shelf can act on none of it —
 * and all of it is worth seeing before a count starts rather than after one is
 * lost.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { importZeusBytes } from '../../app';
import { resolveAll, type CountRepository, type SessionMeta } from '../../domain';
import { BUILD, buildLabel } from '../build';
import { debugExportName, encodeCsv, eventLogCsv, type SessionLog } from '../debugExport';
import type { Downloader } from '../download';
import { loadUsuario, saveUsuario } from '../identity';
import type { Install } from '../install';
import { describeSpace, spaceIsTight, type StorageReport } from '../storage';

interface Progress extends SessionMeta {
  verificados: number;
}

export function SessionsScreen({
  repo,
  stranded,
  storage,
  install,
  download,
  onOpen,
}: {
  repo: CountRepository;
  /** Events the boot replay could not push into the database. */
  stranded: number;
  /** What the browser promised about the database, and how full it is. */
  storage: StorageReport;
  install: Install;
  download: Downloader;
  onOpen: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<Progress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usuario, setUsuario] = useState(loadUsuario);
  const [offered, setOffered] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => install.subscribe(setOffered), [install]);

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
        // Items whose events resolve to something, which is not the same as
        // items that *have* events: a retraction leaves its log behind and
        // returns the item to `untouched` (DOMAIN.md §3), so the size of the
        // map counts a row nobody has counted. The counting screen's header
        // tallies states, and two figures on two screens naming the same thing
        // differently is worse than either of them being wrong.
        let verificados = 0;
        for (const resolution of resolveAll(events).values()) {
          if (resolution.state !== 'untouched') verificados++;
        }
        return { ...meta, verificados };
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
      setError(`No se pudo importar: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /**
   * Every event on this tablet, as a spreadsheet (debugExport.ts).
   *
   * Reads the sessions and their logs afresh rather than reusing the list
   * above, which carries counts and not events. A tablet holds a handful of
   * sessions of a few hundred events; this is a button somebody presses once
   * at the end of a pilot day.
   */
  async function exportLog(): Promise<void> {
    setError(null);
    try {
      const metas = await repo.listSessions();
      const logs: SessionLog[] = await Promise.all(
        metas.map(async (meta) => ({
          sessionId: meta.id,
          bodega: meta.bodega,
          fechaCorte: meta.fechaCorte,
          items: await repo.itemsForSession(meta.id),
          events: await repo.eventsForSession(meta.id),
        })),
      );
      const day = new Date().toISOString().slice(0, 10);
      download.save(debugExportName(day), encodeCsv(eventLogCsv(logs)));
    } catch (cause) {
      setError(
        `No se pudo exportar el registro: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const space = describeSpace(storage);

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

      {spaceIsTight(storage) && (
        <div className="banner" role="status">
          La tableta está casi llena{space && <> ({space})</>}. Libera espacio antes de
          empezar un conteo.
        </div>
      )}

      {error && (
        <div className="banner" role="alert">
          {error}
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

        {/*
          The tablet's own state, at the bottom of the list rather than the top.
          It is read once when something has gone wrong or when a tester is
          asked which build they are on — never during a count.
        */}
        <div className="colofon">
          <div className="colofon__row">
            <span>almacenamiento</span>
            <span className="num">
              {storage.persistence === 'granted' ? 'protegido' : 'sin garantía'}
              {space && <> · {space}</>}
            </span>
          </div>
          <div className="colofon__row">
            <span>versión</span>
            <span className="num">{buildLabel(BUILD)}</span>
          </div>
          <button type="button" className="btn btn--waiver" onClick={() => void exportLog()}>
            Exportar registro de actividad
          </button>
        </div>
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
        {/*
          Only when the browser has an install to offer — which it does not once
          the app is installed, and never in a browser that does not support it.
          A button that explains it cannot do the thing it names is worse than
          no button.
        */}
        {offered && (
          <button type="button" className="btn btn--small" onClick={() => void install.prompt()}>
            Instalar en la tableta
          </button>
        )}
      </div>
    </div>
  );
}
