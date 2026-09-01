/**
 * Upload a Zeus export and create a draft session.
 *
 * The file is parsed **here, in the browser, before anything is sent**. Not as
 * an optimisation: the two integrity checks in ZEUS_FORMAT.md §4.1 refuse
 * rather than warn, and the person holding the file needs to be told what is
 * wrong with it while they are still standing in front of Zeus and can export
 * it again. On refusal nothing is sent, no session exists, and there is nothing
 * to undo.
 *
 * There is no override. A count taken against a sheared file posts quantities
 * to the wrong articles, it cannot be un-uploaded, and the person who would see
 * a warning at six on cutoff day is the person least placed to judge it.
 */
import { useCallback, useRef, useState } from 'react';

import { CatalogueError, ingestZeusBytes, toWire, type CatalogueFault } from '../../app';
import { toBase64 } from '../../lib/base64';
import { ApiError, type Api } from '../api';

type Phase =
  | { name: 'idle' }
  | { name: 'reading'; file: string }
  | { name: 'refused'; message: string; faults: readonly CatalogueFault[]; detalle?: unknown }
  | { name: 'sending'; file: string; rows: number };

export function ImportPanel({
  api,
  onCreated,
}: {
  api: Api;
  onCreated: (sessionId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [nombre, setNombre] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    async (file: File) => {
      setPhase({ name: 'reading', file: file.name });
      const bytes = new Uint8Array(await file.arrayBuffer());

      let ingested;
      try {
        ingested = ingestZeusBytes(bytes);
      } catch (cause) {
        setPhase({
          name: 'refused',
          message: cause instanceof Error ? cause.message : String(cause),
          faults: cause instanceof CatalogueError ? cause.faults : [],
        });
        return;
      }

      setPhase({ name: 'sending', file: file.name, rows: ingested.rows.length });
      try {
        const body = await api.post<{ id: string }>('/api/sessions', {
          sourceBytesBase64: toBase64(bytes),
          sourceName: file.name,
          nombre: nombre.trim() === '' ? undefined : nombre.trim(),
          // The server parses the same bytes and compares. Sending our reading
          // is what lets a cached build be *caught* rather than trusted.
          rows: ingested.rows.map(toWire),
        });
        onCreated(body.id);
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        setPhase({
          name: 'refused',
          message: api?.message ?? String(cause),
          faults:
            (api?.detalle as { faults?: CatalogueFault[] } | null)?.faults ?? [],
          detalle: api?.detalle,
        });
      }
    },
    [api, nombre, onCreated],
  );

  const differences = (phase.name === 'refused' ? phase.detalle : null) as
    | { differences?: string[] }
    | null;

  return (
    <div className="panel">
      <div className="panel__title">Nueva sesión</div>
      <div className="panel__body">
        <label className="field">
          <span className="field__label">Nombre (opcional)</span>
          <input
            className="tinput"
            value={nombre}
            placeholder="Corte de abril"
            onChange={(event) => setNombre(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Archivo exportado de Zeus (.xls o .txt)</span>
          <input
            ref={input}
            type="file"
            accept=".xls,.xlsx,.txt"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file twice fires again — which is
              // exactly what somebody does after re-exporting it from Zeus.
              event.target.value = '';
              if (file) void take(file);
            }}
          />
        </label>
        <div className="hint">
          El archivo se revisa aquí mismo. Si pasa, la sesión queda creada como borrador y
          sigues a repartir la bodega; si no, no queda nada.
        </div>

        {phase.name === 'reading' && <div className="hint">Leyendo «{phase.file}»…</div>}
        {phase.name === 'sending' && (
          <div className="hint">
            Subiendo «{phase.file}»: {phase.rows} filas.
          </div>
        )}

        {phase.name === 'refused' && (
          <div className="banner" role="alert">
            <div>{phase.message}</div>
            {phase.faults.length > 0 && (
              <ul className="corrections">
                {/* The first few, with what the rows actually say. A count of
                    faults is not something anybody can act on. */}
                {phase.faults.slice(0, 6).map((fault) => (
                  <li key={`${fault.kind}:${fault.key}`}>
                    <strong>{fault.key}</strong>: {fault.values.map((v) => `«${v}»`).join(', ')}
                  </li>
                ))}
                {phase.faults.length > 6 && <li>y {phase.faults.length - 6} más</li>}
              </ul>
            )}
            {differences?.differences && (
              <ul className="corrections">
                {differences.differences.map((difference) => (
                  <li key={difference}>{difference}</li>
                ))}
              </ul>
            )}
            <div className="hint">No se creó ninguna sesión.</div>
          </div>
        )}
      </div>
    </div>
  );
}
