/**
 * Where you are, how far you have got, and which zone you are stamping.
 *
 * The progress bar is one tone. It would be easy to split it into counted and
 * waived, and that would be the first crack in the rule that colour on this
 * screen means variance direction and nothing else. The breakdown lives on the
 * faltantes screen, in words.
 *
 * `verificados/total` stays on a screen that shows nothing else numeric
 * (DOMAIN.md §2.1): it counts the counter's own work, not anything the ERP
 * believes, and it is the one figure that says how much of the afternoon is
 * left.
 */
import { ZONAS } from '../identity';
import type { CountSnapshot } from '../store';

export function Topbar({
  snapshot,
  onZona,
  onBack,
}: {
  snapshot: CountSnapshot;
  onZona: (zona: string) => void;
  onBack: () => void;
}) {
  const { session, counts, zona, usuario } = snapshot;
  const verificados = counts.counted + counts.unchanged;
  const total = session.items.length;
  const zonas = ZONAS.includes(zona as (typeof ZONAS)[number]) ? ZONAS : [zona, ...ZONAS];

  return (
    <>
      <div className="topbar">
        <button type="button" className="entry__close" aria-label="sesiones" onClick={onBack}>
          ‹
        </button>
        <div className="topbar__where">
          <div className="topbar__bodega">
            Bodega <span className="num">{session.bodega}</span>
          </div>
          <div className="topbar__corte">
            corte <span className="num">{session.fechaCorte}</span>
          </div>
        </div>
        <div className="topbar__progress">
          <div className="topbar__count num">
            {verificados}/{total}
          </div>
          <div className="topbar__label">verificados</div>
        </div>
      </div>
      <div
        className="progressbar"
        role="progressbar"
        aria-valuenow={verificados}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="artículos verificados"
      >
        <div className="progressbar__fill" style={{ width: `${(verificados / total) * 100}%` }} />
      </div>
      <div className="zonabar">
        <label htmlFor="zona">Zona</label>
        <select id="zona" value={zona} onChange={(e) => onZona(e.target.value)}>
          {zonas.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="hint">cuenta {usuario || 'sin nombre'}</span>
      </div>
    </>
  );
}
