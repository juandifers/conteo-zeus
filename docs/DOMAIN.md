# Counting domain model

Source of truth for `src/domain/` and `src/app/`. Companion to
`docs/ZEUS_FORMAT.md`, which covers bytes only.

The split mirrors the code: `src/domain/` imports nothing from `src/zeus/`, so
the domain model must be statable without reference to a file format. Where a
rule exists *because* of the Zeus format, that is noted as a consequence, not a
premise.

---

## 1. Dependency direction

```
        src/lib/decimal.ts, hash.ts
           ↑            ↑
    src/zeus/      src/domain/       ← neither imports the other, ever
           ↑            ↑
           └─ src/app/ ─┘            ← the only place they meet
                  ↑
             src/store/
```

Enforced by `tests/boundaries.test.ts`, including type-only imports. When Zeus
access moves to ODBC, `src/zeus/` is replaced and `src/domain/` does not change.

---

## 2. Two orthogonal axes

An item has a **verification state** and, when counted, a **variance class**.
These are independent and must not be collapsed into one enum.

| Verification | Meaning | Posts? |
|---|---|---|
| `counted` | somebody looked and recorded a quantity | yes |
| `unchanged` | somebody decided the book figure was right | yes, as `existencia` |
| `untouched` | nobody looked | **no — blocks posting** |

| Variance class | Condition |
|---|---|
| `none` | `qty === existencia` |
| `shortage` | `qty < existencia` |
| `overage` | `qty > existencia` |

A quantity of zero is not a state. `CREMA DE LECHE 79 → 0` is
`counted` + `shortage`; an empty shelf confirmed empty is `counted` + `none`.
Modelling "counted-zero" merges them and any UI grouping by state inherits the
bug.

**UI rule, not a model rule:** `shortage` with `qty === 0` is both the genuine
write-off and what a mis-tap produces. It warrants a confirmation prompt. Derive
it; do not model it.

---

## 3. Events

Counts are an append-only log. Nothing updates or deletes a `CountEvent`;
correcting a count means appending another. `appendEvent` is the only write path.

    set(qty)      replaces the running value
    add(qty)      accumulates (tally mode); negative qty undoes a mis-tap
    unchanged     withdraws any running value and records a waiver; carries no qty
    retract       returns the item to `untouched`; carries no qty

`retract` exists because the other three are one-way: every one of them moves an
item into a state that posts, so without it a mis-tap on the wrong row is a
write-off that cannot be withdrawn — only overwritten with a number nobody
counted. Its fold effect is "as of this event, this item is untouched again":
whatever the item had reached — a running value, a waiver, or both in turn — is
withdrawn, and a subsequent `set` or `add` starts fresh, as after `unchanged`.
It is not a clearing of the running value: a waiver has no running value and
must still be withdrawable.

Nothing is deleted. The retraction is itself an attributable event carrying
`usuario`, `at`, `deviceId` and `seq`, so the log reads "counted 1 at 14:32,
withdrawn at 14:35". Retracting returns the item to blocking a post, which is
correct: a withdrawn count should force someone to deal with it rather than
quietly resolving.

**Undo is a domain function, not UI logic**, because undoing a `set` must
restore the *previous* resolution rather than jumping to untouched:

    last event is add(q)    → append add(-q), but only where the prior
                              resolution is itself a quantity; otherwise the
                              rule below. `add(-q)` restores the prior *value*,
                              which is the prior *state* only when there was a
                              value to go back to — undoing a first tap with
                              `add(-1)` lands on `counted 0`, a write-off of the
                              whole book figure
    last event is set(q)    → prior resolution: counted p → set(p)
                                                unchanged → unchanged
                                                untouched → retract
    last event is unchanged → same rule against the prior resolution
    last event is retract   → same rule against the prior resolution

Every case is an append; `undoLast` returns the event to append, or `null` — on
an empty log, and whenever the event it would produce would leave the resolution
unchanged. The second case is what stops a retraction of an untouched item from
being written as a no-op, and it is the *only* rule a UI may derive a disabled
undo from: a component that decides for itself when there is nothing to undo has
reimplemented the fold. There is no state in which undo is unavailable because
retraction is impossible.

`UnchangedEvent.motivo` is **not collected from counters.** Prompting for a
reason at the moment somebody is escaping converts the escape hatch back into a
form, which defeats the hierarchy in §2. It is populated only by the supervisor
bulk-waiver flow, where a single action covers many rows and friction is
appropriate.

Every event carries `id` (client-generated uuid), `sessionId`, `idarticulo`,
`usuario`, `zona`, `at`, `deviceId`, `seq`.

**Fold ordering** is `(at, deviceId, seq, id)`. All four keys are required:
`(at, deviceId, seq)` is not a total order, and stage 2 merges logs from offline
devices whose clocks disagree. `seq` is monotonic *per device*, so it is compared
after `deviceId` and numerically — comparing it earlier interleaves devices by an
ordinal meaningless across them, and comparing it lexicographically puts `10`
before `3`.

`at` must be normalised UTC ISO-8601; string comparison is chronological only
for that shape. The type cannot enforce this, so `appendEvent` validates it.

