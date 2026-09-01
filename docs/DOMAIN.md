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

#### From P2.3, the counter's own numbers do not stay either

In P1 that concession was safe: one device, one counter, and `contado 70` was
that counter's own number in their own session. On a dispatched tablet it is a
**sum over an article** — several entries added up — and the mechanism is
unchanged from the one above. You see 5, the stack in front of you looks
eight-ish, and you reconcile toward a total that feels right.

So: **no running total for any article is rendered anywhere in the counting
path.** Not in search results, not on the entry screen, not in a confirmation,
not in a badge, not implied by a colour ramp or a progress ring. Concretely,
against P1's screens:

| Gone | It was |
|---|---|
| `StateChip`'s `contado 70` on every result row | the article's fold |
| the entry field pre-filled with the running value | the same fold, in a place somebody types over |
| the tally pad's live total | the same fold, counting up |
| grouping Mis registros by article | the fold, by addition, in the reader's head |

What a counter may see is the number they are typing right now, the numbers
they typed before (in Mis registros, chronologically), and — when the session
enables it — a neutral `✓` meaning *you have registered something here*,
carrying no magnitude. A badge reading «3 registros» would carry magnitude,
because entry counts correlate with how big a stack is.

The rule needs a seam, because "has this been registered" is a fold question and
the fold returns a quantity. `src/domain/ownWork.ts` is that seam: it folds, reads
`state`, and hands back a `Set<number>`. No counting component holds a
`Resolution`, which `tests/blindCount.test.ts` asserts by reading the source and
`tests/ui/counting.test.tsx` asserts by searching the rendered page for the sum.

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

**One thing a counting screen may say about an article, and it says nothing
about magnitude.** From P2.3 a row can carry a neutral `✓` meaning "something is
registered here" — never a count, never a colour ramp, never an ordering, since
entry counts correlate with how big a stack is. From P2.3.5 that mark can also
mean *somebody else* registered it, at a handover, from a list of `idarticulo`s
in the assignment payload (§6.4). A set of ids is the one shape that cannot
carry a quantity however it is read, which is what makes it admissible here at
all; the label differs from the own-work one only so that a screen reader does
not tell somebody they did something they did not do.

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

**A P2 counter emits three of these** (P2.3): `add`, scoped `retract` and
`note`, plus `finish` and `reopen` about themselves. `set` and `unchanged` are
not on their tablet, and neither absence is cosmetic — see §3.1.

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

### 3.1 What a counter may say, and what they may not

A counter has three verbs and one correction:

    registrar cantidad   add(qty)     "encontré 8"
    registrar cero       add(0)       "fui al estante, está vacío"
    nota                 note(texto)  "3 cajas sin código arriba"
    deshacer             retract(id)  scoped, from Mis registros

**`set` is not among them.** Two entries on one article are two *locations* —
the same product on a shelf and in a cold room — and the count is their sum.
Replacing a running value would silently discard the first location, and the
counter cannot see that they were about to.

**`unchanged` is not among them either, and this is the sharper removal.** A
waiver asserts *the book figure is correct without counting* — and the counter
cannot see the book figure (§2.1). Asking somebody to vouch for a number
redacted from their device is incoherent, and it is precisely the judgment
blindness exists to prevent. Waivers move to the admin at review, where the
person signing sees what they are signing; `waiveMany` still writes them, still
demands a `motivo` and still stamps the supervisor's name.

The consequence reaches further than the screen, and is recorded in §6.2:
`unchanged` was the only order-sensitive kind a counter could emit.

**`add(0)` is the right primitive for an empty shelf**, and it is worth saying
why it is not a special case. It folds to `(current ?? 0) + 0`. First entry on an
untouched article → `counted` at 0, which writes `0` to `toma` and zeroes the
balance (§7.4) — correct, and what the counter meant. A later entry on an article
already at 5 → still 5, also correct: *this other location* is empty and adds
nothing. The counter cannot tell which case they are in and does not need to.
Hence the copy on the screen: «este lugar está vacío», never «este artículo está
en cero». A zero does not undo an earlier mistaken entry; Mis registros does.

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

**Fold ordering** asks one question first: *do these two events belong to the
same counter?*

    same counterId   →  seq, then id
    otherwise        →  at, deviceId, seq, counterId, id

**Within one counter, `seq` is the causal order and nothing else is consulted.**
`seq` is allocated per counter — `unique (counter_id, seq)` on the server — and
`GET /api/c/:token/resume` deliberately continues one counter's numbering onto a
*different device* when their tablet dies mid-shift. Ordering their own events by
`at` was therefore wrong, not merely fragile: a spare whose clock ran nine
minutes behind sorted that counter's later events before their earlier ones, and
with a waiver in the log that is a count being withdrawn rather than standing.

