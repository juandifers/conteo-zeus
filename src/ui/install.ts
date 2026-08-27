/**
 * Putting the app on the home screen.
 *
 * Worth a button rather than leaving it to the browser's own menu, for one
 * reason that is not cosmetic: Chrome grants persistent storage to installed
 * apps more or less automatically (see storage.ts). Installing is therefore
 * the single most effective thing anybody can do to stop a count being
 * evicted, and it is buried three taps deep in a menu nobody opens.
 *
 * `beforeinstallprompt` fires early — often before React has mounted — and is
 * only usable if it was captured and its default prevented at the moment it
 * fired. So this is wired up in main.tsx at module scope, not in an effect.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface Install {
  /** Called with `true` while an install is possible. Fires immediately too. */
  subscribe(listener: (offered: boolean) => void): () => void;
  /** Show the browser's own install dialog. */
  prompt(): Promise<void>;
}

/** The answer in a test, and in a browser that has no install to offer. */
export function noInstall(): Install {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
  };
}

export function browserInstall(target: EventTarget = globalThis.window): Install {
  let deferred: InstallPromptEvent | null = null;
  const listeners = new Set<(offered: boolean) => void>();

  const announce = () => {
    for (const listener of listeners) listener(deferred !== null);
  };

  target.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own mini-infobar, which on the
    // counting screen is a strip of chrome over the keypad.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    announce();
  });

  // Already installed: the event never fires again, so the offer has to be
  // withdrawn explicitly or the button outlives its usefulness.
  target.addEventListener('appinstalled', () => {
    deferred = null;
    announce();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(deferred !== null);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt() {
      const event = deferred;
      if (!event) return;
      // Spent on use: a captured prompt may be shown exactly once, and an
      // offer still on screen after that is a button that does nothing.
      deferred = null;
      announce();
      await event.prompt();
    },
  };
}
