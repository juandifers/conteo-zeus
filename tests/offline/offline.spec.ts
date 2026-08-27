/**
 * The cold offline boot, and the three things around it.
 *
 * This is the one guarantee of the application that cannot be asserted in
 * jsdom: a service worker is a real browser feature, and "works offline" is a
 * property of a browser with its network switched off, not of a module that
 * was written as though it were.
 *
 * Every test here starts from a browser that has never seen the app, because
 * that is the state a tablet is in on the morning somebody sets it up, and the
 * afternoon it stops having signal is not the moment to find out the precache
 * never populated.
 */
import { expect, test, type Page } from '@playwright/test'
import { EMPTY, SAMPLE, installed } from './serviceWorker'

async function importBodega(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(SAMPLE)
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
}

test.describe('a tablet that loses its signal', () => {
  /**
   * The whole point of the task. Load once with a network, take the network
   * away, reload, and count.
   */
  test('boots from a cold reload with the network switched off', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.getByText(EMPTY)).toBeVisible()
    expect(await installed(page)).toBeGreaterThanOrEqual(10)

    await context.setOffline(true)

    // A control on the control. If `setOffline` ever stopped taking effect,
    // every test in this file would keep passing while proving nothing — so
    // one request the precache does not hold has to actually fail. Not a
    // navigation: `navigateFallback` would answer that one with index.html
    // whether the network was there or not.
    await expect(
      page.evaluate(() =>
        fetch('/no-existe.json', { cache: 'no-store' }).then(
          () => 'llegó',
          () => 'falló',
        ),
      ),
    ).resolves.toBe('falló')

    await page.reload()

    await expect(page.getByText(EMPTY)).toBeVisible()

    // Not just the HTML: the stylesheet and the bundled faces have to be in the
    // precache too, or the screen renders in Times New Roman at the wrong size
    // — which in a storeroom is a broken app however well it works.
    //
    // Asked of the font loader rather than of `getComputedStyle`, which would
    // report the declared stack whether the woff2 arrived or not — an assertion
    // that passes on a completely fontless page.
    const faces = await page.evaluate(async () => {
      await document.fonts.ready
      return {
        // `check()` alone is not enough: with no matching @font-face at all it
        // assumes a system font and answers true, so a missing *stylesheet*
        // would sail through. The count closes that: the four faces are only
        // registered if the CSS came out of the precache too.
        registered: document.fonts.size,
        sans: document.fonts.check('600 26px "Source Sans 3"'),
        mono: document.fonts.check('400 17px "JetBrains Mono"'),
      }
    })
    expect(faces).toEqual({ registered: 4, sans: true, mono: true })
  })

  test('opens a session imported before the signal went, and shows its items', async ({
    page,
    context,
  }) => {
    await page.goto('/')
    await expect(page.getByText(EMPTY)).toBeVisible()
    await importBodega(page)
    await installed(page)

    await context.setOffline(true)
    await page.reload()

    // Back to the list, from IndexedDB, with nothing on the wire.
    const card = page.getByRole('button', { name: /Bodega/ })
    await expect(card).toBeVisible()
    await expect(card).toContainText('298 artículos')

    await card.click()
    await expect(page.getByLabel('buscar artículo')).toBeVisible()
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '298')

    // And the items are really there: search reaches the frozen catalogue.
    await page.getByLabel('buscar artículo').fill('melon')
    await expect(page.getByText('MELON', { exact: false }).first()).toBeVisible()
  })

  /**
   * The import path is pure client-side parsing — CP850, tab-separated, or a
   * BIFF workbook through SheetJS — and it has to stay that way. SheetJS is
   * deliberately not code-split for this reason (vite.config.ts): a lazy chunk
   * would be a network request at exactly the moment there is no network.
   */
  test('imports a Zeus export from a local file with no network', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.getByText(EMPTY)).toBeVisible()
    await installed(page)

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByText(EMPTY)).toBeVisible()

    await importBodega(page)
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '298')

    // And a count taken offline is a count that survives the next launch.
    await page.getByLabel('buscar artículo').fill('0111020')
    await page.getByLabel('buscar artículo').press('Enter')
    await page.getByLabel(/^cantidad contada de/).fill('5')
    await page.getByRole('button', { name: /^Guardar/ }).click()

    await page.reload()
    await expect(page.getByRole('button', { name: /Bodega/ })).toContainText('1 verificados')
  })

  /**
   * `registerType: 'prompt'` means the notice is shown when — and only when —
   * a different build is waiting. A notice on a first load would train people
   * to tap it away, which is the same as not having one.
   */
  test('shows no update notice when there is no update', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.getByText(EMPTY)).toBeVisible()
    await installed(page)

    await page.reload()
    await expect(page.getByText(EMPTY)).toBeVisible()
    await expect(page.getByText('Hay una versión nueva')).toHaveCount(0)

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByText(EMPTY)).toBeVisible()
    await expect(page.getByText('Hay una versión nueva')).toHaveCount(0)
  })
})

test.describe('when the browser refuses to keep the database', () => {
  /**
   * Chrome grants persistence to `localhost` and to installed apps without
   * asking, so the refusal has to be staged. What is being tested is not the
   * browser's decision — it is that a refusal reaches the screen instead of
   * being swallowed, which is precisely the failure mode of a call whose
   * result nobody reads.
   */
  test('says so on the sessions screen rather than failing silently', async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator.storage, 'persist', { value: async () => false })
      Object.defineProperty(navigator.storage, 'persisted', { value: async () => false })
    })

    await page.goto('/')

    await expect(page.getByText(/El navegador no garantiza guardar este conteo/)).toBeVisible()
    await expect(page.getByText(/Genera el archivo de ajuste el mismo día/)).toBeVisible()
    await expect(page.getByText('sin garantía')).toBeVisible()

    // And it follows the count onto the screen where the afternoon is spent.
    await importBodega(page)
    await expect(
      page.getByText(/El navegador puede borrar este conteo si la tableta se queda sin espacio/),
    ).toBeVisible()
  })

  /**
   * The other side of the same branch, staged the same way.
   *
   * Deliberately *not* asserted against whatever this Chrome decides on its
   * own: headless Chromium refuses `persist()` on localhost, because the
   * heuristics it grants on — site engagement, an installed app, a bookmark —
   * are all things a test browser has none of. Asserting the browser's answer
   * would be asserting a heuristic that differs between the machine this runs
   * on and the tablet it is written for.
   */
  test('reports a granted origin as protected, and warns about nothing', async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator.storage, 'persisted', { value: async () => true })
    })

    await page.goto('/')
    await expect(page.getByText(EMPTY)).toBeVisible()

    await expect(page.getByText('protegido')).toBeVisible()
    await expect(page.getByText(/El navegador no garantiza/)).toHaveCount(0)
  })
})
