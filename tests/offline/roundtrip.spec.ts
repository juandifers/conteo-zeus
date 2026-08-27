/**
 * The whole job, offline, in one test.
 *
 * `offline.spec.ts` proves the app boots and a session opens with the network
 * switched off. That is the shell. This is the *work*: import a bodega, count
 * it through the real UI with real taps, survive a reload halfway, review it,
 * and read the bytes that reach the filesystem — the artifact somebody uploads
 * to Zeus, off the disk, not out of a Blob in page context.
 *
 * Two of the assertions below cannot be reached from jsdom at all, and they
 * are the reason this file exists rather than another case in
 * `tests/integration.test.ts`:
 *
 * **The mid-count reload.** The in-process integration test already covers
 * "imports, persists, counts, reloads and posts" — through a fake IndexedDB,
 * with no service worker in the loop and no page teardown. This version tests
 * something different: that the Dexie write actually *committed*, in a real
 * transaction, before a real navigation, on a page a worker is controlling.
 * Somebody will run this experiment unknowingly on day one, when a tablet
 * screen-locks in the middle of a shelf.
 *
 * **The undo.** `retract` is the riskiest mechanic in the UI, because it is an
 * append that has to *win* the fold — it does not delete anything. If the
 * ordering is ever wrong, the file carries a number the counter explicitly
 * took back, and no screen anywhere would show it. So one retracted value is
 * followed all the way from the tap to the byte.
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
const MELON = 77 // MELON · KILO · tally mode. Booked at 0, so a count is an overage.
const HARINA = 42 // HARINA PAN AMARILLA · KILO · counted, then taken back

/** What the test types, and what the file must therefore carry. */
const TYPED_PINA = 12.5
const TALLY_TAPS = 3
const TYPED_THEN_RETRACTED = 50

test('counts a bodega with no signal and hands over a file Zeus can read', async ({
  page,
  context,
}) => {
  // The retracted row only proves anything if the number that was taken back
  // is not the number a waiver would produce anyway.
  expect(at(HARINA).existencia).not.toBe(TYPED_THEN_RETRACTED)

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

  const search = page.getByLabel('buscar artículo')

  // A search that only works if accents are folded. Nobody wearing gloves in a
  // cold room is going to produce an Ñ, and the catalogue is full of them.
  await search.fill('pina oromiel')
  await page.getByRole('button', { name: /PIÑA OROMIEL/ }).click()
  // Typed with a comma, which is the separator a Colombian keyboard offers and
  // the one the ERP does not take. The conversion is the app's job.
  await page.getByLabel(/^cantidad contada de/).fill('12,5')
  await page.getByRole('button', { name: /^Guardar/ }).click()

  // Tally mode: the other way a quantity gets into the log, one tap at a time.
  await search.fill(at(MELON).codigo)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Modo conteo' }).click()
  const pad = page.getByRole('button', { name: /^sumar uno a/ })
  for (let tap = 0; tap < TALLY_TAPS; tap++) await pad.click()
  await page.getByRole('button', { name: 'Listo' }).click()

  // And one that is counted and then taken back. The count is real while it
  // lasts — the progress bar moves — and the retraction has to undo that.
  await search.fill(at(HARINA).codigo)
  await search.press('Enter')
  await page.getByLabel(/^cantidad contada de/).fill(String(TYPED_THEN_RETRACTED))
  await page.getByRole('button', { name: /^Guardar/ }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')

  await search.fill(at(HARINA).codigo)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Descartar conteo' }).click()
  await page.getByRole('button', { name: 'volver a buscar' }).click()
  // Back to blocking the post, which is the point of a retraction: it should
  // make somebody deal with the row, not quietly resolve it.
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')

  const cobertura = page.locator('.reviewbar__figure', { hasText: 'cobertura' })
  const before = await coverage(page, cobertura)

  // ---- the tablet screen-locks, or somebody swipes the tab away ----------
  await page.reload()
  await expect(page.getByRole('button', { name: /Bodega/ })).toContainText('2 verificados')
  await page.getByRole('button', { name: /Bodega/ }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')

  // Not just the tally of how many: the numbers themselves came back, folded
  // from the log rather than from anything stored resolved.
  await expect(await readout(page, 'pina oromiel')).toHaveValue('12,5')
  await page.getByRole('button', { name: 'volver a buscar' }).click()
  await expect(await readout(page, at(MELON).codigo)).toHaveValue('3')
  await page.getByRole('button', { name: 'volver a buscar' }).click()
  // And the retracted one is empty and cannot be discarded again.
  await expect(await readout(page, at(HARINA).codigo)).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Descartar conteo' })).toBeDisabled()
  await page.getByRole('button', { name: 'volver a buscar' }).click()

  expect(await coverage(page, cobertura)).toBe(before)

  // ---- review, waive the rest, generate ---------------------------------
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

  // The two counted rows carry exactly what was typed and tapped.
  expect(emittedAt(PINA).toma).toBe(TYPED_PINA)
  expect(emittedAt(PINA).diferencia).toBe(TYPED_PINA - at(PINA).existencia)
  expect(emittedAt(MELON).toma).toBe(TALLY_TAPS)
  expect(emittedAt(MELON).diferencia).toBe(TALLY_TAPS - at(MELON).existencia)

  // And the retracted row carries the value *after* the undo — the waiver's
  // existencia, not the 50 somebody typed and took back. If `retract` ever
  // stopped winning the fold, this is the field that would carry the lie.
  expect(emittedAt(HARINA).toma).toBe(at(HARINA).existencia)
  expect(emittedAt(HARINA).diferencia).toBe(0)

  // Everything else was waived, so it posts as an explicit no-change
  // (DOMAIN.md §4). 295 signed rows, each one with a name and a motivo in the
  // log — which is what makes them different from an omission.
  const counted = new Set([PINA, MELON])
  const waived = emitted.items.filter((item) => !counted.has(item.idarticulo))
  expect(waived).toHaveLength(source.items.length - counted.size)
  for (const item of waived) {
    expect(item.toma, `idarticulo ${item.idarticulo} toma`).toBe(at(item.idarticulo).existencia)
    expect(item.diferencia, `idarticulo ${item.idarticulo} diferencia`).toBe(0)
  }
})

/** Open an item from the search box and hand back its quantity field. */
async function readout(page: Page, query: string): Promise<Locator> {
  const search = page.getByLabel('buscar artículo')
  await search.fill(query)
  await search.press('Enter')
  return page.getByLabel(/^cantidad contada de/)
}

/**
 * The coverage percentage, read off the review screen and then left again.
 *
 * Goes through the reveal gate each time because the gate is per visit by
 * design (ReviewScreen): leaving for the counting screen unmounts the screen,
 * so coming back asks again rather than staying open behind somebody's back.
 */
async function coverage(page: Page, figure: Locator): Promise<string> {
  await page.getByRole('button', { name: 'Revisar y generar archivo' }).click()
  await page.getByRole('button', { name: 'Ver las cifras del sistema' }).click()
  const text = (await figure.textContent()) ?? ''
  await page.getByRole('button', { name: 'volver', exact: true }).click()
  await expect(page.getByLabel('buscar artículo')).toBeVisible()
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
