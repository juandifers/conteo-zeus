-- P2.2 — what the sync engine needs that P2.1 did not have.
--
-- Two things, and they are unrelated to each other: the cursor a monitoring
-- screen reads events by, and the visibility the bearer-token model can honestly
-- offer now that a token can *write* (docs/BACKEND.md, "Counter links are not
-- authentication"). Neither adds a table.

-- A server-side arrival order, for the admin's cursor.
--
-- `seq` is one counter's own numbering and says nothing about when the server
-- learned of an event; a tablet that syncs three hours late inserts seq 1..200
-- long after another counter's 400. A monitoring screen needs "what is new since
-- I last looked", which is an arrival order, and that is this.
--
-- **This column has the standard bigserial-cursor trap and is not fixed here.**
-- Under concurrent transactions a lower `server_seq` can become visible *after*
-- a higher one — the value is taken from the sequence when the row is inserted,
-- the visibility comes at commit, and the two orders are not the same. A strict
-- `where server_seq > cursor` poll can therefore skip an event permanently.
--
-- The fix is not a watermark table and not an advisory lock, both of which put a
-- serialisation point in front of the write path to protect a *read*. Events are
-- immutable and keyed by a device-generated uuid, so the reader overlaps and
-- deduplicates: it polls from `cursor - overlap` and merges by `id`. Redelivery
-- costs nothing; a skipped event is a wrong total on a screen somebody signs.
alter table events add column server_seq bigserial;

-- The cursor read: one session's events in arrival order. Not a plain index on
-- `server_seq` — every query this serves is scoped to a session, and a global
-- index would make the planner walk other sessions' rows to find them.
create index events_cursor_idx on events (session_id, server_seq);

-- ---------------------------------------------------------------------------
-- Device binding (P2.2 §3). Visibility, not authentication.
--
-- A counter link is a bearer credential in a URL. That was an accepted
-- limitation while the link was read-only and exposed no quantities; from this
-- migration on the same token can submit counts attributed to somebody else, and
-- the honest answer at this stage is not to pretend it is authentication but to
-- make every device that used it visible.
--
-- Nothing here rejects. A tablet dies mid-shift and the counter picks up a
-- spare; a hard block costs them their morning to prevent something a warning
-- handles. What these columns convert is a silent attribution problem into a
-- loud one.

-- The device that pushed first, and when. `first_device_at` rather than a plain
-- `bound_at`: the useful question afterwards is which tablet was the original
-- one, not merely that binding happened.
alter table counters add column device_id       text;
alter table counters add column first_device_at timestamptz;

-- Every device that has ever pushed for this counter, in the order they first
-- appeared. Append-only, and never trimmed to the last one: "Ana used three
-- tablets today" is exactly the fact somebody needs at five o'clock, and a
-- column holding only the most recent one cannot answer it.
alter table counters add column device_ids_seen text[] not null default '{}';

-- The largest clock skew seen from this counter's devices, `client_at` minus
-- `server_at`, signed, in milliseconds.
--
-- Skew **cannot change any total.** Under P2 rules the fold over counter-emitted
-- events is commutative — counters emit only `add`, `unchanged`, scoped
-- `retract` and `note`; scoped retraction names its target rather than relying
-- on position; `add` is decimal addition; and `unchanged` is order-sensitive but
-- a counter's own events are strictly ordered by `seq`, with no two counters
-- sharing an article (P2.1's disjoint-assignment gate). So arrival order and
-- clock skew change nothing about the numbers.
--
-- What skew corrupts is the audit timeline, which matters for the acta and for
-- reading the log afterwards. Hence: recorded, surfaced to the admin, annotated
-- on the acta past a few minutes — and never corrected. Rewriting a device's
-- timestamps would change the hashes and break the chain to fix a cosmetic
-- problem.
alter table counters add column clock_skew_ms integer;

-- Two chains claiming one `seq` with different hashes.
--
-- A latch, not a computed view: `unique (counter_id, seq)` means the losing
-- events were never stored, so there is nothing left in `events` to derive this
-- from afterwards. Either two live devices are pushing one token, or a device's
-- local database was restored from a backup. Nothing about it resolves itself,
-- so it stays set until a person clears it.
alter table counters add column forked boolean not null default false;

-- Why `terminado_incompleto`, in the words the admin screen prints
-- («faltan seq 88–91»). Derived from the chain on every push by
-- `deriveCounterEstado` and stored beside the state it explains, because the
-- state without the reason is a red mark nobody can act on.
alter table counters add column finish_reason text;

-- When the server last accepted anything from this counter. The monitoring
-- screen's "last heard from", which is the difference between a counter who is
-- working through a section and one whose tablet is face-down in a freezer.
alter table counters add column last_server_at timestamptz;

-- ---------------------------------------------------------------------------
-- A latent defect in 0001, found by deleting a session.
--
-- `assignments` references `catalog_rows(session_id, idarticulo)` with no
-- delete action, so it defaults to `no action`. Deleting a session cascades to
-- `catalog_rows` and to `counters` independently, and Postgres does not order
-- those two cascades for us: the `catalog_rows` delete can fire while the
-- assignment rows are still there, and the whole delete fails on
-- `assignments_session_id_idarticulo_fkey`.
--
-- Nothing in the application deletes a session today, which is why this went
-- unnoticed — it surfaced in the test fixtures, where two Postgres suites
-- running in parallel each have to clear their own rows without truncating the
-- table out from under the other. But "a session cannot reliably be deleted" is
-- not a property worth keeping, and the correct action here is not in doubt:
-- catalogue rows are immutable for the life of a session (a re-import creates a
-- new session), so the only thing that ever deletes one is the session going,
-- and its assignments must go with it.
alter table assignments drop constraint assignments_session_id_idarticulo_fkey;
alter table assignments add constraint assignments_session_id_idarticulo_fkey
  foreign key (session_id, idarticulo) references catalog_rows(session_id, idarticulo)
  on delete cascade;