The resume watermark (`CountStoreOptions.highWater`) had been holding that shut,
and only by clamping the spare's `at` up to the last one the server saw — which
makes two events *equal* on the first key and hands the decision to the
lexicographic order of two uuids. A tie-break deciding which of a counter's own
taps came first is a coin, not an order. The watermark stays, because keeping the
audit timeline on the acta readable is what it should have been doing; it is no
longer what keeps a total right.

**Across counters** all five keys are required. `at` first, so a later
observation wins; `deviceId` next, so two devices stamping the same millisecond
are ordered identically everywhere; `seq` next, numerically, since comparing it
lexicographically puts `10` before `3`; then `counterId`, because two tokens open
on **one tablet** produce the same `deviceId`, the same `at` and the same `seq`
for two genuinely different events — and a comparator returning 0 for a distinct
pair is not a total order, which makes the fold non-deterministic with nothing
anywhere saying so. `id` last, as a dedupe guard.

P1 events carry no `counterId`, so the first branch never fires for them and
their logs fold exactly as they did (`tests/domain/migration.test.ts` is what
makes it safe to change this at all).

`at` must be normalised UTC ISO-8601; string comparison is chronological only
for that shape. The type cannot enforce this, so `appendEvent` validates it.

`CountEventBase.seq` documented itself as "monotonic per device" until P2.3. It
was true in P1 and false from P2.2, and it was load-bearing: a reader who
believed it would conclude the same-counter branch above is unsound.

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
  It is the evidence figure: what this file is worth as a count. From P2.4 the
  two are shown *side by side* and recomputed live, because the property above is
  only visible in the pair: waive a row and watch one fall while the other does
  not (§6.5).
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

**And if `ubicacion` is ever populated, a section name is not always the right
thing to put in it.** P2.3.5 split sections into two roles that had been one: a
*physical place* and a *unit of work*. A whole section changing hands keeps both
— it is repointed, same name, same shelf. A **partial** move mints a section
named for the shelf and the person receiving it (`ESTANTE 3 · Pedro`), and `zona`
is stamped from that name. Good for the audit trail, which is what it is for;
wrong for a column the ERP shares across every future export, where it would put
somebody's name into the location of a shelf permanently. So: **anything writing
`ubicacion` uses the physical-place role, and a minted section name is not it.**
The write-back plan has to carry the distinction rather than the section name.

One counter per section; a counter may hold several. `Section.nombre` **is**
`zona` on every event emitted for the articles in it, which is the modelling
move §6 was waiting for: a zone now describes a shelf somebody was sent to,
decided before anybody counted, rather than a dropdown somebody last touched.

**And it is now the only writer** (P2.3). `src/ui/identity.ts` offered a `ZONAS`
list of seven names until then, so for one release the field had two sources: a
fact the admin committed to at dispatch, and a claim whichever screen was last
touched. Two writers to one field means the log can disagree with the partition
— and the partition is what coverage is gated on — with the disagreement
surfacing months later as an acta nobody can reconcile. The picker is gone, the
store takes a `zonaFor(idarticulo)` resolver built from the assignment, and a
test forbids any P2 path setting `zona` from user input.

A counter holding two sections emits events in two zones, which is why the
resolver is a function of the article and not a string: a store stamping
`secciones[0].nombre` on everything would put the wrong shelf on most of an
afternoon. P1 sessions have no partition and therefore no zone; `ubicacion` is
empty in Zeus and nothing is written back from this field (ZEUS_FORMAT.md §9),
so an empty string there is the honest answer rather than a lost feature.

The partition is not frozen at dispatch. From P2.3.5 it can be changed while
people are counting — a swap, an extra pair of hands, somebody who never arrived
— through one primitive, in one transaction, with a reason on a chain of its
own. §6.4 is that, and the gate below is re-run on the post-state of every one
of those moves rather than reasoned about.

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

- counters emit only `add`, scoped `retract` and `note` (§3.1);
- scoped retraction names its target by id, so it does not depend on position;
- `add` is decimal addition;
- `note` has no fold effect at all.

So arrival order cannot change a total and clock skew cannot change a total: a
device that syncs three hours late produces the same numbers as one that synced
instantly. That is what makes offline-first safe here, and it is asserted rather
than argued (`tests/domain/commutativity.test.ts`).

**As of P2.3 this holds by construction rather than by maintenance.** The
argument used to have two load-bearing conditions, and both are gone rather than
satisfied:

- `unchanged` clears the running value and *is* order-sensitive. It was the only
  order-sensitive kind a counter could emit, and removing counter waivers (§3.1)
  removed it. Nothing a counter can now write depends on position.
