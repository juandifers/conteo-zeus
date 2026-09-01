-- P2.1 — the pieces session creation and dispatch need that P2.0 did not have.
--
-- A separate migration rather than an edit to 0001: a migration is immutable
-- once applied, the runner records the SHA-256 of its bytes and refuses to
-- proceed if the text has changed, and 0001 has been applied (docs/BACKEND.md).

-- A named bucket of articles, held by one counter.
--
-- Sections are **ours**. The ERP has no concept of one, nothing about a section
-- is ever written back into a Zeus file, and `ubicacion` stays empty
-- (ZEUS_FORMAT.md §9). What a section is for on our side is `zona`: its name is
-- stamped on every event a counter emits for the articles in it, which is the
-- modelling move DOMAIN.md §6 said to make once — `zona` stops being a
-- keystroke a counter picks from a dropdown and becomes item data, assigned
-- before anybody counts.
create table sections (
  id         uuid primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  nombre     text not null,
  -- Nullable while the admin is still building the partition; a section with no
  -- counter is a blocker at dispatch (src/domain/assignment.ts), not a row the
  -- database refuses. `set null` rather than `cascade`: deleting a counter must
  -- not silently delete the articles they were holding, it must produce a
  -- visible gap the admin has to reassign.
  counter_id uuid references counters(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Two sections with one name on one printed sheet is two places nobody can
  -- tell apart.
  unique (session_id, nombre)
);

create index sections_session_idx on sections (session_id);
create index sections_counter_idx on sections (counter_id);

-- Which section an assignment was made through.
--
-- `not null`, which is only possible because no assignment exists yet. If this
-- migration ever meets a populated table it fails, and that is the right
-- outcome: an assignment with no section is an article whose events would carry
-- no `zona`, and inventing one here would be this file deciding where somebody
-- stood.
--
-- `on delete cascade` from `sections`: dissolving a section releases its
-- articles, which then show up as an uncovered gap the dispatch gate refuses.
-- That is the intended editing motion before dispatch — the alternative,
-- orphaned assignment rows pointing at a section that no longer exists, is the
-- same articles unreachable instead of visibly unassigned.
alter table assignments
  add column section_id uuid not null references sections(id) on delete cascade;

create index assignments_section_idx on assignments (section_id);

-- Has this counter's device pulled its assignment yet?
--
-- There is no signal in the bodega, so the tablet has to be loaded on office
-- wifi and dispatch is the last moment anybody can notice that one was not. The
-- admin screen reads this as `pendiente` / `descargado` with a timestamp.
--
-- `fetch_count` alongside it because the two answer different questions: a
-- timestamp says a device fetched, a count says *this* device is one of three
-- that did — which is what a shared tablet handed round the office looks like,
-- and worth being able to see.
alter table counters add column fetched_at  timestamptz;
alter table counters add column fetch_count integer not null default 0;

-- When the session was dispatched. `estado` already carries *that* it was;
-- this is the instant, which is what a printed sheet is dated by and what an
-- argument about when the tablets were handed out is settled with.
alter table sessions add column dispatched_at timestamptz;

-- The prior count, beside the balance it is compared against.
--
-- `Item.ultimoConteo` (DOMAIN.md §5) is the only prior available and is what
-- `exposicion` is computed from — the estimate that keeps 31 rows of produce
-- booked at zero from reading as worthless on the admin's screen. It comes from
-- the `conteo1` column of the source row.
--
-- A column rather than something the server digs out of `raw_row` on demand:
-- reaching into that array by index would put knowledge of the file format in a
-- serverless function, which is the one thing `raw_row text[]` exists to avoid
-- (tests/boundaries.test.ts). `-1` is Zeus's not-applicable sentinel and is
-- mapped to null on the way in, in `src/app/`, where that vocabulary belongs.
alter table catalog_rows add column ultimo_conteo numeric;

-- The source row's position in the file.
--
-- P2.0 gave `catalog_rows` the primary key `(session_id, idarticulo)` and no
-- order, which reads as harmless until you ask what `order by` a catalogue is
-- fetched with. Zeus does **not** always export in ascending `idarticulo`: the
-- verified bodega 22 file is `91069` then `15450` (ZEUS_FORMAT.md §7.5), so a
-- read ordered by the key silently re-sorts the catalogue away from the order
-- the shelf and the printed list are both in. `src/store/db.ts` carries an
-- explicit `ord` for exactly this reason and the server needs the same one.
--
-- Not nullable and no default: every row's position is known at insert, and a
-- default would let a writer that forgot produce a catalogue that is all
-- position zero and sorts arbitrarily.
alter table catalog_rows add column ord integer not null;
alter table catalog_rows add constraint catalog_rows_ord_unique unique (session_id, ord);
