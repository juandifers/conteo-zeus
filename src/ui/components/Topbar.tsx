/**
 * Where you are, and how far you have got.
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
import type { CountSnapshot } from '../store';

export function Topbar({ snapshot, onBack }: { snapshot: CountSnapshot; onBack: () => void }) {
  const { session, counts, usuario } = snapshot;
  const verificados = counts.counted + counts.unchanged;
  const total = session.items.length;

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
      {/*
        The zone picker was here. It is gone rather than hidden (P2.3): a zone
        somebody chooses from a list is a claim, and the only zone this app now
        recognises is the one the admin committed to at dispatch.
      */}
      <div className="who">cuenta {usuario || 'sin nombre'}</div>
    </>
  );
}
