/**
 * One writer per counter on a device.
 *
 * A counter's chain lives in one IndexedDB and advances in memory, tap by tap
 * (`CountStore.build`). Two tabs — or the installed app's window and a Chrome
 * tab, which share that database — each hold their own `seq` and head. The
 * older one writes a `seq` the newer one already used, the write is refused,
 * and what follows chains onto an event that is not on disk. Measured before
 * this existed: one entry silently lost, the local chain broken at that point,
 * every push refused from then on, and the admin seeing only «sin señal».
 *
 * The Web Locks API is exactly the primitive: one named lock per origin,
 * shared across tabs and windows of one browser profile, released by the
 * browser when the tab dies. The screen that does not get it does not boot the
 * store at all, so it cannot write, and says why.
 *
 * It cannot see a *different* browser (a QR app's WebView, Samsung Internet):
 * that is a different database, and the server's device binding is what names
 * that case (`DEVICE_COLLISION`).
 */
import { useEffect, useState } from 'react';

export type CounterLock = 'pending' | 'held' | 'busy' | 'unsupported';

/** The slice of `navigator.locks` this needs, so a test can pass its own. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

export function lockName(counterId: string): string {
  return `conteo:contador:${counterId}`;
}

export function useCounterLock(
  counterId: string | null,
  attempt: number,
  locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike } | undefined)
    ?.locks,
): CounterLock {
  const [state, setState] = useState<CounterLock>('pending');

  useEffect(() => {
    if (counterId === null) return;
    if (!locks || typeof locks.request !== 'function') {
      // No Web Locks (an old WebView, jsdom): nothing to coordinate with, and
      // refusing to count would be worse than the case this guards.
      setState('unsupported');
      return;
    }
    let alive = true;
    let release: () => void = () => {};
    const heldUntil = new Promise<void>((resolve) => {
      release = resolve;
    });
    setState('pending');
    locks
      .request(lockName(counterId), { ifAvailable: true }, async (lock) => {
        if (!alive) return;
        if (!lock) {
          setState('busy');
          return;
        }
        setState('held');
        // Held for as long as this screen is mounted.
        await heldUntil;
      })
      .catch(() => {
        if (alive) setState('unsupported');
      });
    return () => {
      alive = false;
      release();
    };
  }, [counterId, attempt, locks]);

  return counterId === null ? 'pending' : state;
}
