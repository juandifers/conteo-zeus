# Backend

Vercel serverless functions plus Neon Postgres.

**P2.0** was the schema, the migration runner and one health endpoint.
**P2.1** adds session creation and dispatch: an admin uploads a Zeus export,
divides the bodega between counters, and hands out one link per person.
**P2.2** adds event ingestion and the counter state machine. **P2.3.5** adds the
admin's own append-only chain and the one operation that changes who counts what
after the tablets have gone out. **P2.5** adds the seal, the export and the audit
bundle — the first task that writes something a person uploads. Still no
authentication.

The **counting** screens remain entirely local. The one crossing point is
`GET /api/c/:token`, which runs once, on office wifi, before a tablet leaves the
office — there is no signal in the bodega, so everything a device needs has to
be resident before it gets there.

```
api/
  health.ts             GET   /api/health
  sessions/index.ts     GET   /api/sessions            what exists
                        POST  /api/sessions            a file becomes a draft
  sessions/[id]/
    index.ts            GET   /api/sessions/:id        everything the admin draws
                        PATCH /api/sessions/:id        the session's own settings
    dispatch.ts         POST  /api/sessions/:id/dispatch   borrador -> abierto
    acciones.ts         GET   /api/sessions/:id/acciones  the admin's own chain
                        POST  /api/sessions/:id/acciones  reassign, add, retire,
                                                          seal-without, waive, un-waive
    sync.ts             GET   /api/sessions/:id/sync   cheap, polled: per-counter state
    events.ts           GET   /api/sessions/:id/events heavier, pulled: the log by cursor
    cierre.ts           POST  /api/sessions/:id/sellar    abierto|revision -> sellado
                        POST  /api/sessions/:id/exportar  sellado -> cerrado; writes the .txt
                        GET   /api/sessions/:id/exportar  the stored bytes, base64
                        GET   /api/sessions/:id/bundle    sesion_<id>.json, canonical
      _sellar.ts        sealSession
      _exportar.ts      exportSession, downloadExport
      _bundle.ts        sessionBundle
  c/[token]/
    index.ts            GET   /api/c/:token            one counter's assignment
                        POST  /api/c/:token/events     the push
                        GET   /api/c/:token/resume     where this chain stands
      _events.ts        pushEvents
      _resume.ts        counterResume
  _db.ts                the `Db` port, and the Neon implementation
  _http.ts              request/response, typed structurally
  _store.ts             every statement this backend runs
  _schemaVersion.ts     the version this build expects (a literal — see below)
migrations/
  0000_migrations.sql   the ledger
  0001_init.sql         the schema
  0002_sections_and_dispatch.sql   sections, assignments' section, download state
  0003_sync.sql         the arrival cursor, device binding, clock skew
  0004_admin_actions.sql  the admin's chain, and optimistic concurrency on the partition
                          (P2.4 adds `waiver` and `anular_waiver` to it — no DDL)
  0005_export_bytes.sql   the generated file, stored, so a re-download is provably
                          the same bytes. `sealed_at`, `session_hash`, `exported_at`
                          and `file_hash` have been on `sessions` since 0001
tools/
  migrate.mjs           the runner. Runs in CI, never on a cold start
  verificador.html      the standalone verifier. No build step, no network, no imports
```

## What the functions may import

`api/` sits where `src/ui/` sits: a consumer above `src/app/`. It may import
`src/lib/`, `src/domain/` and `src/app/`, and nothing else —
`tests/boundaries.test.ts` asserts it.

In particular it may **not** import `src/zeus/` directly, and that survived
P2.1 intact even though the server now parses a Zeus file. The ingest path
re-parses `source_bytes` and re-runs the §4.1 integrity check before committing
a session, and it does that through `src/app/ingest.ts` — the one module where
the two vocabularies meet. So there is exactly one implementation of the check
and exactly one place that knows what a CP850 tab-separated row is.

