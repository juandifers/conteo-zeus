# conteo-zeus

Physical inventory counting for a hotel bodega, built against Zeus (the
hotel's ERP) exports. A supervisor uploads a Zeus `.xls`, splits it into
sections, and hands each counter a link. Counters count blind — no screen
ever shows a book quantity — so the count tests the books instead of quietly
confirming them. The admin reviews, seals, and generates a `.txt` in Zeus's
own format to post back.

Two halves that share a domain model but never import from each other:

- **Counting** (`src/ui/counter`) — offline-first PWA. Everything renders
  from Dexie (IndexedDB); nothing waits on a request, because there's no
  signal in the bodega. Events sync to the server opportunistically.
- **Admin** (`src/ui/admin`) — dispatch, live sync monitoring, review,
  seal, export. Talks to Postgres through Vercel serverless functions
  (`api/`).

Counts are an append-only event log, folded rather than mutated, so two
tablets' offline logs merge by sorting rather than by conflict resolution.
The reasoning behind all of that — why counters can't see the ERP's numbers,
how retraction and reassignment work, what the server can and can't
guarantee — is written down in `docs/DOMAIN.md`. It's long, and it's the
actual spec; read it before changing anything in `src/domain/`.

## Stack

React 19 + TypeScript + Vite, Dexie on the device, Postgres (Neon) behind
Vercel functions on the server, vitest + Playwright for tests.

## Running it

```sh
npm install
npm run dev
```

The counting screens work with nothing else running. The admin screens need
a database — see below.

## Backend

```sh
docker run --rm -d --name conteo-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=conteo_dev \
  -p 5432:5432 postgres:16-alpine

export DATABASE_URL='postgres://postgres:postgres@localhost:5432/conteo_dev'
npm run migrate
vercel dev
```

`npm run migrate:status` shows what's applied; `npm run migrate:check` is
what CI runs. Full detail — schema reasoning, the two Postgres drivers, why
`api/health` returns 503 when the schema is behind — is in `docs/BACKEND.md`.

## Tests

```sh
npm test               # everything that doesn't need a database
npm run test:offline   # Playwright, PWA/offline behaviour
DATABASE_URL=... npx vitest run tests/backend   # needs a real Postgres
```

`tests/boundaries.test.ts` and `tests/gate.test.ts` enforce the architectural
rules (module import direction, which event kinds each layer may write) by
reading the source — treat a failure there as the rule catching a real
violation, not as a test to relax.

## Docs

- `docs/DOMAIN.md` — the counting model: events, blind counting, sessions,
  sections, review
- `docs/BACKEND.md` — API routes, schema, migrations, deployment
- `docs/ZEUS_FORMAT.md` — the Zeus file format, byte by byte
- `docs/MIGRATION-P1-P2.md` — folding old single-device sessions into the
  dispatched model
- `docs/PRIMERA-CORRIDA.md` — the checklist for the first real session