- "A counter's own events are strictly ordered by `seq`" was not automatic while
  the fold ordered by `at` first, so it rested on the resume watermark keeping a
  spare tablet's clock from running backwards. §3's comparator now orders one
  counter's own events by `seq` and nothing else, so it is true of the
  comparator rather than of the clocks.

§6.1's dispatch gate still guarantees **no two counters share an article**, which
is what keeps the argument about one counter at a time.

> **If blind double-counting is ever built, this reasoning must be redone before
> it ships.** Two counters over one article is exactly the premise removed. Note
> that the two repairs above make it *more* robust, not less: with `unchanged`
> gone from the counter path, what two counters would contribute to one article
> is `add` and scoped `retract`, both of which commute. The premise that would
> need re-examining is whether the admin's `unchanged` can land on an article two
> counters are still writing to.

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

There is a fifth server state, added in P2.3.5 and reachable from any of the
four: **`retirado`**, an admin taking somebody out of the count mid-session. It
is the only one in that column not derived from the chain, it is recorded in
`session_actions` with a reason, and it is sticky — a late push from that
counter's tablet is accepted and attributed to them and must not put them back
into the count (§6.4).

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
hash-consistent chain for every counter" is a proof. The one exception is a
counter somebody has explicitly retired, who is gated on their chain being whole
instead — they did not finish, and that is what retirement records (§6.4).

### The amendment log

Every event after the first `finish` is flagged post-finish for the admin, and is
**derived from the log** — the position of `kind === 'finish'` within that
counter's own sequence — rather than stored as a boolean. A stored flag is a
second copy of a fact the events already carry, and the two drift the first time
a batch arrives late.

---

## 6.3 The counter's tablet (P2.3)

Four tabs, because a person in a cold room with gloves on is doing four things:

    Contar         search → keypad → confirm → registered
    Mis registros  what I did, in order, and how to correct it
    Notas          what does not fit in a quantity
    Terminar       my own gaps, then done

Everything renders from Dexie. Nothing on any tab waits on a request to draw,
because there is no signal in the bodega and a screen that needs the network is
a screen that is blank for four hours.

**Confirm is mandatory**, and it is the only fat-finger defence on the device —
the outlier checks need book values and belong to the admin. A quantity with
five or more digits before the separator, or more than three after it, gets a
second, differently-worded ask: cheap, needs to know nothing about the article,
and catches a good part of the 80-for-8 class. The unit beside the pad is
`presentacion` **verbatim** (P2.1): `UNIDAD DE 450 A 550 GRAMOS` is unhelpful
and true, and a parsed-and-guessed unit beside a keypad is a wrong number.

**Correction is a separate tab, reached deliberately**, and the separation is
the design: blindness protects the act of counting, not the act of reviewing
what you did. Mis registros is chronological — grouping by article would put an
article's entries adjacent and make their sum readable — and withdrawn rows stay
on it, struck through. «Corregir» appends the withdrawal and the replacement in
**one transaction** (`appendChainedBatch`): a withdrawal that landed alone is a
count somebody deleted, a replacement that landed alone is a count entered
twice, and neither is a state a person could discover by looking.

**The gap review is what §6.1's scoped assignment bought.** Before «Terminar»,
the counter sees the articles *in their own sections* with nothing standing
against them — shelves this person physically walked past, which is what makes
the list well-defined and actionable; it would be neither against the whole
catalogue. The only resolutions offered are counting it or declaring the
location empty. **There is no «sin novedad» there**, for §3.1's reason: waiving
an uncounted row means vouching for a book figure the device does not hold.

Finishing with gaps is allowed. The gap is a fact the admin needs, and a screen
that blocked it would teach people to enter something. The gap is not an event —
it is the absence of one — so what reaches the admin is the assignment (already
theirs) and the counter's complete chain (what the finish manifest proves).

**Sync status is honest about which states are normal.** `contando` with a queue
is the *expected* condition in a bodega, so it is a neutral line with a number
on it; a warning every afternoon teaches people to ignore warnings. Exactly one
state needs action — finished, with events still queued — and it gets the
persistent banner, because that counter is about to walk out of the building
with the only copy of their afternoon in their hand.

---

## 6.4 Counter changes after dispatch (P2.3.5)

Four things the radio says during a count, and they are one operation:

    «Luis se fue enfermo, Pedro lo reemplaza»       swap
    «Vamos lentos, metamos a Carla»                 add
    «María fue asignada y nunca llegó»              remove
    «Ana terminó, que ayude con abarrotes»          rebalance

All four are **reassigning articles between counters while a session is open**,
plus — sometimes — creating or retiring a counter. What exists is the
reassignment primitive; the four are compositions of it. Four separate flows
would have been four partial answers that disagree.

