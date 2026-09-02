/**
 * Which of the three apps this URL is.
 *
 * One bundle, three entrances:
 *
 *   `#/admin…`  the desk. Create a session, divide the bodega, hand out tablets.
 *   `#/c/<tok>` a counter's tablet, preparing itself on office wifi.
 *   anything     the P1 counting app, which is still entirely local.
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
import { useEffect, useState } from 'react';

import type {
  CounterChainRepository,
  CountRepository,
  DeviceRepository,
  ExportRepository,
} from '../domain';
import type { AssignmentStore } from '../store';
import { App } from './App';
import { AdminApp } from './admin/AdminApp';
import { adminRoute, tokenInHash } from './admin/links';
import { httpApi, type Api } from './api';
import { CounterScreen } from './counter/CounterScreen';
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
    return () => globalThis.removeEventListener?.('hashchange', onChange);
  }, []);

  if (adminRoute(hash)) return <AdminApp api={api} hash={hash} updates={updates} />;

  const token = tokenInHash(hash);
  if (token) {
    return (
      <CounterScreen
        token={token}
        api={api}
        assignments={assignments}
        repo={repo}
        chain={chain}
      />
    );
  }

  return <App repo={repo} updates={updates} install={install} />;
}