Why re-check at all, when the browser already did: the client is a PWA with a
precaching service worker, so the build that uploads a file may be weeks old and
sitting in a tablet nobody has reloaded. §4.1 exists because a file that parses
is not a file that means anything, and that reasoning does not stop applying at
the network boundary. When the two parses disagree the upload is **refused**,
because the deployed build is the one that will still be running when the count
is posted.

---

## Two drivers, on purpose

| Where | Driver | Why |
|---|---|---|
| `api/health.ts` | `@neondatabase/serverless` | Neon's HTTP protocol. No socket held across a cold start, which is the whole problem a serverless function has with Postgres |
| `tools/migrate.mjs`, `tests/backend/schema.pg.test.ts` | `pg` over TCP | Neon accepts the ordinary protocol, and so does a throwaway Postgres. A migration runner that could only speak to Neon would mean the schema could only be tested against the production provider |

The consequence to know about: **`@neondatabase/serverless` cannot address a
local Postgres.** It rewrites the connection string into an `https://…/sql` URL,
so pointing it at `127.0.0.1` produces `Failed to parse URL from
https://api.0.0.1/sql` rather than a connection error.

That is why `api/health.ts` exports `healthCheck(query, options)` — all of the
decision-making, with no driver in it — and keeps the Neon call to one function
at the bottom. `tests/backend/health.test.ts` exercises every branch with a stub;
what is left in the handler is too small to be wrong. Do not inline the driver
back into the handler.

---

## Local setup

### 1. A throwaway database

Either works. Nothing in `migrations/` is Neon-specific.

**Docker:**

```sh
docker run --rm -d --name conteo-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=conteo_dev \
  -p 5432:5432 postgres:16-alpine

export DATABASE_URL='postgres://postgres:postgres@localhost:5432/conteo_dev'
```

**Homebrew Postgres**, if one is already installed:

```sh
createdb conteo_dev
export DATABASE_URL="postgres://$USER@localhost:5432/conteo_dev"
```

**A Neon branch** — the only option that also exercises `/api/health`, since the
HTTP driver needs a Neon host. Branch production rather than counting against it:

```sh
neonctl branches create --name dev-$USER
neonctl connection-string dev-$USER      # includes ?sslmode=require
```

### 2. Point the repository at it

