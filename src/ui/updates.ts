/**
 * A new version, waiting until somebody asks for it.
 *
 * The service worker is registered with `registerType: 'prompt'`, so a new
 * build installs itself and then *stops*, holding at `waiting`. It takes over
 * only when this module tells it to. That is deliberate and it is the whole
 * design: the alternative — `autoUpdate` — reloads the page out from under
 * whoever is holding the tablet. Nothing in IndexedDB would be lost, but the
 * number half-typed into the keypad would be, and a tablet that restarts
 * itself mid-count is a tablet people stop trusting long before they can say
 * why.
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

export function serviceWorkerUpdates(register: RegisterSW): Updates {
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
      // One check, at launch, and no `setInterval`. A tablet in a storeroom is
      // offline most of the day, so a timer would spend the afternoon making
      // failing requests; and a check that lands mid-count can only produce a
      // notice nobody wants to read right then. The app is opened every
      // morning, which is a good enough cadence for a pilot.
      void registration?.update();
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
    apply: () => updateSW(true),
  };
}
