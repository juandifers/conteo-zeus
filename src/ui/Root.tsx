/**
 * Which of the three apps this URL is.
 *
 * One bundle, three entrances:
 *
 *   `#/admin…`  the desk. Create a session, divide the bodega, hand out tablets.
 *   `#/c/<tok>` a counter's tablet, preparing itself on office wifi.
 *   `#/local`   the single-device app: import a file, count it on this tablet
 *               on the same four tabs a dispatched counter uses, review, and
 *               generate the `.txt`. Entirely local.
 *   plain `/`   whatever this tablet was prepared for (Entrance.tsx): the
 *               counter link if there is one, the single-device app if not.
 *   anything else  the single-device app, as before.
 *
 * A hash and not a path. The service worker answers every navigation from the
 * precache, so a hash route opens with no network at all — which is the whole
 * point for `#/c/`, where the tablet may be reopened in a corridor with no
 * signal after it has already been prepared.
 *
 * The counting app's boot — device identity, outbox replay — runs only when the
 * counting app is what is rendered. An admin at a desk has no business
 * acquiring a `deviceId`, and a tablet on the preparation screen has not
 * started counting yet.
 */
import { useCallback, useEffect, useState } from 'react';

import type {
  CounterChainRepository,
  CountRepository,
  DeviceRepository,
  ExportRepository,
} from '../domain';
import type { AssignmentStore } from '../store';
import { App } from './App';
import { AdminApp } from './admin/AdminApp';
import { adminRoute, plainHash, tokenInHash } from './admin/links';
import { httpApi, type Api } from './api';
import { storageAuth } from './auth';
import { CounterScreen } from './counter/CounterScreen';
import { Entrance } from './Entrance';
import type { Install } from './install';
import type { Updates } from './updates';

export function Root({
  repo,
  assignments,
  chain,
  api = httpApi(),
  updates,
  install,
}: {
  repo: CountRepository & DeviceRepository & ExportRepository;
  assignments: AssignmentStore;
  /** The counter's outbox. Same database as `repo`; a different question (P2.2). */
  chain: CounterChainRepository;
  api?: Api;
  updates?: Updates;
  install?: Install;
}) {
  const [hash, setHash] = useState(() => globalThis.location?.hash ?? '');

  useEffect(() => {
    const onChange = () => setHash(globalThis.location?.hash ?? '');
    globalThis.addEventListener?.('hashchange', onChange);
    // History traversal between entries `go` pushed: some browsers report it
    // only as `popstate`, and the screen must follow the address either way.
    globalThis.addEventListener?.('popstate', onChange);
    return () => {
      globalThis.removeEventListener?.('hashchange', onChange);
      globalThis.removeEventListener?.('popstate', onChange);
    };
  }, []);

  // `pushState`/`replaceState` rather than assigning `location.hash`, so the
  // entrance's redirect can *replace* the plain address — «back» from a
  // counter's tablet must not land on a screen that sends it straight back.
  const go = useCallback((next: string, options: { replace?: boolean } = {}) => {
    const history = globalThis.history;
    if (history) {
      if (options.replace) history.replaceState(history.state, '', next);
      else history.pushState(null, '', next);
      setHash(globalThis.location?.hash ?? next);
    } else if (globalThis.location) {
      globalThis.location.hash = next;
    }
  }, []);

  // The browser's login gate, shared by the two networked faces. The local P1
  // app below never gets one: it talks to no server, so there is no door.
  const auth = storageAuth();

  if (adminRoute(hash)) return <AdminApp api={api} hash={hash} updates={updates} auth={auth} />;

  const token = tokenInHash(hash);
  if (token) {
    return (
      <CounterScreen
        // The token IS the screen's identity. Without it, opening a new
        // counting link while the tab already sits on an old one re-renders
        // the same component instance, whose `payload`/`live` state still
        // belong to the previous session — the reported «it opened last
        // month's count» — and the two sessions mix. A key change unmounts
        // and remounts, so every link starts from its own Prepare.
        key={token}
        token={token}
        api={api}
        assignments={assignments}
        repo={repo}
        chain={chain}
        updates={updates}
        auth={auth}
      />
    );
  }

  const app = <App repo={repo} chain={chain} updates={updates} install={install} />;
  if (plainHash(hash)) return <Entrance assignments={assignments} app={app} go={go} />;
  return app;
}
