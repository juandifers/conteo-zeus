// @vitest-environment jsdom
/**
 * The adapter between the service worker and the notice.
 *
 * Small enough to read, and worth pinning anyway, because the two things it
 * must not do are invisible until a tablet does them in a storeroom: take over
 * without being asked, and make failing update requests while offline or
 * hidden. The third thing it must do took a real afternoon to learn: keep
 * checking while a check is free, because a desk tab left open across four
 * deploys held the old build the whole time on its single launch check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noUpdates, RECHECK_MS, serviceWorkerUpdates, type RegisterSW } from '../../src/ui/updates';

/** A stand-in for `virtual:pwa-register`, whose callbacks the test fires. */
function fakeRegister() {
  const reload = vi.fn(async () => {});
  let options: Parameters<RegisterSW>[0] | null = null;
  const register: RegisterSW = (given) => {
    options = given;
    return reload;
  };
  return {
    register,
    reload,
    needRefresh: () => options?.onNeedRefresh?.(),
    registered: (registration: Partial<ServiceWorkerRegistration>) =>
      options?.onRegistered?.(registration as ServiceWorkerRegistration),
    get options() {
      return options;
    },
  };
}

describe('a waiting service worker', () => {
  it('reports nothing waiting until the worker says so', () => {
    const sw = fakeRegister();
    const updates = serviceWorkerUpdates(sw.register);
    const seen: boolean[] = [];
    updates.subscribe((waiting) => seen.push(waiting));
    expect(seen).toEqual([false]);
  });

  it('tells every subscriber once a new version is installed and waiting', () => {
    const sw = fakeRegister();
    const updates = serviceWorkerUpdates(sw.register);
    const seen: boolean[] = [];
    updates.subscribe((waiting) => seen.push(waiting));

    sw.needRefresh();

    expect(seen).toEqual([false, true]);
  });

  /**
   * A screen that mounts after the event still has to learn about it — the
   * counting screen is opened minutes after the app boots, and the worker does
   * not announce itself twice.
   */
  it('tells a late subscriber what it missed', () => {
    const sw = fakeRegister();
    const updates = serviceWorkerUpdates(sw.register);
    sw.needRefresh();

    const seen: boolean[] = [];
    updates.subscribe((waiting) => seen.push(waiting));
    expect(seen).toEqual([true]);
  });

  it('never reloads until somebody applies the update', async () => {
    const sw = fakeRegister();
    const updates = serviceWorkerUpdates(sw.register);
    sw.needRefresh();
    expect(sw.reload).not.toHaveBeenCalled();

    await updates.apply();

    expect(sw.reload).toHaveBeenCalledWith(true);
  });

  it('stops telling a subscriber that has unsubscribed', () => {
    const sw = fakeRegister();
    const updates = serviceWorkerUpdates(sw.register);
    const seen: boolean[] = [];
    const stop = updates.subscribe((waiting) => seen.push(waiting));
    stop();

    sw.needRefresh();

    expect(seen).toEqual([false]);
  });

  describe('when it checks for a new version', () => {
    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
    });

    const registered = () => {
      const sw = fakeRegister();
      const update = vi.fn(async () => {});
      serviceWorkerUpdates(sw.register);
      sw.registered({ update: update as unknown as ServiceWorkerRegistration['update'] });
      return { sw, update };
    };

    it('checks at launch', () => {
      const { sw, update } = registered();
      expect(update).toHaveBeenCalledTimes(1);
      expect(sw.options?.immediate).toBe(true);
    });

    it('checks again when the tab becomes visible and when the network returns', () => {
      // The desk's case: a tab left open across a deploy held the old build
      // forever on its single launch check. Coming back to the tab, or the
      // wifi coming back, is exactly when a check is free.
      const { update } = registered();
      document.dispatchEvent(new Event('visibilitychange'));
      globalThis.dispatchEvent(new Event('online'));
      expect(update).toHaveBeenCalledTimes(3);
    });

    it('keeps a slow clock while visible and online', () => {
      vi.useFakeTimers();
      const { update } = registered();
      vi.advanceTimersByTime(RECHECK_MS * 2);
      expect(update).toHaveBeenCalledTimes(3);
    });

    it('never checks while the tab is hidden', () => {
      // A hidden tab makes no requests at all — the tablet-in-a-storeroom
      // rationale survives the recheck: gates, not a blind timer.
      const { update } = registered();
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  it('survives a browser that registers nothing', () => {
    const sw = fakeRegister();
    serviceWorkerUpdates(sw.register);
    expect(() => sw.registered(undefined as never)).not.toThrow();
  });
});

describe('no service worker at all', () => {
  it('is a port that never fires and never reloads', async () => {
    const updates = noUpdates();
    const seen: boolean[] = [];
    updates.subscribe((waiting) => seen.push(waiting));
    await updates.apply();
    expect(seen).toEqual([]);
  });
});