### What makes it tractable

**Assignments and events are separate tables and separate concerns.** Luis
counted sixty articles; those sixty events are attributed to Luis by `counterId`
on each event and stay that way for ever, whoever holds the assignment
afterwards (§4). Reassignment moves responsibility for what is *still to be
done*. It rewrites no history and touches no chain.

Hold onto that whenever this starts to feel complicated: **if a step seems to
require moving, re-attributing or re-hashing an event, it is wrong.** It is
asserted rather than trusted — `tests/gate.test.ts` reads the write path and
refuses an `update events` in it, and the pg suite counts the rows in `events`
before and after a swap.

`zona` follows the same rule. An event keeps the zone it was written with,
because the zone records *where the count happened*, not where responsibility
currently sits. A whole section changing hands is therefore **repointed** — same
row, same name, same zone, new holder — so Pedro counting Luis's ALMACEN is
still standing in ALMACEN. Only a partial move mints a new section, because
`sections` is unique on `(session_id, nombre)` and the old name still belongs to
the articles that stayed.

### The hole that cannot be closed

Luis is in the cold room with no signal. His articles are reassigned to Pedro.
**Luis's tablet does not know and cannot know**: counter sync is push-only
(§6.2) and there is no channel to a device down there. He keeps counting, his
events arrive at 17:40, they are valid, and they are attributed to him —
correctly, because he did the counting. If Pedro counted the same shelves, the
fold sums both.

That is a real double count and **nothing in the system can prevent it**,
because prevention requires reaching a device that is unreachable. So it is
named rather than engineered around:

- the reassignment screen says so, with the name and the time («Luis no ha
  sincronizado desde 10:14»), *before* the button;
- the same list goes into the `reasignar` payload, so P2.4 reports an
  **explained** overlap rather than an unexplained anomaly;
- operationally the answer is a radio and a person: reassign when the counter
  can be told.

The fold's behaviour in that case is `add` on both sides, which sums — asserted
in `tests/domain/commutativity.test.ts`, because the sum is at least a number a
reviewer can see is wrong, and a silent overwrite would not be.

### The admin has a chain of their own

Retiring a counter is a decision, made by a named person, that an auditor will
ask about, and until P2.3.5 there was nowhere to record one. `session_actions`
is one append-only, hash-chained log per session — `agregar_contador`,
`retirar_contador`, `reasignar`, `sellar_sin_registros`, with P2.4's waivers to
follow — hashed by the same primitives in `chain.ts`, because a second
canonicalisation is a second thing that can disagree with the first.

Not a role column on `counters`: that table carries a token, a bound device, a
`final_seq`, a manifest and four counting states, and an admin has none of those
meanings.

Every action carries `usuario` and `motivo`, and `canonicalAction` refuses to
hash one without a person on it. Why a particular article changed hands is not
reconstructible from a diff of two assignment tables, and it is the first thing
anybody asks afterwards.

**At the seal, `sessionHash` covers both chains.** Stated here rather than
discovered in P2.5: a hash over only the counters' events would leave every
admin decision outside whatever the acta guarantees, and those are precisely the
entries somebody would have a motive to change.

### `retirado`, and the one way a count with somebody missing can be sealed

`retirado` is the only state in `CounterEstado` that is **not** derived from the
chain. The other four are what the server can see of what arrived; this one is a
decision, recorded with a reason, and it is deliberately sticky — a late push
from a retired counter's tablet is accepted and attributed to them, and must not
put them back into the count.

Retirement is refused while the counter still holds an article. Retiring is not
a way to abandon coverage, so the reassignment comes first; sequencing it that
way keeps the coverage gate one rule rather than one rule with an exception.

`sessionReadyToSeal` accepts `retirado` **only when that counter's chain is
whole**: `count(*) = max(seq)`, which is contiguity exactly, since `seq` starts
at one and `unique (counter_id, seq)` forbids a repeat. Their sixty counts are
real data and they belong in the file.

That check is **silent about a tail**. A tablet holding seq 61–83 and nothing
after leaves a chain that is contiguous 1–60 and looks complete. That limit is
not a defect to fix here — it is the reason `finish` carries a manifest at all,
and the reason retirement requires a reason a person typed. What the gate catches
is the common case: some of a counter's later events arrived and the ones in
between did not.

When the tablet is not coming back there are exactly two honest ways out:

1. **Wait.** The tablet returns, drains, the counter confirms, seal normally.
   This is the right answer and the screen pushes toward it.
2. **`sellar_sin_registros`** — an explicit action naming the counter, the
   sequence range known missing and a reason. Recorded on the chain, sealed with
   everything else, and **printed on the acta as a named line**: this count is
   missing a known quantity of a named person's work.

