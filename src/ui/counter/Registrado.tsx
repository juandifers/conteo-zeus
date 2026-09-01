/**
 * The neutral checkmark, in one place.
 *
 * It is the *only* thing a counting surface may say about an article besides
 * its name, code and presentation (DOMAIN.md §2.1): **presence, never
 * magnitude**. Binary — no count, no colour ramp, no ordering by it. A badge
 * reading «3 registros» would be a magnitude, because entry counts correlate
 * with how big a stack is.
 *
 * It renders in three places (search rows, the entry card, the presentations
 * list) and is one component because the alternative is three spellings of a
 * rule, and rules with three spellings acquire a fourth.
 *
 * ## Why there are two labels
 *
 * Since P2.3.5 the mark can mean two different things, and they are different
 * facts about the shelf:
 *
 *   - **you registered something here** — your own work, from your own log;
 *   - **somebody else did** — an article you inherited at a handover, from the
 *     assignment payload's `yaRegistrados` (§6b).
 *
 * The glyph is the same because the counter's next action is the same, and the
 * label differs because a screen reader saying «ya registraste algo aquí» about
 * Luis's shelf is telling somebody they did something they did not do. Neither
 * label carries a number, which is the property that matters.
 */
export function Registrado({
  propio,
  heredado,
}: {
  /** This counter has something standing against the article. */
  propio: boolean;
  /** Somebody else had, when this device fetched its assignment. */
  heredado: boolean;
}) {
  if (!propio && !heredado) return null;
  return (
    <span
      className="chip chip--counted"
      aria-label={propio ? 'ya registraste algo aquí' : 'otra persona ya registró aquí'}
    >
      ✓
    </span>
  );
}
