/**
 * The whole job, offline, in one test.
 *
 * `offline.spec.ts` proves the app boots and a session opens with the network
 * switched off. That is the shell. This is the *work*: import a bodega, count
 * it through the real UI with real taps, survive a reload halfway, review it,
 * and read the bytes that reach the filesystem — the artifact somebody uploads
 * to Zeus, off the disk, not out of a Blob in page context.
 *
 * Since 2026-10 an import is counted on the **counter screens** — Contar, Mis
 * registros, Notas, Terminar — the same four tabs a dispatched tablet uses, and
 * every quantity is an independent registro: a second pile of one article is a
 * second entry, never an edit of the first. The file at the end is still the
 * single-device `.txt`, generated on this tablet.
 *
 * Two of the assertions below cannot be reached from jsdom at all, and they
 * are the reason this file exists rather than another case in
 * `tests/integration.test.ts`:
 *
 * **The mid-count reload.** That the chained Dexie write actually
 * *committed*, in a real transaction, before a real navigation, on a page a
 * worker is controlling — and that the count reopens on «Mis registros» with
 * every entry, and continues the same chain rather than starting a second one.
 * Somebody will run this experiment unknowingly on day one, when a tablet
 * screen-locks in the middle of a shelf.
 *
 * **The withdrawal.** «Deshacer» is an append that has to *win* the fold — it
 * does not delete anything. If the ordering is ever wrong, the file carries a
 * number the counter explicitly took back, and no screen anywhere would show
 * it. So one withdrawn value is followed all the way from the tap to the byte.
 *
 * One test, deliberately. This is a guarantee, not a matrix: the value is in
 * the single unbroken chain from a tap in a cold room to a field in a file,
 * and splitting it into stages would test each link against a fixture instead
 * of against the link before it.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { parseXls } from '../../src/zeus/parseXls'
import { parseTxt } from '../../src/zeus/parseTxt'
import { ZEUS_COLUMNS, ZEUS_FIELD_COUNT } from '../../src/zeus/types'
import { EMPTY, SAMPLE, installed } from './serviceWorker'

/** The file as the app will parse it. The ground truth for every column. */
const source = parseXls(new Uint8Array(readFileSync(SAMPLE)))
const column = Object.fromEntries(ZEUS_COLUMNS.map((name, index) => [name, index])) as Record<
  (typeof ZEUS_COLUMNS)[number],
  number
>
/** `writeTxt` in its default mode owns these two and nothing else. */
const WRITE_SET = new Set([column.toma, column.diferencia])

const at = (idarticulo: number) => source.items.find((item) => item.idarticulo === idarticulo)!

/**
 * Three articles, each chosen for what it makes the test prove.
 *
 * All three carry a `codigo` no other row shares, so opening one from the
 * search box lands on a single presentation and the entry card is
 * unambiguous — the grouped-presentation case has its own tests and would
 * only add taps here.
 */
const PINA = 85 // PIÑA OROMIEL · KILO · the accent-folded search, typed by hand
const MELON = 77 // MELON · KILO · two piles, two registros. Booked at 0: an overage.
const HARINA = 42 // HARINA PAN AMARILLA · KILO · registered, then withdrawn

/** Longer than the list's tap guard (tapGuard.ts), as in shift.spec.ts. */
const READ_MS = 450

/** What the test types, and what the file must therefore carry. */
const TYPED_PINA = 12.5
const MELON_PILES = [2, 1] as const
const TYPED_THEN_WITHDRAWN = 50

