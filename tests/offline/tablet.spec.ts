/**
 * Two guarantees about one tablet that only a real browser can show.
 *
 * - **One writer per counter.** The same link open twice on one tablet — two
 *   tabs, or the installed app beside a Chrome tab — shares one IndexedDB. The
 *   older screen's chain position is stale, and before this guard it lost an
 *   entry and stranded everything after it. Web Locks are real here, across
 *   real pages of one browser context, which jsdom cannot give.
 * - **An entry is pushed when it is made**, when there is signal — not on the
 *   next thirty-second tick. The sync bar used to say «Todo lo que llevas está
 *   subido» for that whole half-minute, which is the sentence that tells
 *   somebody it is safe to walk out of signal. * - **The app icon opens the counter's link.** The installed app starts at
 *   `/`, which used to be the single-device app whatever the tablet had been
 *   prepared for. Now the plain address finds the link in IndexedDB and opens
 *   it, with no network (Entrance.tsx).
 */
import { expect, test, type BrowserContext, type Route } from '@playwright/test'
import { installed } from './serviceWorker'

const TOKEN = 'cccccccccccccccccccccc'
const SESSION = '11111111-1111-4111-8111-111111111111'
const COUNTER = '22222222-2222-4222-8222-222222222222'

const PAYLOAD = {
  session: {
    id: SESSION,
    bodega: '01',
    fechaCorte: '2026/04/30',
    nombre: 'Corte abril',
    mostrarMarcaRegistrado: true,
  },
  counter: { id: COUNTER, nombre: 'Ana Rodríguez' },
  secciones: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      nombre: 'ALMACEN',
      items: [
        { idarticulo: 1181, codigo: '0103005', nombre: 'PANCETA SV', presentacion: 'KILO', unidad: 'KILO' },
        { idarticulo: 77, codigo: '0201001', nombre: 'MELON', presentacion: 'KILO', unidad: 'KILO' },
      ],
    },
  ],
  yaRegistrados: [],
}

interface Server {
  pushes: { at: number; seqs: number[] }[]
}

async function backend(context: BrowserContext): Promise<Server> {
  const server: Server = { pushes: [] }
  await context.addInitScript(() => {
    try {
      localStorage.setItem(
        'conteo.auth',
        JSON.stringify({
          token: 'v1.contador.9999999999.aa.bb',
          role: 'contador',
          expiresAt: '2286-11-20T17:46:39.000Z',
        }),
      )
    } catch {
      // Storage blocked: the login screen appears and the test fails loudly.
    }
  })
  await context.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname === `/api/c/${TOKEN}`) return route.fulfill({ json: PAYLOAD })
    if (url.pathname === `/api/c/${TOKEN}/resume`) {
      return route.fulfill({
        json: {
          sessionId: SESSION,
          counterId: COUNTER,
          sessionEstado: 'abierto',
          storedMaxSeq: 0,
          headHash: 'genesis-from-the-server',
          counterEstado: 'asignado',
          lastClientAt: null,
          serverAt: new Date().toISOString(),
        },
      })
    }
    if (url.pathname === `/api/c/${TOKEN}/events`) {
      const body = route.request().postDataJSON() as { events: { event: { seq: number } }[] }
      const seqs = body.events.map((link) => link.event.seq)
      server.pushes.push({ at: Date.now(), seqs })
      return route.fulfill({
        json: {
          acceptedThrough: seqs[seqs.length - 1],
          headHash: 'whatever',
          counterEstado: 'contando',
          serverAt: new Date().toISOString(),
        },
      })
    }
    return route.fulfill({ status: 404, json: { error: 'no' } })
  })
  return server
}

test('the same counter in a second tab is stopped before it can write, and opens once the first is gone', async ({
  context,
}) => {
  await backend(context)
  const first = await context.newPage()
  await first.goto(`/#/c/${TOKEN}`)
  await expect(first.getByLabel('buscar artículo')).toBeVisible()

  const second = await context.newPage()
  await second.goto(`/#/c/${TOKEN}`)
  await expect(second.getByText('Este conteo ya está abierto en esta tableta')).toBeVisible()
  await expect(second.getByLabel('buscar artículo')).toHaveCount(0)

  // The first tab still counts.
  await first.getByLabel('buscar artículo').fill('0103005')
  await first.getByLabel('buscar artículo').press('Enter')
  await first.getByLabel(/cantidad contada/).fill('4')
  await first.getByRole('button', { name: /^Registrar 4 KILO$/ }).click()
  await expect(first.getByLabel('buscar artículo')).toBeVisible()

  // Closing it releases the lock; the second opens on «Reintentar».
  await first.close()
  await second.getByRole('button', { name: 'Reintentar' }).click()
  await expect(second.getByLabel('buscar artículo')).toBeVisible()
})

test('an entry made with signal is pushed right away, not on the next tick', async ({ context }) => {
  const server = await backend(context)
  const page = await context.newPage()
  await page.goto(`/#/c/${TOKEN}`)
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
  const before = server.pushes.length

  await page.getByLabel('buscar artículo').fill('0103005')
  await page.getByLabel('buscar artículo').press('Enter')
  await page.getByLabel(/cantidad contada/).fill('4')
  const tapped = Date.now()
  await page.getByRole('button', { name: /^Registrar 4 KILO$/ }).click()

  // Well inside the thirty-second tick that used to be the only trigger.
  await expect.poll(() => server.pushes.length, { timeout: 5_000 }).toBeGreaterThan(before)
  expect(server.pushes[server.pushes.length - 1].at - tapped).toBeLessThan(5_000)
  await expect(page.getByText(/Todo lo que llevas está subido/)).toBeVisible()
})

test('the plain address — the app icon — opens the prepared link, even offline', async ({
  context,
}) => {
  await backend(context)
  const page = await context.newPage()
  // Prepared on office wifi, the way a counter's tablet is.
  await page.goto(`/#/c/${TOKEN}`)
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
  await installed(page)
  await page.close()

  // Later, in the bodega, from the icon: `start_url` is `/`, and there is no
  // signal to ask anything.
  await context.setOffline(true)
  const fromIcon = await context.newPage()
  await fromIcon.goto('/')
  await expect(fromIcon.getByText('Ana Rodríguez')).toBeVisible()
  await expect(fromIcon.getByLabel('buscar artículo')).toBeVisible()
  expect(new URL(fromIcon.url()).hash).toBe(`#/c/${TOKEN}`)
  // And the single-device app is still there, under its own address.
  await fromIcon.goto('/#/local')
  await expect(fromIcon.getByText('Trae un archivo de Zeus y empieza')).toBeVisible()
})
