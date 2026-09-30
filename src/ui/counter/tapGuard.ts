/**
 * The second half of a double tap is not a decision.
 *
 * Every question on the counting screens — «¿está vacío?», «cantidad poco
 * común», «se sumará» — opens where the button that raised it was. With gloves,
 * a bounce, or a habit of double-tapping, the second tap lands on «Sí» before
 * anybody has read the question: measured on an 800×1280 layout, «Sí, es
 * correcta» sits under «Registrar 80.000» and «Sí, está vacío» under «Está
 * vacío». A question a finger can answer by accident is not a question.
 *
 * The same holds for the card itself: a double tap on a search result opens
 * the card and the second tap lands on whatever key is under the finger — a
 * stray «5» in front of «12» is 512.
 *
 * So a question refuses its «Sí» for a moment after it appears, and the keypad
 * refuses keys for a moment after the card opens. Human double taps are
 * 100–300 ms apart; reading a sentence takes longer than 400.
 *
 * `tapGuard` is a mutable object rather than constants so the jsdom suites,
 * which click faster than any person, can set it to zero for the tests that are
 * not about this — and hold the clock for the ones that are.
 */
import { useCallback, useRef } from 'react';

export const tapGuard = {
  /** How long a question's «Sí» ignores taps after the question appears. */
  confirmMs: 400,
  /** How long the keypad and presentation list ignore taps after the card opens. */
  openMs: 300,
  /** Monotonic milliseconds. Replaceable so a test can hold time still. */
  now: (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

function now(): number {
  return tapGuard.now();
}

/**
 * `arm()` when a question appears; `ready()` in its «Sí» handler.
 *
 * Starts armed at mount, so it also serves the card-opening case.
 */
export function useTapGuard(): { arm: () => void; ready: (ms: number) => boolean } {
  const armedAt = useRef<number>(now());
  const arm = useCallback(() => {
    armedAt.current = now();
  }, []);
  const ready = useCallback((ms: number) => now() - armedAt.current >= ms, []);
  return { arm, ready };
}
