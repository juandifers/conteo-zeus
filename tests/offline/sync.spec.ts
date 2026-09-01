/**
 * A tablet that counts with no signal, is switched off, and comes back.
 *
 * This is the one guarantee of the sync engine that jsdom structurally cannot
 * make: a real service worker, a real IndexedDB, a real page teardown, and a
 * network that is actually not there. Everything else about the drain is
 * asserted in `tests/ui/sync.test.ts`; what is here is that the outbox is on
 * disk rather than in a closure, and that nobody has to press anything for the
 * work to arrive once the signal does.
 *
 * The events are `finish`/`reopen` pairs, which is the cheapest way to put two
 * hundred real events on a real chain: this file is about *volume and
 * durability*, not about what a counter typed. What a counter typed — search,
 * keypad, zeros, notes, an undo — is `shift.spec.ts` next door.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { installed } from './serviceWorker'

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa'
const SESSION = '11111111-1111-4111-8111-111111111111'
const COUNTER = '22222222-2222-4222-8222-222222222222'

/**
 * Exactly the allowlist P2.1 §4c serves. Nothing here is a Zeus figure.
 *
 * It deliberately carries **no `yaRegistrados`** (P2.3.5 §6b). That is a real
 * state a tablet can be in — one prepared before the field existed, sitting in
 * a drawer over a deploy — and the device has to open with it, so this fixture
 * is the one that keeps that path exercised. `shift.spec.ts` next door carries
 * the current shape.
 */
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
}

interface Server {
  /** Every event id the server has been told about, however many times. */
  delivered: string[]
  batches: number[]
  offline: boolean
}

/**
 * A backend, in the test process.
 *
 * `vite preview` serves static files and nothing else, so the functions are not
 * running here; what this suite is about is the device's half of the protocol,
 * and the server's half is exercised against a real Postgres in
 * `tests/backend/push.pg.test.ts`.
 */
async function backend(page: Page): Promise<Server> {
  const server: Server = { delivered: [], batches: [], offline: false }

  await page.route('**/api/**', async (route: Route) => {
    if (server.offline) return route.abort('internetdisconnected')
    const url = new URL(route.request().url())

    if (url.pathname === `/api/c/${TOKEN}`) {
      return route.fulfill({ json: PAYLOAD })
    }
    if (url.pathname === `/api/c/${TOKEN}/resume`) {
      return route.fulfill({
        json: {
          sessionId: SESSION,
          counterId: COUNTER,
          sessionEstado: 'abierto',
          storedMaxSeq: 0,
          // The genesis hash for this (session, counter). The device chains
          // from whatever the server says, so any stable value serves here.
          headHash: 'genesis-from-the-server',
          counterEstado: 'asignado',
          lastClientAt: null,
          serverAt: new Date().toISOString(),
        },
      })
    }
    if (url.pathname === `/api/c/${TOKEN}/events`) {
      const body = route.request().postDataJSON() as {
        events: { event: { id: string; seq: number; kind: string } }[]
      }
      server.batches.push(body.events.length)
      for (const link of body.events) server.delivered.push(link.event.id)
      const last = body.events[body.events.length - 1].event
      return route.fulfill({
        json: {
          acceptedThrough: last.seq,
          headHash: 'whatever',
          counterEstado: last.kind === 'finish' ? 'terminado_confirmado' : 'contando',
          serverAt: new Date().toISOString(),
        },
      })
    }
    return route.fulfill({ status: 404, json: { error: 'no' } })
  })

  return server
}

/** What the browser thinks happened, when the browser is the only witness. */
async function outbox(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('conteo-zeus')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const store = db.transaction('countEvents').objectStore('countEvents')
          const all = store.getAll()
          all.onsuccess = () => {
            resolve(
              (all.result as { sync?: string }[]).filter((row) => row.sync === 'pendiente').length,
            )
            db.close()
          }
          all.onerror = () => reject(all.error)
        }
      }),
  )
}