There is no third option. There is no force-seal that skips the record, and the
gate cannot be satisfied by setting a state by hand — which is the whole value of
having a gate.

A counter who never started (`asignado`, no events, no fetch) is resolved the
same way: reassign their articles, retire them, and their empty chain is a
complete one.

**Retirement has no exit.** `retirado` is sticky in SQL by design, and there is
no un-retire. A counter back from the clinic at two o'clock is added again as a
**new** counter, with a new chain, a new token and a new manifest; their morning
stays under the old identity and both appear on the acta. That is the honest
shape — two spells of work by one person, each with its own provable chain —
rather than one identity whose history has a hole in the middle that nothing can
describe. P2.4 states it in the retirement confirmation, which is where the
admin is standing when they need to know.

### Two admins

`sessions.assignments_version` is optimistic concurrency over the partition,
bumped inside every reassignment transaction, sent by the client and checked
under the row lock. Two admins on the dispatch screen produced P2.2's
transaction bug; two admins reassigning at once is the same failure with a worse
blast radius, because the second write would silently *reverse* the first.

A mismatch is a `409` and the screen reloads and re-plans. **Move lists are never
merged**: two partitions that each make sense do not make sense unioned, and the
admin is the only one who knows which is still what they meant.

### The handover on the device

**The outbox is per counter, not per device.** Pedro takes over Luis's physical
tablet; Luis's rows are still on it, some unsynced. The store has been keyed by
`(sessionId, counterId)` since P2.2, which is what stops Pedro's arrival
stranding or re-attributing Luis's morning — but nothing *looked* at a queue
whose owner was not in the foreground, and a queue nothing looks at never
drains. So the drain runs for every counter with a non-empty outbox on this
device, and the sync bar says «Luis: 23 registros sin subir» while Pedro counts.

There is deliberately **no «limpiar tableta»**. There is no state in which
discarding another person's unsynced counts is the right thing for a tablet to
decide on its own.

**The inherited gap list.** §6.3's gap list is «articles in my sections with no
standing events *from me*», which is right while assignments are disjoint and
wrong the moment Pedro inherits 120 articles of which Luis already counted 60 —
his finish screen would send him to recount them, which is the double count of
the previous section arriving by a second route. So the assignment payload
carries `yaRegistrados`: the `idarticulo`s that already have a standing event
from **anyone**, as of fetch time.

Ids only. No quantities, no names, no counts — the same information the neutral
checkmark already conveys, which is presence and never magnitude, so §2.1 is
intact. It is a snapshot rather than a subscription (counter sync stays
push-only; the device fetches it once, at handover, on wifi), and it only
matters after a handover, since under disjoint assignments the two definitions
of the gap coincide.

Pedro can still count a `yaRegistrado` article — sometimes he should, if Luis
was ill and his numbers are suspect. Entry on one carries an extra confirm:
*«Otra persona ya registró este artículo. Tu cantidad se sumará a la suya.»*
That is the plain truth about the additive fold, it names the consequence, and it
reveals no number.

### A retired counter's link

It keeps accepting **pushes** and refuses a fresh assignment fetch. Revoking the
token outright is the one action guaranteed to strand whatever is still on that
tablet, and that tablet may be holding the only copy of somebody's morning.
Pulling a new assignment is refused because their articles are somebody else's
now, and a payload would send them back to a shelf Pedro is standing at.

### Reassignment in `revision`

Allowed. Review is exactly when a gap is discovered and somebody is sent back.
The consequence is deliberate and worth stating: a session can move backwards
from «everyone finished», and a counter who was `terminado_confirmado` can be
handed work and reopen. **«Todos terminaron» is not final until the seal.**


---

## 6.5 The review (P2.4)

The screens where the count becomes a decision. Everything before this produced
data that is provably intact; this is where a person looks at it and says what
the file will claim.

Blindness (§2.1) governs the **counter's tablet** and only that. The review reads
`existencia`, reads `costo` and derives variances and exposures out of both,
because the person who signs the acta cannot sign what they cannot see.
`src/domain/review.ts` is the one module in the domain whose purpose is to
reveal, and `tests/boundaries.test.ts` asserts that nothing the counter bundle
renders imports a name it exports. The `ownWork.ts` seam keeps quantities out of
the counting components; this is the same seam one layer up.

### The two figures are shown together, always

§5's pair — `pendiente` over `untouched`, `sinVerificar` over
`untouched ∪ unchanged` — sit side by side on the review screen, and that is a
requirement rather than a layout preference. As the admin waives rows
**`pendiente` falls and `sinVerificar` does not move by a peso.** A waiver
records who accepted an exposure; it does not retire it.

