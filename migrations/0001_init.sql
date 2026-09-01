-- P2.0 — the schema, and nothing that reads or writes it yet.
--
-- Points that are decisions rather than style are commented at the column. The
-- rest follows docs/DOMAIN.md and docs/ZEUS_FORMAT.md; where a column exists
-- because of a rule in one of those, the section is named.

create table sessions (
  id                        uuid primary key,
  bodega                    text        not null,
  -- 'YYYY/MM/DD', a label, never a Date. ZEUS_FORMAT.md §2: the cutoff carries
  -- no timezone meaning, and a `date` column would invite a driver to hand it
  -- back shifted by one in whichever direction the server is configured for.
  fecha_corte               text        not null,
  nombre                    text,
  estado                    text        not null,   -- borrador|abierto|revision|sellado|cerrado
  -- The verified triple (ZEUS_FORMAT.md §7.1). Defaulted here so that a session
  -- created without naming them gets the configuration Zeus actually posted,
  -- and so that a session created *before* a future change keeps the one it was
  -- counted under. `conteo1` and `'zero'` remain implemented and untested; the
  -- defaults are the evidence, not a preference.
  count_target_column       text        not null default 'toma',
  uncounted_policy          text        not null default 'existencia',
  difference_column         text        not null default 'computed',
  mostrar_marca_registrado  boolean     not null default true,
  source_name               text,
  source_hash               text        not null,
  -- The imported file itself (DOMAIN.md §6). `verifyWriteBack` re-parses the
  -- emitted file against the source it came from, and `writeTxt` re-emits 22
  -- columns from `raw_row`; neither may depend on whoever is sealing still
  -- having the original .xls on their machine. A file that travels by email and
  -- USB stick is not a safe thing to assume somebody still has.
  source_bytes              bytea       not null,
  created_at                timestamptz not null default now(),
  sealed_at                 timestamptz,
  session_hash              text,
  exported_at               timestamptz,
  file_hash                 text
);

create table catalog_rows (
  session_id   uuid    not null references sessions(id) on delete cascade,
  -- The primary key, never `codigo` (ZEUS_FORMAT.md §4): one codigo covers up
  -- to five presentations, each with its own balance.
  idarticulo   integer not null,
  codigo       text    not null,
  nombre       text    not null,
  presentacion text    not null,
  -- Duplicated out of `raw_row` for admin queries — exposure ranking, sorting.
  -- **Never a posting input.** What gets written back comes from `raw_row`.
  existencia   numeric not null,
  costo        numeric not null,
  familia      text,
  -- 24 fields, verbatim, order preserved. `writeTxt` re-emits the 22 columns it
  -- has no business touching from the source row, which is the property that
  -- stops this app shearing a file the way the hotel's Excel process did
  -- (ZEUS_FORMAT.md §5, §8). Those bytes must survive the server untouched.
  raw_row      text[]  not null,
  primary key (session_id, idarticulo)
);

create table counters (
  id          uuid primary key,
  session_id  uuid not null references sessions(id) on delete cascade,
  nombre      text not null,
  token       text not null unique,
  -- asignado|contando|terminado_confirmado|terminado_incompleto
  --
  -- There is deliberately no `terminado_local`. That is a device-side state the
  -- server cannot observe: with no connectivity in the bodega, a counter who
  -- recorded nothing looks exactly like a counter whose tablet is holding 200
  -- queued events. The server knows only what arrived —
  -- `terminado_confirmado` when a `finish` event is present *and* the chain is
  -- complete to `final_seq`, `terminado_incompleto` when it is present and the
  -- chain is not.
  estado      text not null,
  final_seq   integer,
  head_hash   text,
  finished_at timestamptz,
  created_at  timestamptz not null default now()
);

create table assignments (
  session_id uuid    not null,
  idarticulo integer not null,
  counter_id uuid    not null references counters(id) on delete cascade,
  -- Several counters per article is permitted **at the schema level** while P2
  -- enforces exactly one in the application at dispatch. Blind double-counting
  -- — two counters independently covering one section, compared rather than
  -- summed — is a legitimate audit technique this architecture supports
  -- naturally, since counters cannot see each other's numbers (DOMAIN.md §2.1).
  -- Out of scope for P2; the schema should not foreclose it.
  primary key (session_id, idarticulo, counter_id),
  foreign key (session_id, idarticulo) references catalog_rows(session_id, idarticulo)
);

create table events (
  -- Generated on the device. Events are created offline, so no server can
  -- allocate it (DOMAIN.md §3).
  id                uuid primary key,
  session_id        uuid    not null references sessions(id) on delete cascade,
  counter_id        uuid    not null references counters(id),
  seq               integer not null,
  kind              text    not null,
  -- Null only on the session-scoped kinds: `note` about no particular article,
  -- `finish`, `reopen`.
  idarticulo        integer,
  -- DECIMAL AS STRING. Never numeric, never float.
  --
  -- Quantities are decimal, `21 - 20.8` is `0.20000000000000107` in IEEE754,
  -- and ZEUS_FORMAT.md §3's shortest-representation rule would write that
  -- verbatim into the ERP. The canonical decimal string is what was hashed
  -- (src/domain/chain.ts), so it is also what must be stored: a `numeric`
  -- column that a driver round-trips through a float breaks the chain silently,
  -- and a broken chain is indistinguishable from a tampered one.
  cantidad          text,
  retracts_event_id uuid,
  motivo            text,
  texto             text,
  final_seq         integer,
  head_hash         text,
  usuario           text    not null,
  zona              text    not null,
  -- The event's `at`, verbatim, as hashed. A text column for the same reason
  -- `cantidad` is: a `timestamptz` would be re-rendered on the way out and the
  -- hash would stop matching.
  client_at         text    not null,
  device_id         text    not null,
  server_at         timestamptz not null default now(),
  prev_hash         text    not null,
  hash              text    not null,
  -- The single most important constraint in this schema. It makes pushes
  -- idempotent under retry, makes gaps detectable, and gives the chain
  -- something to anchor on. `(counter_id, seq)` is one counter's own numbering,
  -- so a collision is a bug in the allocator and never a case to arbitrate
  -- (DOMAIN.md §3).
  unique (counter_id, seq)
);

-- Indexes for the reads P2 will actually make: a session's whole log, and one
-- article's events across counters. There is deliberately no index on
-- `(counter_id, seq)` — the unique constraint above already creates one, and a
-- second would be a duplicate btree kept up to date on every insert for
-- nothing.
create index events_session_idx on events (session_id);
create index events_article_idx on events (session_id, idarticulo)
  where idarticulo is not null;

create index counters_session_idx    on counters (session_id);
create index assignments_counter_idx on assignments (counter_id);
