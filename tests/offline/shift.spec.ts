/**
 * A whole shift, offline, through the screens somebody actually touches.
 *
 * `sync.spec.ts` next door proves the outbox survives volume and a reboot.
 * This proves the *counting* survives an afternoon with no signal: search, a
 * keypad, forty entries, three empty shelves, two notes, a correction, and
 * «Terminar» — every one of them through the real store, the real chain and a
 * real IndexedDB, with the network genuinely absent rather than mocked away.
 *
 * The assertion at the end is the one the jefe de costos cares about: nobody
 * pressed anything, and everything arrived exactly once.
 *
 * It is also where the blind rule is checked against a **rendered page** rather
 * than against source. Ana enters 3, 4 and 5 on one article across the
 * afternoon. Fifteen must never appear anywhere on her tablet.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { installed } from './serviceWorker'

const TOKEN = 'bbbbbbbbbbbbbbbbbbbbbb'
const SESSION = '44444444-4444-4444-8444-444444444444'
const COUNTER = '55555555-5555-4555-8555-555555555555'

const item = (idarticulo: number, codigo: string, nombre: string, presentacion: string) => ({
  idarticulo,
  codigo,
  nombre,
  presentacion,
  unidad: presentacion,
})

/**
 * Two sections, eight articles, and exactly the allowlist P2.1 §4c serves.
 * Two sections because `zona` is per-article: one string for the whole tablet
 * would be wrong for half the afternoon.
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
      id: '66666666-6666-4666-8666-666666666666',
      nombre: 'Cuarto frío proteínas',
      items: [
        item(1181, '0103005', 'PANCETA SV', 'KILO'),
        item(1595, '0106001', 'PESCADO TILAPIA ROJA', 'PORCION X 600 GRAMOS'),
        item(1101, '0101003', 'CARNE MOLIDA DE RES', 'KILO'),
        item(1070, '0107002', 'CAMARON TIGRE', 'KILO'),
      ],
    },
    {
      id: '77777777-7777-4777-8777-777777777777',
      nombre: 'Panadería',
      items: [
        item(2165, '0112006', 'PAN TAJADO', 'NATIPAN X 500 GRS'),
        item(2170, '0112007', 'PAN PERRO', 'PAQUETE X 8'),
        item(2180, '0112008', 'PAN HAMBURGUESA', 'PAQUETE X 8'),
        item(2190, '0112009', 'CROISSANT', 'UNIDAD'),
      ],
    },
  ],
  // Nobody has handed this counter anything (P2.3.5 §6b). Empty is the ordinary
  // case and the one every session is in until a swap happens.
  yaRegistrados: [],
}

const CODES = ['0103005', '0106001', '0101003', '0107002', '0112006', '0112007', '0112008', '0112009']

interface Delivered {
  id: string
  seq: number
  kind: string
  qty?: number
  zona: string
  idarticulo: number | null
}

interface Server {
  events: Delivered[]
  offline: boolean
}

async function backend(page: Page): Promise<Server> {
  const server: Server = { events: [], offline: false }

  await page.route('**/api/**', async (route: Route) => {
    if (server.offline) return route.abort('internetdisconnected')
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
      const body = route.request().postDataJSON() as { events: { event: Delivered }[] }
      for (const link of body.events) server.events.push(link.event)
      const last = body.events[body.events.length - 1].event
      return route.fulfill({
        json: {
          acceptedThrough: last.seq,
          headHash: 'whatever',
          // Derived from what arrived, not from what the device claimed.
          counterEstado: last.kind === 'finish' ? 'terminado_confirmado' : 'contando',
          serverAt: new Date().toISOString(),
        },
      })
    }
    return route.fulfill({ status: 404, json: { error: 'no' } })
  })

  return server
}

async function outbox(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('conteo-zeus')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const all = db.transaction('countEvents').objectStore('countEvents').getAll()
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

/** The four tabs. Scoped, because «Terminar» is both a tab and a button. */
const tab = (page: Page, name: string) =>
  page.locator('.tabs').getByRole('button', { name, exact: true })

/** Search by code and press Enter — the keyboard-wedge path, and one action. */
async function open(page: Page, codigo: string): Promise<void> {
  const search = page.getByLabel('buscar artículo')
  await search.fill(codigo)
  await search.press('Enter')
  await expect(page.getByLabel(/cantidad contada/)).toBeVisible()
}

async function registrar(page: Page, codigo: string, qty: string): Promise<void> {
  await open(page, codigo)
  await page.getByLabel(/cantidad contada/).fill(qty)
  await page.getByRole('button', { name: `Registrar ${qty}`, exact: true }).click()
}