A screen showing only the first number would be a screen whose only visible
figure goes down as you click, which is a screen that talks somebody into
waiving eighteen hundred rows. Both are recomputed live, from
`summarizeSession`, so there is one definition of each and the honesty property
is a property of that definition rather than of this screen.

### A waiver never overrides a count

Waivers are projected into `unchanged` events for the fold — and **only for
articles that fold to `untouched` from counter events alone.** This is not a
refinement, it is the correctness condition:

    15:00  el admin exonera el artículo 4471
    15:30  sincroniza una tableta rezagada
           Luis contó 4471 a las 11:02

    el fold ordena por `at`  →  el conteo de Luis va primero,
                                la exoneración después  →  'unchanged' gana
                                y el conteo real se descarta

`unchanged` discards any running value (§3) and the fold orders by time, so a
waiver signed at three would beat a count taken at eleven that arrived at half
past three — and *which won* would depend on when a tablet reached wifi. That is
the one thing the whole offline model refuses to let anything depend on.

Evaluating waivers against the fold of counter events alone removes the
dependency at its root. A waiver either lands on an article nothing can
contradict, whenever it arrives, or it does not land at all — and then it is
reported as **superseded**, with the waiver and the count that overtook it, for
somebody to look at before sealing.

`waiversToEvents(actions, foldedFromCounterEvents)` is a pure projection consumed
by the existing fold, so `fold.ts` never learns what a `session_action` is. That
direction is load-bearing: the fold is the definition of what a count means, and
it has to stay readable by somebody who has never heard of an admin.

`anular_waiver` withdraws one by naming it, append-only, exactly like a scoped
retraction. The original action stays on the chain for ever.

### `session_actions.payload` never carries a quantity

A rule, not a coincidence of the waiver task. The waived value is `existencia`
from `catalog_rows`, read where it lives; a copy in the payload would be a second
figure that can disagree with the first, and there is no reading of a
disagreement between the two that is not a problem.

If an admin action ever seems to need a number counted off a shelf, it is a
count, and a count belongs in `events` — where `cantidad text` exists precisely
because decimals do not survive a `numeric` round trip, and where
`canonicalJson`'s refusal of anything but safe integers would otherwise bite.
`tests/gate.test.ts` asserts it over every payload type.

### Flags are advisory, and one of them is the valuable one

Every mark on the aggregate ranks a row and says why. None blocks, none corrects,
and none may ever be given a button: **editing a count from the admin screen is
refused rather than deferred.** The count is what somebody saw; an admin
adjusting it at a desk would be entering a number nobody observed, under a
counter's identity or under none. If a count is wrong the counter reopens and
corrects it, or the admin records a note and the acta says so.

The flag worth naming here is **multi-counter overlap**, because it has two
causes that want opposite reactions:

- **Reassigned mid-count.** The article appears in a `reasignar` payload — §6.4
  pre-armed exactly this — so the screen names both counters and the time of the
  move. It is the expected residue of a handover, not an anomaly.
- **Two sections.** Nothing reassigned it. Either the section boundaries touched
  physically or somebody counted outside their aisle, and **this is the double
  count the additive fold cannot detect on its own.** It is the single most
  valuable flag on the screen.

**Post-finish amendments** are derived from position in the counter's own
sequence and never from a stored boolean: a flag written at ingest would stamp an
event recorded before the finish and delivered after it as an amendment for ever,
on the strength of when it happened to reach the office wifi.

**Explicit zeros** are a list somebody walks rather than a column, sorted by what
each line writes off. Under ZEUS_FORMAT.md §7.4 writing `0` into `toma` zeroes
the balance, so a zero is a stock deletion and the highest-consequence entry in
the system. There is no bulk dismiss; the list is short by nature and every line
is a write-off.

**Trailing retractions** — a finished counter whose last content event withdrew
something — are suppressed while they are still counting, because every
correction in progress passes through that shape. G1 stopped the wire from
splitting a correction pair across two batches, which was the common cause; what
is left is a question for a person.

### Two grades of evidence, and the monitor's three tiers

§6.4 established that a **retired** counter's chain is verified by contiguity,
which cannot see a missing tail; only a `finish` manifest can. Two consequences
land here.

The retirement flow asks for the free upgrade first — *«¿Tienes la tableta a
mano? Pídele que toque Terminar antes de irse»* — because ten seconds converts
contiguity into a verified manifest. Retirement is the path for a tablet that
already left, not the default for a person walking out of the door. The same
confirmation states that **retirement has no exit**: a counter back from the
clinic at two o'clock is added again as a new counter with a new chain, a new
token and a new manifest, and both identities appear on the acta.