`.env.local`, which is git-ignored:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/conteo_dev
```

`npm run migrate` reads it through Node's `--env-file-if-exists`, so no `dotenv`
dependency and nothing to import.

### 3. Apply the migrations

```sh
npm run migrate          # apply everything pending
npm run migrate:status   # what is applied, what is pending
npm run migrate:check    # exit 1 if anything is pending (this is what CI asks)
```

### 4. Run the database tests against it

Every `tests/backend/*.pg.test.ts` **skips itself when `DATABASE_URL` is
unset**, so `npm test` on a laptop with no database still runs the whole suite.
To include them:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/conteo_dev \
  npx vitest run tests/backend
```

| Suite | What only a real database can show |
|---|---|
| `schema.pg` | `raw_row text[]`, `cantidad text` and `source_bytes bytea` surviving a round trip through the driver; the constraints refusing what they are supposed to refuse |
| `sessions.pg` | the catalogue reassembling out of Postgres to bytes **identical** to `source_bytes`; the dispatch gate; the counter payload's allowlist over a real response |
| `push.pg` | replay, gap and fork as three distinct outcomes; the finish manifest; device binding; the `bigserial` cursor. `unique (counter_id, seq)` is what makes a replay idempotent and a fork detectable, so none of it means anything without the real constraint behind it |

`schema.pg` wraps everything in a transaction and rolls back in `afterAll`. The
other two own their rows: each is opened with a uuid prefix
(`openTestDb(url, 'a')`) and `reset()` deletes only its own sessions, which
cascades to everything else. **Point them at a throwaway database, not one you
are also using by hand.**

They also take a session-level **advisory lock**, so only one of them runs at a
time. Vitest runs test files in parallel processes against one database, and
these suites are not merely writers — `listSessions` answers with every session
there is, which is the point of the endpoint. Prefixing keeps them from deleting
each other's fixtures; it cannot keep them out of each other's `select *`.
Postgres releases the lock with the connection whatever happens to the process,
which is why it is a lock rather than a configuration change serialising the
nine hundred tests that have nothing to do with a database.

`tests/backend/pgDb.ts` is what makes this possible: every handler takes a `Db`
port and names no driver, so the tests supply a `pg`-backed one. That is not
only about Neon being unreachable locally — it means the SQL in `api/_store.ts`
is *executed* by the suite rather than mocked. A mock proves a handler calls a
function; this proves the query is a query.

### 5. Serve the function locally

```sh
vercel dev
curl -s localhost:3000/api/health | jq
```

Against a Neon `DATABASE_URL` this returns `200 { ok: true, … }` once migrations
are applied. Against a **local** Postgres it returns
`503 database unreachable: … Failed to parse URL …`, for the driver reason
above — that is the endpoint working correctly with a URL it cannot use, not a
bug. Test the logic through `tests/backend/health.test.ts`, and the endpoint
end-to-end against a Neon branch.

---

## Counter links are not authentication

A counter's link is `https://…/#/c/<token>`, where the token is **128 bits from
the platform CSPRNG**, base64url, 22 characters (`src/lib/token.ts`). No
sequential ids, no name-derived slugs, no short codes somebody can read out over
the phone — there is no rate limiter in front of this, and a six-character code
turns "you would have to guess a token" into "you would have to try a few
million times".

**Whoever holds the link has that counter's view of that session.** That is a
bearer credential, it is not authentication, and P2 has:

- no accounts and no passwords;
- no way to revoke a link short of not dispatching the session;
- no way to tell two people using one link apart — `fetch_count` says a link was
  used three times, not by whom.

This is a **known and accepted limitation of P2**, not an oversight. What the
link exposes on the read side is bounded on purpose: the assignment response is
built from an allowlist (`src/domain/counterView.ts`) and carries `idarticulo`,
`codigo`, `nombre`, `presentacion` and `unidad` — no `existencia`, no `costo`,
no posting parameters. A leaked link is somebody seeing which articles a counter
was asked to walk.

**From P2.2 the token can also write, and the argument above no longer covers
it.** A token that can push events is a way to submit counts attributed to
somebody else. Nothing in this task pretends otherwise; what it does is make
every device that used a link **visible** rather than making the link harder to
guess:

- `counters.device_id` and `first_device_at` — the tablet that pushed first;
- `counters.device_ids_seen` — every tablet that has ever pushed for this
  counter, in the order they appeared, never trimmed to the latest;
- `counters.forked` — two chains claiming one `seq`, latched, because the losing
  events were never stored and there is nothing left in `events` to derive it
  from afterwards;
- a distinct `DEVICE_COLLISION` answer when the counter is already bound to a
  different tablet, so "two people scanned the same QR" does not reach somebody
  as "bad wifi".

**Device binding never rejects.** A tablet dies mid-shift and the counter picks
up a spare; a hard block would cost them their morning to prevent something a
warning handles. What the columns above convert is a silent attribution problem
into a loud one, which is all the token model can honestly offer.

Two smaller consequences worth naming:

- The push refuses an unscoped `retract` with `422 RETRACT_SIN_SCOPE`. That is
  the P2.2 gate, enforced here because the client is a PWA whose cached build
  may be weeks old.
- `GET /api/c/:token/resume` is a **separate route**, not a widening of the
  allowlist. It answers with chain position and counter state — a sequence
  number, a hash, an enum — so that a replacement tablet does not start over at
  `seq 1` and fork. The assignment endpoint next door is unchanged, and
  `tests/blindCount.test.ts` and `tests/domain/counterView.test.ts` still assert
  exactly what they asserted before, over exactly the same object.

**From P2.3.5 a retired counter's link keeps accepting pushes and stops handing
out an assignment.** That is a policy call rather than a technical one and it
went the way it did because revoking a token is the one action guaranteed to
strand whatever is still on that tablet — and the tablet may be holding the only
copy of somebody's morning. `GET /api/c/:token` answers `409 COUNTER_RETIRED`
with a sentence that does not blame the counter; `POST /api/c/:token/events` and
`/resume` go on working, so a drain that starts at five o'clock still lands.

Authentication is deferred, not dismissed.

---

## The admin's own chain (P2.3.5)

`POST /api/sessions/:id/acciones` is **one endpoint for four things**, because
«Luis se fue enfermo», «metamos a Carla», «María nunca llegó» and «Ana que ayude
con abarrotes» are one operation: reassigning articles between counters while a
session is open, sometimes with a counter created or retired alongside.

    { kind: 'reasignar',            usuario, motivo, version, moves, nuevos? }
    { kind: 'retirar_contador',     usuario, motivo, counterId }
    { kind: 'sellar_sin_registros', usuario, motivo, counterId }

Adding a counter is a `reasignar` carrying `nuevos`: P2.1 leaves nothing
unassigned, so somebody added at eleven cannot arrive empty-handed, and the link
and the shelves are minted in one transaction. Two rows go onto the chain —
`agregar_contador` and `reasignar` — and the response carries the token for the
printable sheet.

Every write is guarded inside its transaction, in the shape `dispatchStatements`
established and for the same reason: Neon's HTTP protocol has no session to hold
an interactive transaction open across, so the decision is taken outside it, and
**an unmatched `update` raises nothing**. There are two predicates:

- **`prechecked`**, on the statement that appends the actions — the session is
  still open, `assignments_version` is still what the admin planned against,
  every `from` really does hold its article, and the action chain is where the
  handler read it;
- **`landed`**, on everything after it — the action row at the chain's new head
  is ours, by hash. The first predicate is no longer true of the transaction's
  own state by then, which is the same trick `insertEventsStatements` uses after
  its insert has moved `max(seq)`.

So either the actions were appended, in which case every precondition held, or
nothing at all happened. **There is no ordering in which the partition moves and
the record of why does not.**

`sessions.assignments_version` is optimistic concurrency over the partition, and
a mismatch is a `409` and a reload. Move lists are never merged.

**P2.4 adds two kinds to the same chain, and no table beside it.**

    { kind: 'waiver',        usuario, motivo, idarticulo: number[] }
    { kind: 'anular_waiver', usuario, motivo, waiverId }

A waiver writes nothing but its own row. What it changes is what the **fold**
sees, and it does that by *being on the chain*: `waiversToEvents` projects the
standing waivers into `unchanged` events on every read, so there is deliberately
no table of waived articles to fall out of step with the log — and
`anular_waiver` is one row rather than a deletion.

The handler does **not** check whether a waived article has already been counted,
and that omission is the design. A tablet syncing an hour from now would make any
answer it gave wrong; §4b is decided at fold time, against articles that resolve
to `untouched` from counter events alone, which is what makes the outcome
independent of when a device reached wifi. A waiver on a counted row is accepted,
does nothing, and is reported as superseded.

**`session_actions.payload` never carries a quantity.** The waived value is
`existencia` from `catalog_rows`, read where it lives; a copy in the payload
would be a second figure that can disagree with the first. `tests/gate.test.ts`
asserts it over every payload type, and the pg suite asserts it against what is
actually stored.

Payloads are `jsonb` because they are heterogeneous and none of them
participates in the fold — the opposite of `events.cantidad text`, which is a
string precisely because it does. They are still hashed, so the hash is taken
over a key-sorted canonical rendering (`canonicalJson`), which is what survives
`jsonb` not preserving key order; and that function refuses anything but safe
integers among the numbers, since an admin action carries no quantity and `1.0`
does not come back out as it went in.

---

## The seal and the export (P2.5)

    revisión ──sellar──▶ sellado ──generar──▶ cerrado

**Two endpoints and never one.** «Download the file, then close the session»
cannot be defended: if a tablet can still drain between generating and closing,
the `.txt` corresponds to no recorded state. `POST /sellar` freezes both chains
and records `session_hash`; `POST /exportar` is allowed only from `sellado` and
writes bytes that are a deterministic function of a set that can no longer change.

`POST /sellar` refuses unless `sessionReadyToSeal` returns no **blocking**
reasons. The advisory tier is a checklist, not a gate. The only route past a
blocking reason is `sinRegistros` in the body, which appends
`sellar_sin_registros` **inside the same transaction, before the seal**, so the
record of whose work was skipped is inside the chain the hash covers. There is no
force flag and there must not be one: the value of the gate is that it cannot be
satisfied by assertion.

`sealStatements` guards its update on the state, on `session_hash is null`, and
on the action chain being exactly where the hash was taken over. An empty result
is another admin sealing, or an action landing between the read and the write,
and in both cases nothing was written.

### Nothing can be appended between the seal and the export

The push handler reads the session's state outside any transaction, which leaves
a window. `insertEventsStatements` therefore repeats the check as a predicate on
the insert **and** takes the session row `for share`, while `sealStatements` takes
it `for update`. A push and a seal cannot overlap; two pushes still can, which is
the normal afternoon. Lock order is the same everywhere here — the session first,
then the counter — so none of these paths can deadlock.

`sealed_at` and `exported_at` are stamped by `now()` **in SQL**, not by the
handler. `events.server_at` defaults to the same clock, and the two are compared
to answer «did anything arrive after the seal»; a function running a few seconds
behind its database would make legitimately earlier events look late.

### The export runs here, and the bytes are kept

Generation goes through `src/app/writeAdjustment` — `api/` may not import
`src/zeus/` — and `verifyWriteBack` **aborts** it. Nothing catches that throw and
the session stays `sellado`, so a failure costs a button press. It is the check
that catches the sheared-file class, and there is no correct version of «export
it anyway».

`sessions.export_bytes` holds what was hashed. `GET /exportar` serves those bytes
base64 in a JSON body — `send` writes JSON and only JSON (`_http.ts`), and base64
is exact — and **never a regeneration**: a second run of the writer would be «a
file that ought to be identical», which is the claim `file_hash` exists to replace
with a fact.

### The bundle

`GET /bundle` answers from `sellado` onwards with `canonicalJson` of everything
needed to recompute the seal without this application: the catalogue including
`raw_row`, every event with its `prevHash`/`hash`, every action with its chain
fields, and the digests. Canonical means byte-stable, so two downloads of one
sealed session are the same file. **No counter token is in it**: a link is a
bearer credential, and the acta names people while the chain identifies them by
id.

---

## Migrations

### The rules

- **Filenames are the order**: `NNNN_lower_snake.sql`. The runner refuses a name
  it cannot parse, because a name the sort cannot read is a migration that runs
  whenever.
- **A migration is immutable once applied.** The runner records the SHA-256 of
  the file's bytes and refuses to proceed if the text has changed since. Add a
  new migration; do not edit a shipped one.
- **The migration and its ledger row commit together**, in one transaction.
  Postgres runs DDL transactionally, so a migration that fails halfway leaves
  nothing behind — and one that succeeds without recording itself, which would
  make the next run reapply it, cannot happen.
- **They run in CI, never on a cold start.** A function that migrated on boot
  would run DDL from however many concurrent cold starts a deploy produced,
  against a database several of them are already reading.

### Adding one

1. `migrations/0002_whatever.sql`.
2. Bump `EXPECTED_MIGRATION_VERSION` in `api/_schemaVersion.ts` **in the same
   commit**. `tests/backend/migrations.test.ts` fails if the two drift.
3. `npm run migrate` locally, then run the suite.

The literal in `_schemaVersion.ts` is a literal rather than a read of
`migrations/` because the serverless bundle does not carry that directory —
`.vercelignore` keeps repository material off the build host — and a function
that inspected the filesystem to decide what "up to date" means would be
answering a question about the deploy with a question about the disk.

### Why `/api/health` fails when migrations are behind

A deploy whose code is ahead of its schema looks like nothing at all until the
first write. The function boots, the pool connects, and then a query names a
column that is not there. The endpoint cannot fix that, so it refuses to say it
is fine, with **503** — the deploy is not broken, it is not ready, and a load
balancer should treat those the same way.

It distinguishes the two directions, because they are different incidents:

| Situation | Message |
|---|---|
| database behind the build | `migrations are behind: database is at N, this build expects M` |
| build behind the database | `this deploy is older than the schema` |

The second must not read as the first, or somebody is sent to migrate a database
that is already further along than the code.

---

## Deployment

Set on the Vercel project (Settings → Environment Variables):

| Variable | Where | Value |
|---|---|---|
| `DATABASE_URL` | Production, Preview | Neon **pooled** connection string (`…-pooler.…`), `?sslmode=require` |

`VERCEL_GIT_COMMIT_SHA` is provided by Vercel and appears in the health response
as `buildSha`, so a stale deploy is nameable rather than merely suspected.

Use the **pooled** endpoint. Serverless invocations open connections
independently and a direct endpoint exhausts Neon's connection limit under any
real concurrency. The HTTP driver is what keeps that manageable, and the pooler
is what keeps it correct.

`DATABASE_URL` is also a GitHub Actions secret, on the `Production`
environment, used by the `deploy-migrations` job. That job runs only on the
repository's **default branch**, only on push, and only after the checks pass: a
migration applied from a feature branch would move the schema under a production
deploy that has not shipped yet.

The branch is read from `github.event.repository.default_branch` rather than
named. It was pinned to `main`, this repository's default branch is `master`,
and the job therefore never ran once — silently, because a skipped job still
shows a green tick. The schema fell behind the deploy and the only thing that
said so was `/api/health`.

The same pooled string serves both. If the migration runner ever objects to the
pooler — `pg` over a transaction-mode pooler can trip over prepared statements
that plain queries do not — give the GitHub secret Neon's **unpooled** host
instead and leave Vercel on the pooled one. The functions are the side that
needs pooling; a migration is one connection, once.

### Routing

`vercel.json` rewrites `/((?!api/).*)` to `index.html` rather than `/(.*)`, so
the SPA fallback cannot swallow the API. The service worker denies `/api/` its
navigation fallback for the same reason (`vite.config.ts`) — that only ever
affected typing the URL into the address bar rather than `fetch`, but a health
endpoint that answers `index.html` to the person checking whether the deploy is
up is worse than one that is missing.

### Nine functions, and why the routes do not match the files

A deployment on Vercel's Hobby plan may contain **twelve** serverless functions.
P2.5 brought the count to thirteen, and from that commit every deployment
failed to build. Nothing said so where anyone was looking: CI was green, the
frontend kept working, and production went on serving the last deployment that
had built — which predated the entire backend. The whole API was answering
`FUNCTION_INVOCATION_FAILED` from code that had never shipped.

So two groups were merged, on the two axes where the routes were already one
thing. `api/sessions/[id]/cierre.ts` answers `sellar`, `exportar` and `bundle` —
one sequence over one row, where the ordering between them *is* the design.
`api/c/[token]/index.ts` answers the token's own route plus `events` and
`resume` — three answers about the same counter, in the same session, over the
same chain. That leaves nine, and room.

The URLs did not change. `vercel.json` rewrites the five folded paths onto their
host function with an `_op` query parameter, and rewrites are applied only after
the filesystem is checked — so they fire precisely because the files they name
no longer exist. No client knows any of this happened.

Neither did the reasoning move. `sealSession`, `exportSession`, `downloadExport`,
`sessionBundle`, `pushEvents` and `counterResume` are unchanged in `_`-prefixed
modules beside their host; the prefix is the whole mechanism, since Vercel does
not count a file starting with `_` as an endpoint. The dispatchers choose a
function and map a method to a status code, and the pg tests call the underlying
functions directly, as they always did.

The cost of this is that a route is no longer one file, which is a real loss —
the map above is now the only place the two line up. It is worth knowing that
adding a fourth endpoint group means merging again, not adding a file.

### How the functions get compiled, and why every import carries `.js`

Nothing bundles the serverless functions. Vercel's builder transpiles each
`api/**/*.ts` to a standalone `.js`, traces the graph with `nft`, and ships the
files with their import specifiers exactly as written. `package.json` says
`"type": "module"`, so what runs is real ESM — no extension search, no directory
index. Every relative import in `api/` and in the four `src/` subtrees it reaches
therefore ends in `.js`, and a directory import is spelled `/index.js`.

`tests/moduleSpecifiers.test.ts` holds that, over exactly `tsconfig.api.json`'s
`include` list. `src/ui/` and the tests are outside it deliberately: those are
resolved by Vite, which does search, and the rule there would be a convention
rather than a constraint.

`api/tsconfig.json` exists for the same reason and does nothing else. The builder
does not read project references — for each entrypoint it walks *up* looking for
a `tsconfig.json` and extends the first one it finds. Left alone the walk reached
the root `tsconfig.json`, a solution file with `"files": []` and no
`compilerOptions`, so the functions compiled under TypeScript's defaults:
`moduleResolution: nodenext`, no `node` types. `api/tsconfig.json` extends
`../tsconfig.api.json`, which is what makes the deployed functions compile the
way the repository checks them.

Both were one outage. Every route answered `FUNCTION_INVOCATION_FAILED`, because
every function threw `ERR_MODULE_NOT_FOUND` before its first line ran. The build
was green: the builder prints TypeScript diagnostics and deploys anyway. The
frontend was fine, the migrations were applied, `/api/health` was a 500 with no
body, and nothing in CI had an opinion — the checks run under Vite and Vitest,
where extensionless specifiers resolve. That is the whole reason the guard is a
test and not a fixed commit.

---

---

## What the schema decides

`migrations/0001_init.sql` carries the reasoning at each column. Four are worth
repeating because getting them wrong is silent:

- **`events.cantidad` is `text`.** Quantities are decimal, `21 - 20.8` is
  `0.20000000000000107` in IEEE754, and `ZEUS_FORMAT.md` §3's
  shortest-representation rule would write that verbatim into the ERP. The
  canonical decimal string is what `src/domain/chain.ts` hashed, so it is what
  must be stored. A `numeric` column a driver round-trips through a float breaks
  the chain silently, and a broken chain is indistinguishable from a tampered
  one. `events.client_at` is `text` for the same reason.
- **`catalog_rows.raw_row` is `text[]`.** `writeTxt` re-emits the 22 columns it
  has no business touching from the source row; those bytes must survive the
  server untouched. `existencia` and `costo` are duplicated as `numeric` for
  admin queries and are **never a posting input**.
- **`sessions.source_bytes` is stored.** `verifyWriteBack` re-parses the emitted
  file against the source it came from, and export must not depend on whoever is
  sealing still having the original `.xls` on their machine.
- **`unique (counter_id, seq)`** is the single most important constraint here. It
  makes pushes idempotent under retry, makes gaps detectable, and gives the chain
  something to anchor on.

Two more, from P2.1's `0002`:

- **`catalog_rows.ord`.** Zeus does not always export in ascending `idarticulo`
  — the verified bodega 22 file is `91069` then `15450` (ZEUS_FORMAT.md §7.5) —
  so a catalogue read `order by idarticulo` silently re-sorts itself away from
  the shelf and the printed list. P2.0's table had a key and no order.
  `src/store/db.ts` has carried the same column since P1 for the same reason.
- **`catalog_rows.ultimo_conteo`.** DOMAIN.md §5's exposure estimate needs the
  prior count, and it lives in the `conteo1` column of the source row. Digging
  it out of `raw_row` by index would put knowledge of the file format in a
  serverless function, which is the one thing that array exists to avoid.

And three from P2.2's `0003`:

- **`events.server_seq bigserial`**, with `events_cursor_idx` on
  `(session_id, server_seq)`. `seq` is one counter's own numbering and says
  nothing about when the server learned of an event; a monitoring screen needs
  an arrival order. It carries the standard cursor trap — the value is taken
  from the sequence at insert and the row becomes visible at commit, so a lower
  `server_seq` can appear *after* a higher one — and the fix is not a watermark
  table and not an advisory lock, both of which put a serialisation point in
  front of the write path to protect a read. Events are immutable and keyed by a
  device-generated uuid, so `/api/sessions/:id/events` **overlaps and
  deduplicates**: it reads from `cursor - 400` and the client merges by `id`.
  Redelivery costs nothing; a skipped event is a wrong total on a screen
  somebody signs.
- **`counters.clock_skew_ms`.** Signed, kept at its largest magnitude ever seen
  rather than its latest value. Skew cannot change any total — the fold is
  commutative under P2 rules (DOMAIN.md §6.2) — it corrupts the audit timeline,
  which matters for the acta. So it is recorded, surfaced, and **never
  corrected**: rewriting a device's timestamps would change the hashes and break
  the chain to fix a cosmetic problem.
- **`assignments_session_id_idarticulo_fkey` gained `on delete cascade`**, which
  is a fix to `0001` rather than a new feature. Without it, deleting a session
  cascades to `catalog_rows` and to `counters` in an order Postgres does not
  promise, and the delete can fail on the assignment rows that are still there.
  Nothing in the application deletes a session today, which is why it went
  unnoticed; "a session cannot reliably be deleted" is not a property worth
  keeping.

And two from P2.3.5's `0004`:

- **`session_actions`, one chain per session.** An admin decision an auditor
  will ask about had nowhere to live: `events` is per counter and anchored to
  counter identity. Not a role column on `counters` either — that table carries
  a token, a bound device, a `final_seq`, a manifest and four counting states,
  and an admin has none of those meanings. One sequence rather than one per
  admin, because admin actions happen at a desk, one at a time.
- **`sessions.assignments_version`.** Optimistic concurrency over the partition,
  checked under the row lock. Two admins reassigning at once is P2.2's
  transaction bug with a worse blast radius: the second write would silently
  reverse the first, whereas dispatch at least refuses the loser outright.

And one absence: **`counters.estado` has no `terminado_local`.** That is a
device-side state the server cannot observe — with no connectivity in the
bodega, a counter who recorded nothing looks exactly like a counter whose tablet
is holding 200 queued events. The server knows only what arrived:
`terminado_confirmado` when a `finish` event is present *and*
`verifyChain` (`src/domain/chain.ts`) confirms the chain is complete to
`final_seq`, `terminado_incompleto` when it is present and the chain is not.

There **is** one state in that column the server does not derive:
`retirado` (P2.3.5). It is an admin decision recorded in `session_actions` with a
reason, and it is sticky by an explicit `case` in the push's counter update — a
late drain from a retired counter's tablet is welcome and is not a claim about
whether they are still counting.

`src/domain/chain.ts` is imported **unchanged** by both sides. There must not be
a second implementation of the hash on the server, in any language;
`tests/boundaries.test.ts` asserts that `api/` reaches the domain, and never
`src/zeus/` directly, `src/store/` or `src/ui/`. It reaches the file format only
through `src/app/` — see *What the functions may import*.