test.describe('a whole shift with no signal', () => {
  test('counts, corrects, notes and finishes offline — and it all arrives once', async ({
    page,
    context,
  }) => {
    const server = await backend(page)

    // On office wifi: the assignment and the app itself become resident.
    await page.goto(`/#/c/${TOKEN}`)
    await expect(page.getByText('Ana Rodríguez')).toBeVisible()
    expect(await installed(page)).toBeGreaterThanOrEqual(10)

    // Into the bodega. Gone in both senses, so nothing can quietly succeed.
    server.offline = true
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByLabel('buscar artículo')).toBeVisible()

    // Forty entries across eight articles — five passes down two aisles. The
    // same article more than once is not a correction: it is the same product
    // on a shelf and in a cold room, and `add` is why that works.
    for (let pass = 0; pass < 5; pass++) {
      for (const codigo of CODES) {
        await registrar(page, codigo, String(pass + 1))
      }
    }

    // Three shelves that are genuinely empty. A zero is a stock deletion under
    // §7.4, so it costs one deliberate tap more than a number.
    for (const codigo of ['0112007', '0112008', '0112009']) {
      await open(page, codigo)
      await page.getByRole('button', { name: /Está vacío/ }).click()
      await page.getByRole('button', { name: 'Sí, está vacío' }).click()
    }

    // Two notes. There is physically nowhere else to put an observation:
    // `Observacion` is dropped in the .txt and Grupo1..5 are forbidden (§9).
    await tab(page, 'Notas').click()
    for (const texto of ['3 cajas sin código en el estante de arriba', 'nevera 2 apagada']) {
      await page.getByLabel('texto de la nota').fill(texto)
      await page.getByRole('button', { name: 'Guardar nota' }).click()
      await expect(page.getByText(texto)).toBeVisible()
    }

    // A correction, from the screen where correction lives.
    await tab(page, 'Mis registros').click()
    await page.getByRole('button', { name: 'Deshacer' }).first().click()
    await expect(page.locator('.row--withdrawn').first()).toBeVisible()

    // 40 entries + 3 zeros + 2 notes + 1 retraction.
    await expect.poll(() => outbox(page), { timeout: 30_000 }).toBe(46)
    expect(server.events).toEqual([])

    // The blind rule, on the rendered page. Ana entered 3, 4 and 5 on PANCETA
    // among others; no surface may show a sum for any article.
    for (const name of ['Contar', 'Mis registros', 'Terminar']) {
      await tab(page, name).click()
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      // Every article got 1, 2, 3, 4 and 5. The total is 15 and the running
      // totals on the way there are 3, 6 and 10 — of which 3 is also an entry
      // somebody typed, so the probes are the three that can only be sums.
      for (const sum of [' 15 ', ' 10 ', ' 6 ']) {
        expect(text, `${name} shows ${sum.trim()}`).not.toContain(sum)
      }
    }

    // «Terminar», with the gap review in front of it. Nothing is left
    // unregistered, so the button is not the «de todas formas» one.
    await tab(page, 'Terminar').click()
    await expect(page.getByText('Cuarto frío proteínas · 4 artículos')).toBeVisible()
    await page.getByRole('button', { name: 'Terminar', exact: true }).last().click()
    await expect(page.getByText('⏳ Terminado')).toBeVisible({ timeout: 15_000 })

    // Back in the office. Nobody presses anything.
    server.offline = false
    await context.setOffline(false)
    await page.evaluate(() => globalThis.dispatchEvent(new Event('online')))

    await expect(page.getByText('✓ Terminado y confirmado')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => outbox(page), { timeout: 30_000 }).toBe(0)

    // Exactly once, and in one unbroken numbering from 1.
    expect(server.events).toHaveLength(47)
    expect(new Set(server.events.map((event) => event.id)).size).toBe(47)
    expect(server.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 47 }, (_, index) => index + 1),
    )

    const kinds = server.events.map((event) => event.kind)
    expect(kinds.filter((kind) => kind === 'add')).toHaveLength(43)
    expect(kinds.filter((kind) => kind === 'note')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'retract')).toHaveLength(1)
    expect(kinds.at(-1)).toBe('finish')

    // Every withdrawal names its target — the P2.2 gate, on the wire.
    for (const event of server.events) {
      if (event.kind !== 'retract') continue
      expect((event as unknown as { retractsEventId?: string }).retractsEventId).toBeTruthy()
    }

    // And every event carries the zone of the section it came from, not a zone
    // anybody picked off a list (P2.3 G2).
    const zonas = new Map(
      server.events
        .filter((event) => event.idarticulo !== null)
        .map((event) => [event.idarticulo, event.zona]),
    )
    expect(zonas.get(1181)).toBe('Cuarto frío proteínas')
    expect(zonas.get(2165)).toBe('Panadería')
  })

  test('reopening after a confirmed finish keeps one numbering, and the amendment is visible', async ({
    page,
  }) => {
    const server = await backend(page)

    await page.goto(`/#/c/${TOKEN}`)
    await expect(page.getByLabel('buscar artículo')).toBeVisible()
    await registrar(page, '0103005', '7')

    await tab(page, 'Terminar').click()
    await page.getByRole('button', { name: 'Terminar de todas formas' }).click()
    await expect(page.getByText('✓ Terminado y confirmado')).toBeVisible({ timeout: 30_000 })

    // A stray box, found after finishing.
    await page.getByRole('button', { name: 'Reabrir' }).click()
    await tab(page, 'Contar').click()
    await registrar(page, '0106001', '2')
    await tab(page, 'Terminar').click()
    await page.getByRole('button', { name: 'Terminar de todas formas' }).click()
    await expect(page.getByText('✓ Terminado y confirmado')).toBeVisible({ timeout: 30_000 })

    await expect.poll(() => outbox(page), { timeout: 30_000 }).toBe(0)

    // One chain, unbroken. A second chain starting over would be exactly the
    // hole the finish manifest looks for.
    expect(server.events.map((event) => event.kind)).toEqual([
      'add',
      'finish',
      'reopen',
      'add',
      'finish',
    ])
    expect(server.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])

    // The amendment is derivable from the log alone: everything after the first
    // `finish` is post-finish, and nothing had to store a boolean to say so.
    const firstFinish = server.events.findIndex((event) => event.kind === 'finish')
    const amendments = server.events.slice(firstFinish + 1).map((event) => event.seq)
    expect(amendments).toEqual([3, 4, 5])
  })
})