The pre-seal panel then shows the two grades apart — `terminado_confirmado` as
verified, `retirado` as contiguous-only with the typed reason beside it. Same
discipline §7.1 established for the Zeus evidence: presenting proven and
unverifiable under one checkmark invites confidence nobody earned.

The live monitor separates three tiers for the related reason:

    contando, sin señal desde 10:14        NORMAL en bodega — neutro
    terminó y faltan registros suyos       NECESITA ACCIÓN — que se acerque
                                           a la señal antes de irse
    dos tabletas en un enlace              DETENIDO — nada se resuelve solo

A bodega with no connectivity means most of a shift looks like the first line.
Styling it as a warning trains the admin to ignore the panel, and then the second
line — the one that costs a morning — is one more grey row among twelve. None of
the three uses colour: in this product colour carries exactly one meaning, and a
counter's state is not a variance direction.

The middle tier is the server's version of «terminado_local, 147 en cola». The
server can observe neither half of that sentence — `terminado_local` is a claim a
device makes about itself and is deliberately not stored (§6.2) — but it does
hold the same situation one step later, `terminado_incompleto`, and it is exactly
as actionable. A counter who tapped «Terminar» whose `finish` has not arrived
either still reads as `contando`, and nothing on this screen can tell them apart
from somebody still working. That is not a defect of the monitor; it is why
`FinishEvent` carries a manifest at all.

---

## 6.6 The seal, the file and the acta (P2.5)

The first task that *writes* something. Everything before it computed; this one
freezes a state, emits a file that will move balances in an ERP, and produces the
document that says what actually happened — which the file itself cannot.

Three artifacts leave it, and confusing them is the mistake worth naming first:

    AJUSTE_<bodega>_<fecha>_<hash>.txt   Zeus.       Mueve saldos. Es una transacción.
    acta_<sesión>.pdf                    el archivo. Dice qué pasó de verdad.
    sesion_<sesión>.json                 auditoría.  Permite recomputar los hashes.

Zeus can produce the first. Nobody currently produces the second, and the
information dies in a stack of printed Excel.

### Seal before generate, and the ordering is the design

    revisión ──sellar──▶ sellado ──generar──▶ cerrado
                 │                    │
          congela AMBAS cadenas   el .txt es función determinista
          calcula sessionHash     de un conjunto ya congelado

The instinct is «download the file, then close the session». It cannot be
defended: if input remains possible between generating and closing, the file
handed to Zeus corresponds to no recorded state — a tablet drains at 17:04 and
the `.txt` in the accountant's downloads folder is a snapshot of 17:03 that
nothing in the database describes.