test.describe('a counter with no signal', () => {
  test('prepares on wifi, counts offline, reboots, and arrives exactly once', async ({
    page,
    context,
  }) => {
    const server = await backend(page)

    // 1. On office wifi. Everything the tablet needs has to be resident before
    //    it leaves, because there is no second chance at it.
    await page.goto(`/#/c/${TOKEN}`)
    await expect(page.getByText('Ana Rodríguez')).toBeVisible()
    expect(await installed(page)).toBeGreaterThanOrEqual(10)
    await page.getByRole('button', { name: 'Terminar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Terminar de todas formas' })).toBeVisible()

    // 2. Into the bodega. The network is gone in both senses: the routes abort,
    //    and the browser itself is offline, so nothing can quietly succeed.
    server.offline = true
    await context.setOffline(true)

    // 3. A cold reload with no network at all — the tablet locked and woken in
    //    a corridor. It still knows who it is and what it holds.
    await page.reload()
    await expect(page.getByText('Ana Rodríguez')).toBeVisible()
    await page.getByRole('button', { name: 'Terminar', exact: true }).click()

    // 4. Two hundred events, through the real store and the real outbox.
    const terminar = page.getByRole('button', { name: 'Terminar de todas formas' })
    const reabrir = page.getByRole('button', { name: 'Reabrir' })
    for (let i = 0; i < 100; i++) {
      await terminar.click()
      await reabrir.click()
    }
    // The outbox is the truth; the banner reports it. Both are asserted, in
    // that order, because a banner that agrees with a wrong number is worse
    // than a banner that lags.
    await expect.poll(() => outbox(page), { timeout: 20_000 }).toBe(200)
    await expect(page.getByText(/200 registros sin subir/)).toBeVisible({ timeout: 20_000 })
    expect(server.delivered).toEqual([])

    // 5. The tablet is switched off. A new page is a new JavaScript world: if
    //    the outbox were a closure, this is where the morning would end.
    await page.close()
    const rebooted = await context.newPage()
    const rebootedServer = await backend(rebooted)
    rebootedServer.offline = true
    await rebooted.goto(`/#/c/${TOKEN}`)
    await expect(rebooted.getByText(/200 registros sin subir/)).toBeVisible({ timeout: 20_000 })
    expect(await outbox(rebooted)).toBe(200)

    // 6. Back in the office. Nobody presses anything: `online` is what the
    //    drain listens for.
    rebootedServer.offline = false
    await context.setOffline(false)
    await rebooted.evaluate(() => globalThis.dispatchEvent(new Event('online')))

    await expect(rebooted.getByText(/Todo lo que llevas está subido|sin subir/)).toBeVisible()
    await expect
      .poll(() => rebootedServer.delivered.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(200)

    // Exactly once. Over-delivery is safe by design, so this asserts the
    // stronger thing: nothing was sent twice *and* nothing was lost.
    expect(new Set(rebootedServer.delivered).size).toBe(200)
    expect(rebootedServer.delivered).toHaveLength(200)
    // 200 at a time, so 200 events is one batch.
    expect(rebootedServer.batches.every((n) => n <= 200)).toBe(true)
    expect(await outbox(rebooted)).toBe(0)
  })

  test('finishing offline degrades, and confirms later with nobody pressing anything', async ({
    page,
    context,
  }) => {
    const server = await backend(page)

    await page.goto(`/#/c/${TOKEN}`)
    await expect(page.getByText('Ana Rodríguez')).toBeVisible()
    await installed(page)
    await page.getByRole('button', { name: 'Terminar', exact: true }).click()

    server.offline = true
    await context.setOffline(true)

    // «Terminar» must return. A blocking spinner here is a force-close, and a
    // force-close is the one thing that loses data.
    await page.getByRole('button', { name: 'Terminar de todas formas' }).click()
    await expect(page.getByText('⏳ Terminado')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/1 registro sin subir/)).toBeVisible()
    await expect(page.getByText(/Acércate a la zona con señal/)).toBeVisible()

    // Back in signal. No button is pressed.
    server.offline = false
    await context.setOffline(false)
    await page.evaluate(() => globalThis.dispatchEvent(new Event('online')))

    await expect(page.getByText('✓ Terminado y confirmado')).toBeVisible({ timeout: 30_000 })
    expect(server.delivered).toHaveLength(1)
  })
})
