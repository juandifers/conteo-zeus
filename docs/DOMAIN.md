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
        src/lib/  decimal.ts, hash.ts, token.ts, base64.ts
           ↑            ↑
    src/zeus/      src/domain/       ← neither imports the other, ever
           ↑            ↑
           └─ src/app/ ─┘            ← the only place they meet
                  ↑
        ┌─────────┴─────────┐
    src/store/            api/       ← the serverless functions
        ↑                            ← never src/zeus/, never src/store/
    src/ui/
```

`api/` sits beside `src/store/` rather than inside `src/app/`: it is a consumer,
not a layer. It reaches the domain — `chain.ts` in particular must have exactly
one implementation, on both sides — and it reaches the file format only through
`src/app/`, which is why the server can re-run the §4.1 integrity check without
a second copy of it existing.

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

### 2.1 The count is blind

Inventory sends counters out with nothing from Zeus, and the reason is that a
variance is only evidence to the extent the counter did not know what they were
supposed to find. Shown `existencia` first, a person under time pressure finds
`existencia`: the shelf gets a glance instead of a count, an awkward weight gets
rounded to the book figure, and every row that agrees with the ERP agrees with
it for a reason the report cannot distinguish from the true one. The count then
confirms the balances instead of testing them, which is the one thing it exists
to do.

**So no counting surface renders anything the ERP believes.** Not a default, not
a mode, not a preference — there is no switch, because "always" and "unless
somebody taps this" are different rules and the department's rule is the first
one. Concretely, off the entry card, the search results, the presentation list
and the faltantes list:

| Gone | It was |
|---|---|
| `existencia` beside the field and on every result row | the figure itself |
| the variance readout and its bar, live as a quantity is typed | `existencia` by subtraction |
| `Coincide con el sistema` | a sentence nobody blind can mean — below |
| every peso figure on faltantes, and the `sistema · antes` chip | `existencia x costo` |
| the zero prompt's *selectivity* | it fired on `existencia > 0`, one bit at a time |

The counter's own numbers stay. A row they counted at 70 says `contado 70`
where it used to say `faltan 11`, and progress (`verificados/total`) stays
because it counts their work rather than the ERP's opinion.

Three consequences, all of which look like losses:

**`Coincide con el sistema` is not hidden, it is unavailable.** It asserts
"what I found is what you have on file", which is not a sentence available to
somebody who has not been told what is on file. Typing the figure produces the
same `set` event and the same zero variance at the review; what goes is the
one-tap route to agreeing with the ERP, which is the route this rule exists to
close.

**The variance bar caught keypad slips, and now it cannot.** An order of
magnitude off read as a *shape* against the book figure, from arm's length —
and only against a reference the counter must not have. That check is spent;
independence is what it bought. The one slip the screen can still catch alone
is a zero, so **every** zero is confirmed rather than only the ones that
contradict the books. Asking selectively would make the prompt a readout of
`existencia > 0` for any row somebody cared to probe.

**Faltantes keeps its ranking and loses its figures.** The order is still
`byExposicion`, so the walk is still most-material-first; the pesos behind the
order are not printed. The ordering leaks materiality, which is weak, and is
also the screen's entire purpose. The figure a supervisor used to read there is
on the review screen under `pendiente · en riesgo`.

#### Where the rule lives

In the code, and asserted by reading the code — `tests/blindCount.test.ts`,
in the spirit of `tests/boundaries.test.ts`. **From P2 it also lives in what the
server sends** (§6.1): the counter endpoint is built from an allowlist, so the
figures are not on the device to be rendered at all. The rendering rule stays,
because the device holds `nombre` and `presentacion` and a screen can still be
made to show something it should not — but the figures themselves are gone. The counting surfaces may not
mention `existencia`, `costo`, `ultimoConteo`, `valor`, `exposicion`,
`itemVariance` or `formatMoney`; a variance is the book figure arrived at by
subtraction and a peso total is the book figure arrived at by multiplication,
and neither is any less the book figure for having been through arithmetic
first. A rendering test can only catch what it happens to render, and this is a
count of 298 items with fifteen ways to reach any one of them.

An earlier version of this made blindness a per-device default with a switch,
and stamped every event with what the screen was showing when it was appended,
so the review could report how many counts were taken sighted. That is the
right design when the rule is a policy people can decide against; it is the
wrong one when the rule is "always", because the record then documents a
freedom that should not exist. The guarantee is stronger unenforceable-by-
construction than observable-after-the-fact, and one boolean per event is not
worth carrying to describe a constant.

**The review screen is the reveal, and shows all of it.** A variance review
against hidden expectations is not a review, and blindness is a property of the
count, which is over by the time anybody opens it.

**The review screen cannot hide `existencia` either, and it is worth saying why
rather than leaving it to look like an oversight.** The table is `sistema`,
`conteo`, `diferencia` and `impacto`, and any two of the first three give the
third: hide the book quantity and it is `conteo - diferencia`. `impacto` is
`diferencia x costo`, so it gives the quantity away a second time. A variance
report *is* the comparison; a version that withheld half of it would be harder
to read and no less revealing.

So the limit is about **who opens the screen, not what is on it** — and it is a
real one. There is no backend and no merge yet, so a session lives in exactly
one browser: the reviewer is holding the counter's tablet, because the count is
nowhere else. Separating the two roles for real is blocked on the same
multi-device work as §6's `CountingSession` and `zona`.

Until then the screen does the one thing available to it. **While any row is
still uncounted it opens closed**, naming what is behind it and how many rows
are still open, with going back as the weighted button and revealing as the
plain one beside it. That converts an accidental eyeful — `Revisar y generar
archivo` is one tap from the search box — into a decision somebody made. It is
friction, not security: it stops curiosity and nothing else, and pretending
otherwise would be worse than not having it. Once every row is counted or
waived it does not appear, because blindness has already done its work.

What the app guarantees is therefore narrower than "no Zeus figure is visible",
and worth stating exactly: *a counter who counts is never shown a Zeus figure
by any screen they count from, and never reaches one without saying so first.*

---

## 3. Events

Counts are an append-only log. Nothing updates or deletes a `CountEvent`;
correcting a count means appending another. `appendEvent` is the only write path.

    set(qty)      replaces the running value
    add(qty)      accumulates (tally mode)
    unchanged     withdraws any running value and records a waiver; carries no qty
    retract       withdraws one named event; carries no qty
    note          a remark; asserts nothing about stock, so it folds to nothing
    finish        "I am done", with `finalSeq` and `headHash` — a manifest, not a marker
    reopen        withdraws a `finish`

The last three are **session-scoped**: their `idarticulo` may be `null`, and
`resolveAll` drops them before grouping. Everything else narrows it back to a
number, so the fold never has to ask.

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

**Retraction is event-scoped.** `RetractEvent.retractsEventId` names the event
being withdrawn. Under one counter, "return the item to untouched" was right;
under several it is a data-loss bug — Ana retracting her own mis-tap on article
4471 would silently discard Luis's count of the same article, and neither would
see a mark that it happened. Scoped retraction is **order-independent**: it
names its target rather than relying on position, which is what keeps merging
several offline logs a sort rather than a conflict resolution. No event kind may
be introduced that breaks this.

A retraction with **no** `retractsEventId` is a P1 event and keeps P1's
whole-item meaning, for those events and for them alone. That is not politeness
toward old data: a P1 log has to fold to the same numbers after the upgrade as
before it, or the count somebody took on Tuesday changed on Wednesday
(`docs/MIGRATION-P1-P2.md`).

**No P2 path may construct one** (P2.2). It is closed in four places, because
the failure is silent everywhere else:

| Where | How |
|---|---|
| the type | `CounterEventDraft` requires `retractsEventId`; the P2 store takes only that |
| the store | `CountStore.retract` throws when a `counterId` is present, and `canRetract`/`offersWholeItemDiscard` are false, which is what takes «Descartar conteo» off the screen rather than greying it out |
| the server | `POST /api/c/:token/events` answers `422 RETRACT_SIN_SCOPE` — the client is a PWA whose cached build may be weeks old |
| a test | `tests/gate.test.ts` reads the P2 sources and asserts none of them writes the kind at all |

Nothing downstream catches it if it slips through. The chain is intact, because
nothing was tampered with. The export is well-formed. `verifyWriteBack` passes,
because the file faithfully reflects a fold that is quietly wrong. It surfaces
weeks later as a variance nobody can explain.

**Undo is a domain function, not UI logic.** It is now one rule:

    undo = retract(the last standing event this counter wrote)

where *standing* means "not itself already withdrawn". `undoLast` returns the
draft to append, or `null` — on an empty log, and whenever the event it would
produce would leave the resolution unchanged.

There is no `add(-q)` case any more. It restored the prior *value*, which is the
prior *state* only when there was a value to go back to: undoing the first tap
of a tally with `add(-1)` landed on `counted 0`, a write-off of the whole book
figure. Withdrawing that tap by name returns the row to `untouched`, which is
what happened.

An **unscoped** retraction is a legitimate undo target and a scoped one is not.
The fold drops a scoped retraction along with its target, so there is nothing to
withdraw; an unscoped one is a decision a person made, and withdrawing it by
name restores what it took. §6's rule — that no clock may reverse a decision —
rules out a *tie-break* undoing a withdrawal, not a person naming their own. The second case is what stops a retraction of an untouched item from
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
`usuario`, `zona`, `at`, `deviceId`, `seq`, and — from P2 — `counterId`.

`counterId` is **not** `usuario`. A name is a label somebody typed into a box;
two counters can type the same one and one counter can retype theirs
differently after lunch. The id is what the hash chain is built over
(`src/domain/chain.ts`) and what the server's `unique (counter_id, seq)`
constraint keys on, so it has to be an identity rather than a label. It is
optional on the type because P1 events do not have one.

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
(§5.3). It says nothing about whether the count was blind, because §2.1 makes
that unconditional: a record that asserted it would be describing a constant.
Not a boolean on the session: people export,
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

**Modelled in P2.1: assignment.** `usuario` and `deviceId` are still stamped on
every event and owned by no entity, so "what did Ana verify on Tuesday" is still
a filter rather than a lookup — but `counterId` is now an identity, and `zona`
has stopped being a preference. See §6.1.

`deviceId` and `seq` are persisted in the store, not in `localStorage`: the fold
breaks ties on `deviceId`, so a regenerated id silently reorders a tablet's own
history, and `seq` resumption must not depend on the whole log being in memory.

**`zona` used to be unable to describe an untouched item.** It was stamped on
events, and an untouched item has no events — so the rows the gap was made of
were exactly the rows carrying no zone, and nothing scoped to a zone *over the
gap* was expressible: "waive everything left in the CAVA", "who still has to
walk the NEVERA", "how much exposure is sitting in the BAR". P1's supervisor
bulk waiver selects over the whole untouched set for that reason, ordered by
exposure and not by zone.

§6.1 is the fix, and it is the one this section said to make: `zona` became item
data.

---

## 6.1 Sections, counters and assignment (P2.1)

A **section** is an admin-created named bucket of articles. Sections are ours;
the ERP has no concept of one, and nothing about a section is written back into
a Zeus file — `ubicacion` stays empty, because ZEUS_FORMAT.md §9 forbids the
adapter carrying markers into the file and the posting path is proven only for
the exact triple in §7.1.

One counter per section; a counter may hold several. `Section.nombre` **is**
`zona` on every event emitted for the articles in it, which is the modelling
move §6 was waiting for: a zone now describes a shelf somebody was sent to,
decided before anybody counted, rather than a dropdown somebody last touched.

**The resolved per-article assignment is what is stored, never the rule that
produced it.** The admin builds sections by moving whole families in, splitting
one across two people, then moving individual articles — but one row per
`idarticulo` is written down. A rule ("everything with prefix 09") re-evaluated
later against a changed catalogue would be a silent reassignment nobody
authorised, and the person it moved work away from would have no way to see it
happened.

**Coverage is a hard gate.** Dispatch is refused unless every article in the
catalogue is assigned to exactly **one** counter (`dispatchBlockers`). The
schema permits several counters per article on purpose — blind double-counting,
two people covering one section independently and their numbers compared rather
than summed, is a legitimate audit technique this architecture supports
naturally, counters being unable to see each other's figures (§2.1). P2 does not
have that feature, so the check lives in the application where it can be lifted
deliberately rather than discovered. If it starts wanting an exception, that is
the double-count feature asking to exist.

**Families are derived, and are only a proposal.** `codigo` is `BBFFNNN` and
digits 2–3 are a product family; over bodega 01 that yields eleven coherent
groups. The partition is corroborated from an unrelated direction — all 31 rows
with `existencia = 0` fall in one of them, the perishables group §5 identified
from Zeus booking produce at zero between purchases. Two routes to one split is
the only reason to trust a structure inferred from one file. **No family list is
hardcoded**: `deriveFamilies` returns prefixes, counts and example names, the
admin types the labels, and the guards return `null` — "partition by hand" —
when a catalogue is not numbered this way.

Family and gap figures are ranked on `exposicion`, never on `valor`, for §5's
reason: the produce family is 54 rows of which 31 are booked at zero, and a
value-ordered list would report the shelf most likely to be holding unrecorded
stock as worth nothing.

**A counter's device is served an allowlist.** In P1, blindness (§2.1) was a
property of what the screens drew, asserted by reading the source. From P2 it is
a property of what the server sends: `GET /api/c/:token` is built field by field
from `src/domain/counterView.ts` and carries `idarticulo`, `codigo`, `nombre`,
`presentacion` and `unidad` — and nothing else. A screen can be changed by
anybody; a figure that never left the database cannot be rendered by accident. A
denylist would fail open the first time somebody added a column, and this
mistake has to fail closed.

**The precondition on the multi-device stage is met** (P2.2). Wall-clock
last-writer-wins was never an acceptable merge strategy for `retract`: for two
colliding `set`s it merely picks a number, and either number is a count somebody
took, but for a withdrawal it *reverses a decision* — a tablet whose clock runs
a minute fast resurrects a count another counter deliberately withdrew, and the
fold leaves no mark. The answer shipped is the one §6.1 named: retraction is
event-scoped, a counter may withdraw only what they wrote, and no clock is
involved in either.

---

## 6.2 Sync (P2.2)

**Counter sync is push-only.** Counters never see totals, so a counter's device
never needs anybody else's events: it pushes, the server accumulates, the admin
pulls. There is no merge on the device, no conflict resolution and no CRDT. If a
design step here starts to require a counter's tablet to know what another
counter recorded, something upstream has gone wrong — go back and find it rather
than building the merge.

### The totals cannot come out wrong

Under P2 rules the fold over counter-emitted events is **commutative**:

- counters emit only `add`, `unchanged`, scoped `retract` and `note`;
- scoped retraction names its target by id, so it does not depend on position;
- `add` is decimal addition;
- `unchanged` clears the running value and *is* order-sensitive — but a
  counter's own events are strictly ordered by `seq`, and §6.1's dispatch gate
  guarantees **no two counters share an article**.

So arrival order cannot change a total and clock skew cannot change a total: a
device that syncs three hours late produces the same numbers as one that synced
instantly. That is what makes offline-first safe here, and it is asserted rather
than argued (`tests/domain/commutativity.test.ts`).

> **If blind double-counting is ever built, this reasoning must be redone before
> it ships.** Two counters over one article is exactly the premise removed, and
> `unchanged` is order-sensitive the moment it goes.

One caveat inside the argument, because "a counter's own events are strictly
ordered by `seq`" is not automatic: the fold orders by `at` **before** `deviceId`
and `seq` (§3), so a counter who moves to a spare tablet with a slower clock
would stamp events that sort before the ones they continue. The replacement path
therefore seeds the spare's clock watermark from `GET /api/c/:token/resume`
(`lastClientAt`), so no device ever stamps earlier than the counter has already
been stamped.

### Two state machines, and they are not the same machine

    DISPOSITIVO (Dexie)                    SERVIDOR (Postgres)
    ────────────────────                    ──────────────────
    contando                                asignado           sin eventos
       │ toca "Terminar"                     │
    terminado_local                          contando           eventos, sin finish
       │ ack del servidor                    │
    terminado_confirmado                     terminado_incompleto
       │ toca "Reabrir"                      │   finish presente, cadena incompleta
    contando                                 terminado_confirmado
                                             │   finish presente, cadena completa
                                            contando  (tras reopen)

`terminado_local` exists **only on the device** and is never stored: a claim a
device makes about itself is not a fact the server can assert. With no signal in
the bodega, a counter who recorded nothing looks exactly like a counter whose
tablet is holding two hundred events in a cold room.

`FinishEvent` carries `finalSeq` and `headHash`, both redundant with the chain,
and that redundancy is the point — it is what lets the server *check* the claim.
Four rules, each failing for a different reason and each reported separately
(`checkFinishManifest`): `finish.seq === finalSeq + 1`; the finish's `prevHash`
equals the claimed `headHash`; the server holds every `seq` in `1..finalSeq` with
no hole; and the stored hash at `finalSeq` equals `headHash`. All four →
`terminado_confirmado`. Any failure → `terminado_incompleto` with the reason
recorded («faltan seq 88–91»).

**`seq` is one-based.** A counter who recorded nothing finishes with
`finalSeq = 0`, `headHash = genesisHash(...)` and `finish.seq = 1` — assigned a
section, walked over, found it already counted by receiving. The push protocol
resumes from `storedMaxSeq + 1` and the manifest states `finish.seq = finalSeq + 1`;
both need a value meaning "nothing yet", and both spell it `0`.

`sessionReadyToSeal` gates on `terminado_confirmado` and nothing weaker. "Everyone
clicked done" is a claim; "the server holds a complete, gap-free,
hash-consistent chain for every counter" is a proof.

### The amendment log

Every event after the first `finish` is flagged post-finish for the admin, and is
**derived from the log** — the position of `kind === 'finish'` within that
counter's own sequence — rather than stored as a boolean. A stored flag is a
second copy of a fact the events already carry, and the two drift the first time
a batch arrives late.

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