`sellado` is the point after which nothing can be appended. Not counter events
(§6.2's push already refuses there) and **not admin actions either**: a waiver
signed after the seal would change what the file should say about a row the hash
already covers, so `postAction` gates on `REASSIGNABLE` before it looks at
`kind`, and every kind is refused by the same predicate.

Two guards, because one of them is only an argument. The handler reads the
session's state outside any transaction, which leaves a window between the read
and the insert; `insertEventsStatements` therefore repeats the check as a SQL
predicate and takes the session row `for share`, while `sealStatements` takes it
`for update`. A push and a seal cannot overlap, and the loser finds out which one
it is. The screen still renders `sello.tardios` — events whose `server_at` is
after `sealed_at` — and that list should always be empty. It is read anyway: an
event in `events` that `session_hash` does not cover is the one inconsistency a
screen about integrity does not get to *argue* is impossible.

Both stamps come from `now()` **in the database**, not from the handler.
`events.server_at` defaults to the same clock, and a serverless function running
a few seconds behind its database would stamp a seal that made legitimately
earlier events look late — a false alarm on exactly that panel.

### There is no force flag

The gate is `sessionReadyToSeal`'s **blocking** tier and nothing weaker. The
advisory tier — eighteen hundred untouched rows, four explicit zeros, an overlap
— is a checklist, and an admin who has looked at those and decided is making the
decision this system exists to let them make.

The one way past a blocking reason is `sellar_sin_registros`: an action on the
chain, with a name and a typed reason, recorded **in the same transaction as the
seal and written first**, so the record of whose work was skipped is inside the
chain the hash covers. Recorded afterwards it would sit outside the digest that
is supposed to attest to it, which is the same as not being attested to at all.
There is no flag on the request and no way to satisfy the gate by setting a
counter's state by hand. The entire value of a gate is that it cannot be
satisfied by assertion.

### `sessionHash` binds the catalogue too

    sha256Hex(utf8(canonicalJson([
      'conteo-zeus/session/v1',
      sessionId,
      sourceHash,
      ['contadores', [ [counterId, maxSeq, headHash], … ] ],
      ['acciones',   actionsMaxSeq, actionsHeadHash ],
    ])))

`sourceHash` is not decoration. Without it the same event set over a different
catalogue produces the same session hash, and the seal would attest to counts
detached from the rows they were counted against — «91069 = 2» is a fact about a
bodega only in company with the file that says what 91069 is.

Every head is tagged and every chain carries its length. The tags stop a
counter's head and the actions' head being exchanged; the lengths make a
truncated tail visible in the seal and not only in the chain that lost it.

### The export runs on the server, once, and the bytes are kept

If the client regenerated the file, the bytes the admin downloads could differ
from the bytes the server hashed, and `file_hash` would attest to a file nobody
has — not hypothetically, since the client is a PWA whose cached build can be
weeks old. So the server writes, hashes what it wrote, stores it in
`sessions.export_bytes`, and from then on serves exactly that. A re-download is
*provably* the same file, and the verifier can be handed the bytes that were
hashed rather than a reconstruction of them.

`verifyWriteBack` aborts rather than warns. It re-parses the emitted bytes
against the source they came from and throws; nothing catches it, and the session
stays `sellado`, so a failure costs a button press. It is the check that catches
the P1 defect class — the sheared file that would have posted wrong balances to
nearly every row — and there is no version of «export it anyway» that is correct.

### The one place this task writes something false, deliberately

`writeAdjustment` uses the session's own `uncountedPolicy`, which in the verified
triple is `'existencia'`. `exportAdjustment`, the P1 path, fixes `'reject'` and
still does: there, the only route to posting an incomplete count was a signed
`unchanged` event, so a row with no count was a bug.

A sealed P2 session is a different situation. Zeus's format requires every row
and has no way to say «we did not look» (ZEUS_FORMAT.md §9), so a bodega where
1 800 rows were never reached still has to produce 1 800 lines, and those lines
say the rows were counted and found to match. **That is a false statement about
those rows and it is made on purpose.**

What makes it defensible is not the writer. It is that the acta's §8 says so in
as many words, that `sinVerificar` never falls when rows are waived (§6.5), and
that the bundle carries the events so anybody can see which lines came from a
person and which from a policy. A file carrying the truth is not available; a
file carrying the fiction **plus a document that names it** is, and that pairing
is the whole design of this task.

### The acta, and why §8 is the section that matters

Printable HTML with print CSS, rendered to PDF by the browser. No server-side PDF
library: the document has to stay editable in source and legible in a repository
in three years, and a template in a binary-adjacent DSL is neither.

It is written for a reader who was not there and may be an auditor. That reader
cannot ask a question, so every figure carries its own definition — §5's pair is
printed with what each of them means — and every claim carries its grade of
evidence. §6a's two grades appear apart and never as two checkmarks:
`terminado_confirmado` is a chain checked against a manifest the device could not
have written without the events behind it, and `retirado` is contiguity, which
cannot see a missing tail. A bulk waiver collapses to one line with a count and a
value; `sellar_sin_registros` never collapses, because that line names a person
and a range of their work that is not in the file.

### A hash nobody can check is decoration

`tools/verificador.html` is one self-contained file: no build step, no network,
no imports. It opens from a file system, on a machine that has never heard of
this project, in 2029 — and that matters because the situation in which somebody
reaches for it is precisely the situation in which the application may be gone.

**The duplicated hashing inside it is correct, not a violation.** If it imported
the code that produced the hashes it would agree with them by construction and
would prove nothing. What a second implementation demonstrates is that the rules
are written down somewhere and can be applied again. `tests/verificador.test.ts`
builds a sealed session with `src/domain/` and runs the verifier's own functions
over it, so a disagreement between the two copies is a CI failure rather than a
discovery in three years by somebody holding a printout.

Its output is a verdict and, on failure, **a location**: which chain, which
counter, which `seq`, which byte offset. «No coincide» without a position is not
a finding, it is an accusation.

### `cerrado` is terminal

Reads work; nothing appends. A tablet that surfaces afterwards pushes into
`409 SESSION_SEALED` and takes §6.2's path — it keeps its events, offers the JSON
export, and tells the counter their work exists and did not reach the file. That
is a person's afternoon, and the message does not blame them. If a count is wrong
after the close the answer is a new session with its own acta, and the two are
reconciled on paper.

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

**`writeAdjustment` — the P2.5 server path — is the same mapping with a different
policy**, and the difference is deliberate rather than an oversight. It passes the
session's own `uncountedPolicy`, which in the verified triple is `'existencia'`,
because a sealed session has to emit every row of a catalogue most of which
nobody reached. §6.6 says what that costs and what pays for it; the two functions
answer different questions and neither is a refinement of the other.

`UncountedItemsError` carries the full `idarticulos` array and `total`; only its
*message* caps at 20. A capped payload would be unusable as data.