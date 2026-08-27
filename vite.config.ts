/**
 * Build configuration, and the two things in it that are load-bearing.
 *
 * 1. **The service worker precaches everything.** This app runs in a walk-in
 *    cooler and a storeroom with no signal; a chunk fetched on demand is a
 *    screen that does not open. Nothing is code-split, including SheetJS —
 *    with a precaching worker a lazy chunk is downloaded up front anyway, so
 *    splitting it buys nothing and adds a failure mode where importing an
 *    `.xls` fails offline.
 *
 * 2. **`registerType: 'prompt'`.** A new version waits until somebody asks for
 *    it. A tablet that reloads itself mid-count is a tablet nobody trusts, and
 *    the count is in IndexedDB but the keypad's half-typed number is not.
 */
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Which build this is.
 *
 * The first question about any report from the floor is which build the
 * tester was on, and without this the answer is a guess. Vercel does not ship
 * a `.git`, so its own environment variable is the fallback there.
 */
function commit(): string {
  const fromCi = process.env.VERCEL_GIT_COMMIT_SHA
  if (fromCi) return fromCi.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'sin-git'
  }
}

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // The icons reach the precache through the glob below like every other
      // file in `public/`. Left at its default, the plugin adds the manifest's
      // icons a second time and the precache carries three duplicate entries.
      includeManifestIcons: false,
      manifest: {
        // Named for what it does. `conteo-zeus` is what the repository is
        // called, and nobody in the hotel has any reason to know that.
        name: 'Conteo de inventario',
        short_name: 'Conteo',
        description: 'Conteo físico de bodega, con o sin señal.',
        lang: 'es',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Tablets get held both ways in a storeroom, often one-handed with the
        // other hand on a box. Locking an orientation only ever fights that.
        orientation: 'any',
        background_color: '#faf8f5',
        theme_color: '#faf8f5',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            // Separate file, not the same one relabelled: a launcher crops a
            // maskable icon to its own shape, so this one is drawn with the
            // mark well inside the safe circle (tools/make-icons.mjs).
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // woff2 and not woff: fontsource emits both, every browser this runs
        // on takes the woff2, and precaching the twin would put 100 KB of
        // never-read bytes on a tablet.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Stated rather than left at the 2 MiB default. SheetJS makes the main
        // bundle large, and the failure mode of crossing the default is that
        // Workbox drops the app's own JavaScript from the precache with a
        // warning in a build log nobody reads — the app then works until the
        // first time it is opened offline.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // The *first* worker takes control of the page that registered it,
        // instead of waiting for a second visit. Without this, a tablet that is
        // opened once and then loses signal is not offline-capable until
        // somebody loads it again with a network — which is a setup step nobody
        // would know to perform, discovered in a storeroom.
        //
        // This is not `skipWaiting`, and it does not weaken the prompt: a
        // *replacement* worker still waits (`registerType: 'prompt'`), and
        // `clientsClaim` only ever runs on activation, which a waiting worker
        // by definition has not reached.
        clientsClaim: true,
        // No runtime caching and no network handlers: there is no backend to
        // talk to, so anything not in the precache is a mistake, and a runtime
        // cache would hide it until the day it mattered.
        navigateFallback: 'index.html',
      },
      devOptions: {
        // Off in `vite dev`. A service worker holding a stale module graph
        // during development is a long afternoon; the worker is exercised
        // against `vite preview`, which is what the tablet actually gets.
        enabled: false,
      },
    }),
  ],
})
