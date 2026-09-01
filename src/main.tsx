// The two faces, bundled. No CDN and no <link> to a font host: this runs in a
// walk-in cooler with no network, and a face that fails to load in a cold room
// is a broken screen. Latin subsets only — ~74 KB for all four files. They are
// precached by the service worker along with everything else (vite.config.ts),
// which is what makes "bundled" mean "available offline" rather than "one
// request away from a blank screen".
import '@fontsource/source-sans-3/latin-400.css'
import '@fontsource/source-sans-3/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { DexieAssignmentStore, DexieCounterChain, DexieCountRepository } from './store'
import { Root } from './ui/Root'
import { browserInstall } from './ui/install'
import './ui/admin.css'
import './ui/theme.css'
import { serviceWorkerUpdates } from './ui/updates'

// Both of these are set up *before* the first render, and neither can move
// into an effect.
//
//   `beforeinstallprompt` fires early and is only usable if its default was
//   prevented at the moment it fired; a listener attached after mount misses
//   the event on a cold load and the install offer never appears.
//
//   `registerSW` is what starts the worker at all. Registering during render
//   would tie the app's offline guarantee to React's lifecycle, which is a
//   strange thing for it to depend on.
//
// This file is the only one that imports `virtual:pwa-register` — a module
// that exists only inside a Vite build. Everything downstream takes the
// `Updates` port (src/ui/updates.ts), so the screens stay testable.
const install = browserInstall()
const updates = serviceWorkerUpdates(registerSW)

// The composition root's composition root: the one place a concrete adapter is
// named. Everything above takes the `CountRepository` port.
const repo = new DexieCountRepository()
// The counter's downloaded assignment (P2.1 §4c). A second small adapter rather
// than a method on the repository above: it holds what the *server* sent, and
// `CountRepository` is the port for what this device recorded.
const assignments = new DexieAssignmentStore()
// The counter's outbox (P2.2). Constructed over the repository's **own**
// `ConteoDb`, not a second one: two Dexie instances on one IndexedDB database
// are two connections, and a transaction opened on one does not include the
// tables of the other — which is precisely how an event and its `pendiente`
// flag would end up written separately.
const chain = new DexieCounterChain(repo.db)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root
      repo={repo}
      assignments={assignments}
      chain={chain}
      updates={updates}
      install={install}
    />
  </StrictMode>,
)
