/**
 * A new version, waiting until somebody applies it.
 *
 * The service worker is registered with `registerType: 'prompt'`, so a new
 * build installs itself and then *stops*, holding at `waiting`. It takes over
 * only when this module tells it to — the screen blocks (UpdateNotice.tsx)
 * until somebody taps «Actualizar», and the reload happens at a moment a
 * person chose. The alternative — `autoUpdate` — reloads the page out from
 * under whoever is holding the tablet, with no sentence on screen saying why;
 * a tablet that restarts itself unannounced is a tablet people stop trusting
 * long before they can say why.
 *
 * `registerSW` is passed in rather than imported. It comes from a virtual
 * module that only exists inside a Vite build, so importing it here would put
 * a build-time artefact in the middle of a unit-tested module; injecting it
 * keeps this file honest under Vitest and keeps the virtual import in
 * main.tsx, which no test loads.
 */

export interface Updates {
  /**
   * Called with `true` once a new version is installed and waiting. Returns an
   * unsubscribe, and calls the listener immediately with the current answer so
   * a screen mounted after the event still sees it.
   */
  subscribe(listener: (waiting: boolean) => void): () => void;
  /** Hand over to the waiting version and reload. Nothing else reloads. */
  apply(): Promise<void>;
}

/** The shape of `registerSW` from `virtual:pwa-register`. */
export type RegisterSW = (options: {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void>;

/**
 * No worker, nothing to update — the answer under Vitest and in `vite dev`.
 *
 * A real object rather than an optional dependency, so every screen has one
 * code path and the notice is simply a thing that never fires.
 */
export function noUpdates(): Updates {
  return {
    subscribe: () => () => {},
    apply: async () => {},
  };
}

/** How often an open, visible, online tab asks whether a new build exists. */
export const RECHECK_MS = 10 * 60_000;

/** What `apply` needs from the page, injectable so a test can watch it. */
export interface ReloadHooks {
  reload?: () => void;
  onControllerChange?: (fn: () => void) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
}

/** How long `apply` waits for the new worker to take over before reloading anyway. */
export const APPLY_FALLBACK_MS = 4_000;

export function serviceWorkerUpdates(register: RegisterSW, hooks: ReloadHooks = {}): Updates {
  const reload = hooks.reload ?? (() => globalThis.location?.reload());
  const onControllerChange =
    hooks.onControllerChange ??
    ((fn: () => void) =>
      globalThis.navigator?.serviceWorker?.addEventListener('controllerchange', fn, { once: true }));
  const schedule = hooks.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let waiting = false;
  const listeners = new Set<(waiting: boolean) => void>();

  const announce = () => {
    for (const listener of listeners) listener(waiting);
  };

  const updateSW = register({
    immediate: true,
    onNeedRefresh() {
      waiting = true;
      announce();
    },
    onRegistered(registration) {
      if (!registration) return;
      // Checked at launch, and again whenever a check is *free*: the tab
      // becoming visible, the network coming back, and a slow clock while
      // both hold. The gates are the point — a tablet offline in a storeroom
      // makes no failing requests, and a hidden tab makes none at all. What
      // this buys is the desk: an admin's tab left open across a deploy used
      // to hold the old build forever, because its one launch-time check had
      // already happened (2026-09-02, four deploys invisible in a row).
      const check = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        registration.update().catch(() => {
          // Offline after all, or the server is unreachable. The next
          // visibility or online event asks again; nothing to surface.
        });
      };
      check();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', check);
      }
      globalThis.addEventListener?.('online', check);
      setInterval(check, RECHECK_MS);
    },
    onRegisterError(error) {
      // Not surfaced. A worker that fails to register costs the offline
      // guarantee, which the offline test is there to catch before a tablet
      // sees it; showing it to a counter mid-shift gives them nothing to do.
      console.warn('[conteo] no se pudo registrar el service worker', error);
    },
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(waiting);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Hand over and reload — and make sure the reload happens.
     *
     * `updateSW(true)` reloads only when workbox-window judged the page an
     * *update*, which it decides once, at registration, from whether a
     * controller existed then. The tab that installed the very first worker
     * had none, so on that tab the new worker activated and nothing reloaded:
     * «Actualizando…» for ever, behind a gate that blocks counting — on the
     * tablet that was prepared on office wifi and never closed, which is every
     * tablet on a deploy day. So the page reloads itself when the new worker
     * takes control, and after a few seconds regardless.
     */
    apply: async () => {
      onControllerChange(() => reload());
      await updateSW(true);
      schedule(() => reload(), APPLY_FALLBACK_MS);
    },
  };
}