test('counts a bodega with no signal and hands over a file Zeus can read', async ({
  page,
  context,
}) => {
  // The withdrawn row only proves anything if the number that was taken back
  // is not the number a waiver would produce anyway.
  expect(at(HARINA).existencia).not.toBe(TYPED_THEN_WITHDRAWN)

  // ---- online, once ------------------------------------------------------
  await page.goto('/')
  await expect(page.getByText(EMPTY)).toBeVisible()
  await installed(page)

  // ---- and never again ---------------------------------------------------
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText(EMPTY)).toBeVisible()

  await page.getByLabel('quién cuenta').fill('ana')
  await page.locator('input[type="file"]').setInputFiles(SAMPLE)
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
  await expect(tab(page, 'Mis registros')).toBeVisible()

  // A search that only works if accents are folded. Nobody wearing gloves in a
  // cold room is going to produce an Ñ, and the catalogue is full of them.
  // Typed with a comma, which is the separator a Colombian keyboard offers and
  // the one the ERP does not take. The conversion is the app's job.
  await registrar(page, 'pina oromiel', '12,5', /PIÑA OROMIEL/)

  // Two piles of melon, found at two moments: two registros, and the keypad
  // opens empty the second time — the 1 is counted, not reconciled with the 2.
  await registrar(page, at(MELON).codigo, String(MELON_PILES[0]))
  await open(page, at(MELON).codigo)
  await expect(quantity(page)).toHaveValue('')
  await page.getByRole('button', { name: 'volver a buscar' }).click()
  await registrar(page, at(MELON).codigo, String(MELON_PILES[1]))

  // And one that is registered and then withdrawn from «Mis registros».
  await registrar(page, at(HARINA).codigo, String(TYPED_THEN_WITHDRAWN))
  await tab(page, 'Mis registros').click()
  const harina = page.locator('li', { hasText: at(HARINA).nombre })
  // A person reads the list before tapping: «Deshacer» ignores a tap that
  // lands within the guard window of the list appearing (tapGuard.ts), which
  // is exactly what a test that clicks at machine speed would otherwise do.
  await page.waitForTimeout(READ_MS)
  await harina.getByRole('button', { name: 'Deshacer' }).click()
  await expect(harina).toHaveClass(/row--withdrawn/)
  await expect(page.locator('li.row--withdrawn')).toHaveCount(1)

  // Withdrawn means back on the gap list: it should make somebody deal with
  // the row, not quietly resolve it.
  await tab(page, 'Terminar').click()
  await expect(gaps(page)).toContainText(String(source.items.length - 2))

  // The coverage figure lives in the review body. `.total__` is the block.
  const cobertura = page
    .locator('.panel__figures > div')
    .filter({ has: page.locator('.total__label', { hasText: 'cobertura' }) })
  const before = await coverage(page, cobertura)

  // ---- the tablet screen-locks, or somebody swipes the tab away ----------
  await page.reload()
  await expect(page.getByRole('button', { name: /Bodega/ })).toContainText('2 verificados')
  await page.getByRole('button', { name: /Bodega/ }).click()

  // Every entry came back, in order, the withdrawn one still struck through —
  // folded from the log, not from anything stored resolved.
  await tab(page, 'Mis registros').click()
  const rows = page.locator('ul.rows > li')
  await expect(rows).toHaveCount(4)
  await expect(page.locator('li.row--withdrawn')).toHaveCount(1)
  await expect(page.locator('li.row--withdrawn')).toContainText(at(HARINA).nombre)

  await tab(page, 'Terminar').click()
  await expect(gaps(page)).toContainText(String(source.items.length - 2))
  expect(await coverage(page, cobertura)).toBe(before)

  // ---- review, waive the rest, generate ---------------------------------
  await tab(page, 'Terminar').click()
  await page.getByRole('button', { name: 'Revisar y generar archivo' }).click()
  await page.getByRole('button', { name: 'Ver las cifras del sistema' }).click()
  await page.getByRole('button', { name: 'Exentar artículos sin contar' }).click()
  await page.getByLabel('motivo').fill('bodega cerrada, se cuenta el lunes')
  await page.getByLabel('quién autoriza').fill('marta')
  await page.getByRole('button', { name: 'Firmar exención' }).click()

  await page
    .locator('.reviewbar')
    .getByRole('button', { name: 'Generar archivo', exact: true })
    .click()
  const confirm = page.locator('section[aria-label="generar el archivo para Zeus"]')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    confirm.getByRole('button', { name: 'Generar archivo', exact: true }).click(),
  ])
  await expect(page.getByText('Archivo generado')).toBeVisible()

  // The bytes off the filesystem. Not a Blob read back in page context: what
  // the hotel uploads is a file on a disk, and that is the thing under test.
  const path = await download.path()
  const bytes = new Uint8Array(readFileSync(path))
  expect(download.suggestedFilename()).toMatch(/\.txt$/)

  // ---- the shape of the file, before anything parses it ------------------
  //
  // Done on the raw bytes on purpose. Every assertion below this block goes
  // through `parseTxt`, and a parser is the wrong thing to ask whether a file
  // has the right line endings — it is built to be forgiving about exactly
  // that.
  expect(bytes[bytes.length - 2]).toBe(0x0d)
  expect(bytes[bytes.length - 1]).toBe(0x0a)
  const lines = splitCrlf(bytes)
  expect(lines).toHaveLength(source.items.length)
  for (const [index, line] of lines.entries()) {
    expect(tabs(line), `row ${index + 1} field count`).toBe(ZEUS_FIELD_COUNT - 1)
  }
  // CP850, one byte per character (ZEUS_FORMAT.md §3). 0xa5 is Ñ; a UTF-8
  // encoder would have written 0xc3 0x91 and Zeus would ingest mojibake.
  expect(bytes.includes(0xa5)).toBe(true)
  expect(bytes.includes(0xc3)).toBe(false)

  // ---- and what it says --------------------------------------------------
  const emitted = parseTxt(bytes)
  expect(emitted.items.map((item) => item.idarticulo)).toEqual(
    source.items.map((item) => item.idarticulo),
  )

  // Every column the writer does not own, byte for byte against the .xls the
  // count was taken over. This is the whole claim of the app: it changes two
  // fields and re-emits the other twenty-two exactly as they arrived.
  const sheared: string[] = []
  for (const [index, before] of source.items.entries()) {
    for (let c = 0; c < ZEUS_COLUMNS.length; c++) {
      if (WRITE_SET.has(c)) continue
      if (emitted.items[index].rawRow[c] !== before.rawRow[c]) {
        sheared.push(`row ${index + 1} ${ZEUS_COLUMNS[c]}`)
      }
    }
  }
  expect(sheared).toEqual([])

  const emittedAt = (idarticulo: number) =>
    emitted.items.find((item) => item.idarticulo === idarticulo)!

  // The two counted rows carry exactly what was typed — the melon as the sum
  // of its two registros, which the review is the first screen to show.
  const melon = MELON_PILES[0] + MELON_PILES[1]
  expect(emittedAt(PINA).toma).toBe(TYPED_PINA)
  expect(emittedAt(PINA).diferencia).toBe(TYPED_PINA - at(PINA).existencia)
  expect(emittedAt(MELON).toma).toBe(melon)
  expect(emittedAt(MELON).diferencia).toBe(melon - at(MELON).existencia)

  // And the withdrawn row carries the value *after* the withdrawal — the
  // waiver's existencia, not the 50 somebody typed and took back. If the
  // withdrawal ever stopped winning the fold, this is the field that would
  // carry the lie.
  expect(emittedAt(HARINA).toma).toBe(at(HARINA).existencia)
  expect(emittedAt(HARINA).diferencia).toBe(0)

  // Everything else was waived, so it posts as an explicit no-change
  // (DOMAIN.md §4). 296 signed rows, each one with a name and a motivo in the
  // log — which is what makes them different from an omission.
  const counted = new Set([PINA, MELON])
  const waived = emitted.items.filter((item) => !counted.has(item.idarticulo))
  expect(waived).toHaveLength(source.items.length - counted.size)
  for (const item of waived) {
    expect(item.toma, `idarticulo ${item.idarticulo} toma`).toBe(at(item.idarticulo).existencia)
    expect(item.diferencia, `idarticulo ${item.idarticulo} diferencia`).toBe(0)
  }
})

