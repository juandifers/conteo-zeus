/**
 * Waiting for the worker, shared by the specs in this directory.
 *
 * Not a `.spec.ts`, so Playwright does not collect it as a test file.
 */
import { expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** The real export from the hotel — the `.xls`, which is what they send. */
export const SAMPLE = join(here, '..', '..', 'samples', 'COMESTIBLES ALMACEN.xls')

/** The sessions screen with nothing on it. The app's first frame. */
export const EMPTY = 'Trae un archivo de Zeus y empieza'

/**
 * Wait until the worker has filled its cache *and* taken charge of the page.
 *
 * Both halves matter and they are different facts. `serviceWorker.ready`
 * resolves when a worker is active, which is a weaker claim than "every asset
 * is on disk"; and a worker can hold a full cache while the open page is still
 * uncontrolled, in which case the next navigation goes to the network and an
 * offline reload fails. Cutting the network between those two moments is how
 * this suite would flake — which, for a suite whose entire job is to be
 * believed about offline, is the worst failure it could have.
 *
 * The controller check is only meaningful because `clientsClaim` is on
 * (vite.config.ts). Without it the first visit never becomes controlled, and a
 * tablet opened once and then carried out of signal would not work offline.
 */
export async function installed(page: Page): Promise<number> {
  let entries = 0
  // `expect.poll` around `page.evaluate`, and deliberately not
  // `page.waitForFunction`: that one does not await an async predicate, so it
  // sees a pending Promise, calls it truthy and returns on the first poll. The
  // helper then waited for nothing, and the suite passed by being fast enough
  // — which is the exact failure a test like this must not have.
  await expect
    .poll(
      async () => {
        entries = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration()
          if (!registration?.active || !navigator.serviceWorker.controller) return 0
          let found = 0
          for (const name of await caches.keys()) {
            found += (await caches.open(name).then((cache) => cache.keys())).length
          }
          return found
        })
        return entries
      },
      {
        timeout: 45_000,
        message: 'service worker never activated, claimed the page and filled its cache',
      },
    )
    // The precache manifest has thirteen entries; double figures means the
    // install completed rather than merely started.
    .toBeGreaterThanOrEqual(10)
  return entries
}
