/**
 * One browser, one guarantee.
 *
 * Playwright is here for a single thing that jsdom structurally cannot do:
 * install a service worker, cut the network, and reload. That is the most
 * important promise this application makes — a tablet in a walk-in cooler with
 * no signal still opens and still counts — and until this suite existed it was
 * the only load-bearing behaviour with no test at all behind it.
 *
 * The server *builds* before it serves. A preview of a stale `dist/` would
 * exercise yesterday's service worker against today's source, which is exactly
 * the failure this suite is supposed to catch.
 */
import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: './tests/offline',
  // Service worker installation is the slow part, and it is slow on a cold
  // cache in a way that has nothing to do with the assertions.
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // Chromium only, on purpose. The tablets are Chrome, and a second engine
      // here would be two more browsers to install for no answer we act on.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