/** One of the four tabs, by its exact label. */
function tab(page: Page, name: string): Locator {
  return page.locator('.tabs').getByRole('button', { name, exact: true })
}

/** The keypad's field on an open entry card. */
function quantity(page: Page): Locator {
  return page.getByLabel(/cantidad contada/)
}

/** Open an article from the search box: by code with Enter, by name with a tap. */
async function open(page: Page, query: string, pick?: RegExp): Promise<void> {
  await tab(page, 'Contar').click()
  const search = page.getByLabel('buscar artículo')
  await search.fill(query)
  if (pick) await page.getByRole('button', { name: pick }).click()
  else await search.press('Enter')
}

/** One registro: open, type, one tap. There is no second «¿seguro?». */
async function registrar(page: Page, query: string, qty: string, pick?: RegExp): Promise<void> {
  await open(page, query, pick)
  await quantity(page).fill(qty)
  await page.getByRole('button', { name: new RegExp(`^Registrar ${qty} `) }).click()
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
}

/** The «sin registrar» line of the gap review's one section. */
function gaps(page: Page): Locator {
  return page
    .locator('.panel', { hasText: 'Tu sección: Toda la bodega' })
    .locator('.checkrow', { hasText: 'sin registrar' })
}

/**
 * The coverage percentage, read off the review screen and then left again.
 *
 * Goes through the reveal gate each time because the gate is per visit by
 * design (ReviewScreen): leaving for the counting screen unmounts the screen,
 * so coming back asks again rather than staying open behind somebody's back.
 */
async function coverage(page: Page, figure: Locator): Promise<string> {
  await tab(page, 'Terminar').click()
  await page.getByRole('button', { name: 'Revisar y generar archivo' }).click()
  await page.getByRole('button', { name: 'Ver las cifras del sistema' }).click()
  const text = (await figure.textContent()) ?? ''
  await page.getByRole('button', { name: 'volver', exact: true }).click()
  await expect(tab(page, 'Contar')).toBeVisible()
  return text
}

/** Rows, split on CRLF, with the trailing terminator dropped. */
function splitCrlf(bytes: Uint8Array): Uint8Array[] {
  const rows: Uint8Array[] = []
  let start = 0
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      rows.push(bytes.slice(start, i))
      start = i + 2
      i++
    }
  }
  expect(start, 'the file must end on a CRLF, with nothing after it').toBe(bytes.length)
  return rows
}

function tabs(line: Uint8Array): number {
  let found = 0
  for (const byte of line) if (byte === 0x09) found++
  return found
}