**`id` is a dedupe guard, not a decision mechanism.** `deviceId` already
separates devices and `seq` already orders one device's events, so a duplicated
`(at, deviceId, seq)` is a bug rather than a case to arbitrate: two events from
one device claiming one sequence number. Sorting on `id` keeps the order *total*
so that two devices holding the same events never fold them differently — it is
not a way of choosing which of two conflicting events wins, and nothing should
be designed as if it were. Since a `set` and a `retract` at the same key would
have `id` deciding whether an item posts at all, `appendEvent` rejects the
collision outright: one `(sessionId, deviceId, seq)`, one event id.

**`add` after `unchanged` resumes from zero.** A waiver withdraws the running
value; resuming a tally would silently restore a number a person withdrew. The
same holds after `retract`.

Arithmetic uses `src/lib/decimal.ts`. A tally accumulating `0.1 + 0.2` in binary
would eventually write `0.30000000000000004` into the ERP under
`ZEUS_FORMAT.md` §3.

`resolve` operates on one `idarticulo` and rejects a mixed array — one `codigo`
covers up to five `idarticulo`s (`ZEUS_FORMAT.md` §4) and a fold that quietly
merged them is that section's exact failure mode.

---

## 4. Attribution lives here, and only here

A waived row exports as `toma = existencia`, which is byte-identical to what
`uncountedPolicy: 'existencia'` emits. Nothing in the Zeus file distinguishes
"Ana signed off at 14:32" from "nobody went and the policy filled it in":
`Grupo1..5` must stay empty and `Observacion` is dropped in the `.txt`
(`ZEUS_FORMAT.md` §2, §9).

Therefore:

- `exportAdjustment` fixes `uncountedPolicy: 'reject'` and does not expose it.
  The only route to posting an incomplete count is appending `unchanged` events,
  so every no-change row has a name and a timestamp behind it. Same bytes,
  somebody's signature.
- The event log is the sole record of who verified what. **The Zeus file alone
  can never evidence a count.** Worth stating to the hotel's finance function:
  today, no such evidence exists at all.

**Generating the file is recorded, and not in the event log.** An `ExportRecord`
carries the instant, the user, the SHA-256 of the bytes written, the
verification counts at that moment, and the coverage those counts represent
(§5.3). Not a boolean on the session: people export,
count some more, and export again, and afterwards the useful question is *which*
file the ERP received. Two records with one digest are two downloads of one
file; two digests are two different files, and what happened in between can be
named from the counts either one carries.

It is a separate table rather than a fourth event kind, for three reasons. It
has no `idarticulo`, and `resolve` operates on one item and rejects a mixed
array — an event with no item would have to be skipped by the one function the
log exists to feed. It asserts nothing about the stock, which is what every
`CountEvent` asserts. And it does not merge the way events do: two laptops that
each generated a file did not conflict, and no ordering rule should make one of
them win. The log is what happened in the bodega; this is what left the
building.

The record stops at the bytes. Whether anybody uploaded them, and whether Zeus
accepted them, is outside anything this app can observe — so nothing in it is
named as though it were a posting.

---

## 5. Two scopes, and coverage

### 5.1 The measures

Two ways of pricing a set of items nobody counted:

    valor       = Σ existencia × costo
    exposicion  = Σ max(existencia, ultimoConteo) × costo

`valor` is the accounting figure and it is correct. It is also blind in a way
that matters here. **31 of 298 rows carry `existencia = 0`** and contribute
nothing — yet all 31 are fresh produce (`PLATANO AMARILLO`, `MELON`, `ÑAME`,
`FRESA`, `AJO`…), and **all 31 held non-zero stock at the last count.** Zeus
books perishables at zero between purchases, so the rows most likely to hold
unrecorded stock are priced at nothing. At their last counted quantities they
are worth **6.24M COP, 4.4% of the bodega**; `MELON` alone is 1.37M.

`ultimoConteo` is a prior of unknown age. `exposicion` is an exposure estimate,
never a valuation. Present it as such.

### 5.2 The scopes

A figure without its scope is a number with two meanings, so both are named:

| Figure | Scope | Question |
|---|---|---|
| `pendiente` | `untouched` | what is **left to do** |
| `sinVerificar` | `untouched ∪ unchanged` | what **nobody counted** |

Each carries both measures and an item count.

**The property that makes the split worth having: `sinVerificar` decreases only
when an item is genuinely counted.** Signing a waiver moves a row from
`untouched` to `unchanged`, and both are inside the scope, so a supervisor who
waives two hundred rows does not move it by a peso. That is the correct
behaviour — a waiver *accepts* an exposure, it does not retire it — and it is
the whole reason `pendiente` cannot be the figure anybody signs off against:
`pendiente` falls to zero at exactly the moment the count stops.

Consequently:

- **The review screen and the posting confirmation lead with `sinVerificar`.**
  It is the evidence figure: what this file is worth as a count.
- **The faltantes route stays ranked on `pendiente`**, by `exposicion` and not
  by `valor`. It is a work list, a waived row is not somewhere anybody still
  has to walk to, and a value-ordered walk sends everyone past the produce
  cooler last.
