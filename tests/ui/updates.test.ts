/**
 * The adapter between the service worker and the notice.
 *
 * Small enough to read, and worth pinning anyway, because the two things it
 * must not do are invisible until a tablet does them in a storeroom: take over
 * without being asked, and poll for updates on a timer while offline.
 */
import { describe, expect, it, vi } from 'vitest';
import { noUpdates, serviceWorkerUpdates, type RegisterSW } from '../../src/ui/updates';

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

  /**
   * Checked once, at launch. A `setInterval` on a tablet that is offline all
   * afternoon spends the afternoon failing, and a notice that arrives mid-count
   * is a notice nobody can act on anyway.
   */
  it('checks for a new version at launch, and sets no timer', () => {
    const sw = fakeRegister();
    const update = vi.fn(async () => {});
    serviceWorkerUpdates(sw.register);
    sw.registered({ update: update as unknown as ServiceWorkerRegistration['update'] });

    expect(update).toHaveBeenCalledTimes(1);
    expect(sw.options?.immediate).toBe(true);
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
