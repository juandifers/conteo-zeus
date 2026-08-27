#!/usr/bin/env node
/**
 * What the local suite cannot know: whether the *deployment* serves the app.
 *
 *   node tools/verify-deploy.mjs https://conteo.example.app
 *
 * `tests/offline/` runs against `vite preview` over plain HTTP on localhost.
 * It proves the built app works offline; it proves nothing about a CDN in
 * front of it, and a CDN is where the one unfixable failure lives.
 *
 * **A pinned service worker cannot be repaired from outside the tablet.** If
 * `/sw.js` is served with a long max-age, or `immutable`, or an SPA rewrite
 * answers it with `index.html`, the browser keeps the worker it has. Every
 * later deploy is invisible; the update notice never appears because there is
 * nothing to notice; and the fix requires somebody to clear site data on each
 * tablet by hand. It is the reason this script exists and the reason its first
 * check is the strictest.
 *
 * Run it against the deployed URL before the tablets are handed out. It is not
 * part of the test suite: there is nothing local for it to check.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')

const base = process.argv[2]
if (!base || base.startsWith('-')) {
  console.error('uso: node tools/verify-deploy.mjs <url-base>')
  console.error('ejemplo: node tools/verify-deploy.mjs https://conteo.example.app')
  process.exit(2)
}
const origin = base.replace(/\/+$/, '')

let failures = 0
let checks = 0

function report(ok, label, detail) {
  checks++
  if (!ok) failures++
  const mark = ok ? '  ok  ' : ' FALLA'
  console.log(`${mark}  ${label}${detail ? `\n          ${detail}` : ''}`)
}

/** Fetch without letting any cache in the middle answer for the origin. */
async function get(path, init = {}) {
  const url = `${origin}${path}`
  try {
    const response = await fetch(url, { redirect: 'follow', ...init })
    return { url, response, body: await response.text() }
  } catch (cause) {
    return { url, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * The precache manifest, read out of the local build.
 *
 * From `dist/` rather than from the deployed `sw.js`, deliberately: the
 * question this script answers is whether *this* build is intact on the other
 * end, and reading the list from the deployment would make it agree with
 * itself no matter which build is up there. The hash-named asset URLs make a
 * stale deployment fail loudly rather than silently pass.
 */
function precacheEntries() {
  let source
  try {
    source = readFileSync(join(DIST, 'sw.js'), 'utf8')
  } catch {
    console.error(
      'no hay dist/sw.js — corre `npm run build` antes, contra el mismo commit que está desplegado',
    )
    process.exit(2)
  }
  const urls = [...source.matchAll(/\{url:"([^"]+)"/g)].map((match) => match[1])
  if (urls.length === 0) {
    console.error('dist/sw.js no contiene un manifiesto de precache reconocible')
    process.exit(2)
  }
  return urls
}

// ---- 1. the service worker ------------------------------------------------

async function checkServiceWorker() {
  const { response, body, error } = await get('/sw.js', { cache: 'no-store' })
  if (error || !response) return report(false, '/sw.js responde', error)

  report(response.status === 200, '/sw.js responde 200', `status ${response?.status}`)

  const cacheControl = (response.headers.get('cache-control') ?? '').toLowerCase()
  // What is actually required is "revalidate before you use this", and there
  // are two spellings of it: the `max-age=0, must-revalidate` vercel.json
  // sets, and the bare `no-cache` that `vite preview` sends. Both are correct
  // and both are accepted — a checklist that prints a red line for a correct
  // header is a checklist people learn to read past, which costs more than the
  // strictness buys.
  //
  // `s-maxage` is the trap this is really guarding: it is invisible to the
  // browser and tells the CDN to keep serving the old worker, so the tablet
  // asks, is answered 200, and is handed yesterday's build for as long as the
  // directive lasts.
  const revalidates =
    (/(^|,|\s)max-age=0(\s|,|$)/.test(cacheControl) && cacheControl.includes('must-revalidate')) ||
    /(^|,|\s)no-cache(\s|,|$)/.test(cacheControl) ||
    /(^|,|\s)no-store(\s|,|$)/.test(cacheControl)
  report(
    revalidates,
    '/sw.js se revalida en cada arranque',
    `Cache-Control: ${cacheControl || '(ausente)'}`,
  )
  report(
    !cacheControl.includes('immutable') && !cacheControl.includes('s-maxage'),
    '/sw.js no lleva immutable ni s-maxage',
    `Cache-Control: ${cacheControl || '(ausente)'}`,
  )

  const vercelCache = response.headers.get('x-vercel-cache')
  report(
    vercelCache === null || vercelCache.toUpperCase() !== 'HIT',
    '/sw.js no sale de la caché del CDN',
    vercelCache === null ? 'sin cabecera x-vercel-cache (no es Vercel, o no la expone)' : `x-vercel-cache: ${vercelCache}`,
  )

  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  report(
    type.includes('javascript'),
    '/sw.js se sirve como JavaScript',
    `Content-Type: ${type || '(ausente)'}`,
  )
  // The SPA rewrite swallowing /sw.js is the failure that looks like nothing:
  // the worker "registers" against an HTML document, and the app is simply
  // never offline-capable. Checked on the body because a rewrite can serve
  // index.html under any content type it likes.
  report(
    !/^\s*<!doctype html/i.test(body ?? '') && (body ?? '').includes('precacheAndRoute'),
    '/sw.js es el worker y no el index.html reescrito',
    (body ?? '').slice(0, 60).replace(/\s+/g, ' '),
  )
}

// ---- 2. the manifest and its icons ----------------------------------------

async function checkManifest() {
  const { response, body, error } = await get('/manifest.webmanifest')
  if (error || !response) return report(false, '/manifest.webmanifest responde', error)

  report(response.status === 200, '/manifest.webmanifest responde 200', `status ${response.status}`)
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  report(
    type.includes('application/manifest+json'),
    '/manifest.webmanifest se sirve como application/manifest+json',
    `Content-Type: ${type || '(ausente)'}`,
  )

  let manifest
  try {
    manifest = JSON.parse(body)
  } catch (cause) {
    return report(false, '/manifest.webmanifest es JSON', String(cause))
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  report(icons.length > 0, 'el manifiesto declara iconos', `${icons.length} iconos`)

  for (const icon of icons) {
    const path = new URL(icon.src, `${origin}/`).pathname
    const result = await get(path)
    if (result.error || !result.response) {
      report(false, `icono ${path}`, result.error)
      continue
    }
    const iconType = (result.response.headers.get('content-type') ?? '').toLowerCase()
    report(
      result.response.status === 200 && iconType.startsWith('image/'),
      `icono ${path} (${icon.purpose ?? 'any'})`,
      `status ${result.response.status}, Content-Type: ${iconType || '(ausente)'}`,
    )
  }
}

// ---- 3. every file the worker is going to precache -------------------------

async function checkPrecache() {
  const entries = precacheEntries()
  console.log(`\n  ${entries.length} entradas en el precache de dist/sw.js\n`)
  let missing = 0
  for (const entry of entries) {
    const path = `/${entry.replace(/^\//, '')}`
    const { response, error } = await get(path)
    const ok = !error && response?.status === 200
    if (!ok) {
      missing++
      report(false, `precache ${path}`, error ?? `status ${response?.status}`)
    }
  }
  report(
    missing === 0,
    `las ${entries.length} entradas del precache responden 200`,
    missing === 0 ? undefined : `${missing} no responden — el despliegue no es este build`,
  )
}

/**
 * Nothing the app loads may come from another origin.
 *
 * The offline guarantee is cache-first precaching, and precaching only covers
 * this origin. A CDN reference that creeps into the HTML or the stylesheet —
 * a font host, an analytics tag — is a request that fails in a cooler and,
 * worse, *succeeds* behind a hotel captive portal, which answers 200 with a
 * login page. This is the deployed half of the audit; the source half is a
 * grep, and a grep does not see what a build injects.
 */
async function checkNoForeignOrigins() {
  const { response, body, error } = await get('/')
  if (error || !response) return report(false, '/ responde', error)

  const documents = [{ path: '/', text: body }]
  for (const href of [...body.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1])) {
    const sheet = await get(new URL(href, `${origin}/`).pathname)
    if (sheet.body) documents.push({ path: href, text: sheet.body })
  }

  for (const { path, text } of documents) {
    const foreign = [...text.matchAll(/(?:src|href|url\()\s*=?\s*["']?(https?:\/\/[^"')\s]+)/g)]
      .map((match) => match[1])
      .filter((url) => !url.startsWith(origin))
    report(
      foreign.length === 0,
      `${path} no referencia ningún otro origen`,
      foreign.length === 0 ? undefined : foreign.join(', '),
    )
  }
}

console.log(`\nverificando ${origin}\n`)
await checkServiceWorker()
await checkManifest()
await checkNoForeignOrigins()
await checkPrecache()

console.log(
  `\n${failures === 0 ? 'todo en orden' : `${failures} de ${checks} comprobaciones fallaron`}` +
    ` — ${checks} comprobaciones\n`,
)
process.exit(failures === 0 ? 0 : 1)
