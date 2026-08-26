// The two faces, bundled. No CDN and no <link> to a font host: this runs in a
// walk-in cooler with no network, and a face that fails to load in a cold room
// is a broken screen. Latin subsets only — ~74 KB for all four files.
import '@fontsource/source-sans-3/latin-400.css'
import '@fontsource/source-sans-3/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DexieCountRepository } from './store'
import { App } from './ui/App'
import './ui/theme.css'

// The composition root's composition root: the one place a concrete adapter is
// named. Everything above takes the `CountRepository` port.
const repo = new DexieCountRepository()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App repo={repo} />
  </StrictMode>,
)