- Finance still wants `valor`. The count supervisor needs `exposicion`.

### 5.3 Coverage

`cobertura` = counted book value ÷ total book value, over `counted` items only.
A waiver credits nothing to it: it is a decision not to count, and crediting it
would let a session reach full coverage with nobody having gone anywhere.
Completeness is a different question and `canPost` is where it is asked.

**Row coverage is reported beside it, and the two come apart.** 40% of the rows
carrying 90% of the value is a good afternoon's work; 90% of the rows carrying
40% of the value means somebody counted the easy shelves. Either figure alone
reads as "how far did we get", and one of those two readings is wrong.

Coverage is measured at book value, not at what was found: a shelf counted
empty was still counted. It is recorded on every `ExportRecord` (§4), because
the state counts alone cannot answer "was this a real count" — 250 of 298 rows
is a different file depending on whether those rows are 95% of the bodega's
value or 30% of it.

Open question for the hotel: is `fecha` the `conteo1` date or the export date?
Sits beside `ZEUS_FORMAT.md` §7.4.

---

## 6. Session

A `Session` freezes `Item[]` at import. Items are immutable; re-importing a Zeus
export creates a new session rather than mutating one.

`sourceHash` is the SHA-256 of the file's canonical `.txt` rendering, not of the
bytes handed to the parser — so an `.xls` and the `.txt` exported beside it hash
alike, which is the only sane definition of "same snapshot."
`exportAdjustment` re-checks it before writing, so a count cannot post against a
different snapshot than it was taken from.

**The file itself is frozen with the session**, alongside the items. Two things
need the bytes back at posting time: a hash can only be *re-checked* against
bytes, and the 22 columns the writer has no business touching are re-emitted
from the source row rather than reconstructed (ZEUS_FORMAT.md §8). Keeping it
means posting does not depend on somebody still having the original on the
machine they happen to be posting from — which, for a file that travels by
email and USB stick, is not a safe assumption. The domain never reads a byte of
it; it is opaque here and parsed only in `src/app/`.

Item rows persist with an explicit `ord`. IndexedDB returns rows in key order,
so without it a reloaded session silently re-sorts by `idarticulo` and stops
matching both the shelf and the printed list the counters know.

`canPost` is true when no item is `untouched`.

**Anticipated, not yet modelled:** `usuario`, `deviceId` and `zona` are stamped
on every event and owned by no entity, so "what did Ana verify on Tuesday" is a
filter rather than a lookup. A `CountingSession` — who is responsible for which
zone, on which device, over what period — earns its place in the multi-device
stage, where the question becomes assignment rather than attribution. Modelling
it now would be guessing at a shape we cannot see. Leave the fields on events.

`deviceId` and `seq` are persisted in the store, not in `localStorage`: the fold
breaks ties on `deviceId`, so a regenerated id silently reorders a tablet's own
history, and `seq` resumption must not depend on the whole log being in memory.

**`zona` cannot describe an untouched item.** It is stamped on events, and an
untouched item has no events — so the rows the gap is made of are exactly the
rows carrying no zone. Anything scoped to a zone *over the gap* is therefore
not expressible: "waive everything left in the CAVA", "who still has to walk
the NEVERA", "how much exposure is sitting in the BAR". The supervisor's bulk
waiver selects over the whole untouched set for this reason, ordered by
exposure, and not by zone.

The fix is not a better query. `zona` would have to become **item data** — an
assignment made at import or by a supervisor, before anybody counts — at which
point it describes a shelf rather than a keystroke, and the questions above
have answers. That is the same modelling move `CountingSession` above waits
for, and it should be made once, in the multi-device stage, rather than twice.

**Precondition on the multi-device stage: wall-clock last-writer-wins is not an
acceptable merge strategy.** For two colliding `set`s it merely picks a number,
and either number is a count somebody took. For a `retract` it *reverses a
decision*: a tablet whose clock runs a minute fast resurrects a count another
counter deliberately withdrew, and the fold leaves no mark that anything was
overridden. The asymmetry is the point — withdrawal is an intent, not an
observation, and no clock skew should be able to undo one.

The direction to evaluate is **scoped retraction**: a counter may withdraw only
events their own device wrote, which needs no cross-device agreement and no
clock at all. Withdrawing somebody else's count becomes a supervisor action,
where the two-person step is the safeguard rather than an ordering rule. Nothing
here is settled; what is settled is that shipping LWW over `retract` is not an
option.

---

## 7. Boundary resolution

`exportAdjustment` maps domain states onto the adapter's counts map:

| State | Counts map |
|---|---|
| `counted` | the resolved quantity |
| `unchanged` | `existencia` |
| `untouched` | **omitted** |

`writeTxt` is then called with `uncountedPolicy: 'reject'`, so its rejection list
is exactly the untouched set. The adapter's safety mechanism and the domain's
state model coincide without either knowing about the other — the adapter never
learns *why* a row is uncounted, and the domain never learns what a `toma`
column is.

`UncountedItemsError` carries the full `idarticulos` array and `total`; only its
*message* caps at 20. A capped payload would be unusable as data.