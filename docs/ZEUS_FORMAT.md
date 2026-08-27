# Zeus Inventarios — file format specification (v3)

Reverse-engineered from real samples provided by the hotel
(`samples/COMESTIBLES ALMACEN.xls` and `samples/COMESTIBLES ALMACEN.txt`,
bodega `01`, corte `2025-04-30`, 298 rows).

Single source of truth for anything under `src/zeus/`. No other part of the
codebase may encode knowledge of this format.

> **v3 supersedes v2.** Changes: §8 separates parse fidelity from posting (T1
> and T3 were not simultaneously satisfiable once §9 forbade pass-through);
> §7.2 becomes a parameter rather than a rule; §9 clarifies precedence over
> §7.1; §5 corrects the collation claim and records the `|` anomaly.
> **v2 superseded v1**: §3 was missing Excel's 11-character `General` cap and
> the decimal-subtraction rule; §2 mischaracterised `conteo1`; §5 was wrong
> about the sample defect; §7.1 stated a premise measured on the `.xls` as
> though it held for both files.

---

## 1. The two files and their roles

Zeus Inventarios (Zeus Tecnología / Siesa, on-premise Windows ERP) exchanges
physical-count data through two files:

| File | Role |
|---|---|
| `.xls` (BIFF, legacy Excel 97-2003) | What the warehouse team receives and types the physical count into. Has a header row. |
| `.txt` ("Texto MSDOS") | What gets uploaded back into Zeus. No header row. Produced today by Excel's "Save As → Text (MS-DOS)". |

Current manual process:

```
Zeus  →  .xls  →  printed  →  counted on paper  →  typed back into .xls
      →  saved as .txt (MS-DOS)  →  uploaded to Zeus
```

Our app replaces the middle (printing, paper, transcription). It consumes the
same `.xls`/`.txt` and emits a `.txt` that Zeus ingests unchanged. **The
integration with Zeus is not being modified.**

---

## 2. Column layout

24 fields in the `.txt`; 25 in the `.xls` (a trailing `Observacion`, dropped on
export, empty throughout the sample).

| # | Field | Type | Sample | Notes |
|---|---|---|---|---|
| 0 | `codigo` | string | `0103005` | 7 chars, zero-padded, digits only. **NOT unique** — §4 |
| 1 | `nombre` | string | `PANCETA SV` | Free text, accented, ≤ ~39 chars. Three rows carry a stray leading `\|` — §5 |
| 2 | `presentacion` | string | `PORCION X 300 GRAMOS` | Free text. 179 distinct values / 298 rows. Do **not** parse units from it |
| 3 | `existencia` | decimal | `97.5` | Quantity Zeus believes is on hand |
| 4 | `toma` | decimal | `28` | The physical count. **This is the field we write** — §7.1 |
| 5 | `diferencia` | decimal | `0` | `0` in every sample row even where `toma ≠ existencia` (255 rows). Probably computed by Zeus on import — §7.2 |
| 6 | `costo` | decimal | `3990.626866` | Unit cost. Excel `General`, ≤ 11 chars — §3 |
| 7 | `lote` | string | `0` | Lot tracking — unused here |
| 8 | `clasificacion` | string | `0` | Unused |
| 9 | `ubicacion` | string | *(empty)* | Location/zone — **empty in Zeus today**. We plan to populate it |
| 10 | `serial` | string | *(empty)* | Unused |
| 11 | `idarticulo` | int | `1181` | **Unique per row. The real primary key** |
| 12 | `bodega` | string | `01` | Warehouse, zero-padded. Must stay a string |
| 13 | `fecha` | string | `2025/04/30` | Cutoff label. Model as string, not `Date` — carries no timezone meaning |
| 14 | `idconcepto` | int | `-1` | Adjustment reason code. `-1` throughout — §7.3 |
| 15 | `conteo1` | decimal | `20.8` | First count pass. **Carries real data** — 132 distinct values, never `-1`. Not displaced (§5) |
| 16 | `conteo2` | decimal | `-1` | `-1` in 272 rows, `0` in 26 |
| 17 | `conteo3` | decimal | `-1` | Same distribution |
| 18–22 | `Grupo1`…`Grupo5` | string | *(empty)* | Unused. **Do not write to these** — §9 |
| 23 | `costo2` | decimal | `3990.62686567164` | Same cost, full precision, ≤ 13 dp. **Not** subject to the 11-char cap |
| 24 | `Observacion` | string | *(empty)* | `.xls` only. **Dropped in the `.txt`** — annotations cannot survive the file channel |

---

## 3. Wire format of the `.txt`

- **Encoding: CP850** (MS-DOS Latin-1). Not UTF-8, not Latin-1. `TextEncoder`
  only emits UTF-8, so a manual codec is required — §6. Only three non-ASCII
  bytes occur in the sample: `0xA5` (`Ñ`), `0xD6` (`Í`), `0xE0` (`Ó`).
- **Delimiter: tab.** No quoting, no escaping.
- **Line endings: CRLF**, including after the final row.
- **No header, no trailer, no record count, no checksum.**
- **Exactly 24 fields per row.** Empty fields are empty strings between tabs.
- **Numbers:** `.` decimal separator, no thousands separator, shortest
  representation — `10` not `10.0`, `20.8` not `20.80`.
- **Excel `General` truncates to 11 characters.** Files produced by Excel's
  "Save As → Text (MS-DOS)" round any value whose shortest representation
  exceeds 11 chars. 54 of 298 `costo` values are shorter in the `.txt` than in
  the `.xls` (`12333.333333` → `12333.33333`).
  **Round the decimal string, not the binary double.** `toFixed` on the double
  reproduces 294/298; `14243.385455` rounds to `...38545` where Excel gives
  `...38546`. Decimal string rounding (half-up) gives 298/298. Applies to
  `.xls` sources; a `.txt` source is already truncated.
- **Subtraction must be decimal.** `21 - 20.8` in IEEE754 is
  `0.20000000000000107`, which the shortest-representation rule would write
  verbatim into the ERP. Scale to integers first.
- **Zero-padded strings stay strings.** `codigo` (7) and `bodega` (2) must never
  be parsed to a number and re-serialised.
- **`-1` is a "not applicable" sentinel**, distinct from `0`. Appears in
  `idconcepto`, `conteo2`, `conteo3`.
- Quantities are **decimal** — much of the catalogue is sold by weight
  (`113.1 KILO`). Never model a quantity as an integer.

---

## 4. Key invariants

**`idarticulo` is the primary key, not `codigo`.** 232 distinct codes across 298
rows; one code maps to several presentations, each with its own `idarticulo` and
its own balance:

```
codigo    nombre        presentacion            existencia   idarticulo
0103005   PANCETA SV    KILO                          97.5        1181
0103005   PANCETA SV    PORCION X 300 GRAMOS            30         330
0103005   PANCETA SV    PORCION X 350 GRAMOS            60        2660
```

188 codes have one presentation, 29 have two, 15 have three or more (max 5).
Any lookup keyed on `codigo` silently merges distinct products.

Because Zeus keeps a separate balance per presentation, **there is no unit
conversion to perform.**

**`nombre` is stable per `codigo`** in the authoritative `.xls`: zero conflicts.
Useful as an import integrity check — see §4.1, which turns it into one.

### 4.1 What the importer checks, and what it cannot

A file that parses is not a file that means anything. The failure this guards
against is §5's: `nombre`, `presentacion` and `existencia` sorted in Excel
without extending the selection, so every row keeps its own `codigo`, `costo`
and `idarticulo` and acquires somebody else's name and quantity. Every row still
parses. Every price is still plausible. Every adjustment line is still
well-formed. And the file posts quantities to the wrong articles.

`importZeusFile` refuses on **two signals**, both of which the authoritative
`.xls` passes and both of which the `.txt` beside it — same bodega, same corte —
fails.

**Signal one: the file contradicts itself.** Three invariants, all of which hold
*exactly* on the `.xls` — 298 rows, 232 codes, 44 of them multi-row, zero
violations of any kind:

| Invariant | Why it must hold | `.xls` | `.txt` |
|---|---|---|---|
| one `nombre` per `codigo` | a code is one product, whatever its presentations | 0 | 43 |
| one `codigo` per `nombre` | the mirror; still fires when every code is unique | 0 | 44 |
| `(codigo, presentacion)` unique | two rows for one thing are two balances for it | 0 | 6 |

**Signal two: a column is in an order the file is not.** Zeus writes its rows in
ascending `idarticulo` — true of both samples, 0 inversions in 297 pairs — and
that order has nothing to do with the alphabet. So the `nombre` column of a file
still in it should be shuffled, and in the `.xls` it is:

| Column, read down the rows | `.xls` | `.txt` |
|---|---|---|
| `nombre` pairs out of alphabetical order (`localeCompare(…, 'es')`) | 144 of 297 — **48.5%** | 0 of 297 — **0%** |
| `idarticulo` pairs out of ascending order | 0 | 0 |

A file whose rows are in Zeus's order and whose names are in the alphabet's has
had that column put in order by somebody, separately, after the export. The
threshold is **5%**, and the gap it sits in is 48 points wide, so nothing about
it is finely tuned. Under 12 rows the signal is not read at all: 11 pairs and a
5% allowance means *zero* inversions, which a real catalogue reaches by luck
once in 12! — about one in 479 million — but a bodega with eight articles is a
real thing, and blocking one over a coincidence is worse than the check is
worth.

The two signals do not overlap, and that is the point of having both. The first
reads repetition and is blind to a catalogue that has none. The second reads
order and does not care whether anything repeats. A displacement large enough to
matter has to either break a repetition or leave a column suspiciously tidy.

Refused, not warned. A count taken against a scrambled file cannot be
un-uploaded, and the person who would see a warning is the person least able to
judge it. The file is not persisted — `importZeusFile` throws before it returns
a `Session`, so `createSession` is never reached. `generateAdjustment` refuses on
the same check, because sessions imported before it existed are still in the
database, and the count screen carries a banner for the same reason.

Names are compared trimmed, whitespace-collapsed and upper-cased: a trailing
space out of a spreadsheet is not a second article, and a check that blocked a
count over one would be worse than no check.

**Where signal two is wrong.** It cannot tell a scrambled file from a bodega
whose articles were genuinely created in alphabetical order, where ascending
`idarticulo` really is ascending `nombre` — a bodega set up in one sitting from
an alphabetised list. Bodega 01 is not one, and no bodega built up over years
will be, but such a bodega exists and this would refuse its export with a
message telling it to do the thing it already did. There is no override. If one
turns up, the fix is a per-bodega exemption recorded against the session, not a
looser threshold.

It also says nothing about the case where somebody sorts by name in Excel with
the whole sheet selected. That moves the rows, so names and keys travel
together, `idarticulo` comes out shuffled, and the file is fine.


**What none of this does is verify that `idarticulo` 1960 is the product named
beside it.** Nothing in a Zeus row cross-checks its own name against its own
key — there is no checksum, no second copy, no reference catalogue. Both signals
detect *scrambling*, and neither reads meaning. A file whose every `codigo`,
`nombre` and `presentacion` were unique **and** whose names were left shuffled
would pass both while being complete nonsense, and `costo` has no redundancy at
all — nothing in one file can tell a right price from a wrong one.

The second opinion the format lacks is **a previous session for the same
bodega**, which the database has from the second import onward: if last month's
import mapped `idarticulo` 1960 to `MARGARINA EXCLUSIVA DAGUSTO` and this one
says `PECHUGA DE POLLO DESHUESADA`, one of them is wrong, and the same
comparison catches a `costo` that moved by an order of magnitude. That check is
not built. It is the obvious next one.

---

## 5. The sample files are not a matched pair

The `.txt` interleaves **two different row orderings**:

- `codigo`, `idarticulo`, `costo`, `costo2`, `conteo1..3`, `fecha`, `bodega`,
  `idconcepto`, `lote`, `clasificacion` — in `codigo` order, matching the `.xls`
  row for row (298/298).
- `nombre`, `presentacion`, `existencia`, `toma` — in **Excel's locale-aware
  alphabetical order by `nombre`**. Under `localeCompare(…, 'es')` the ordering
  is exact (0 of 298 out of place); under JS default code-unit `.sort()`, 295
  rows appear misordered. That it matches Excel's collation and not code-unit
  order is further evidence the block was pasted from a separately-sorted Excel
  export rather than produced programmatically.

`nombre`/`presentacion`/`existencia` are an exact permutation of the same
triples in the `.xls`. **`toma` is not** — its multiset matches neither `.xls`
`toma` nor `.xls` `conteo1`. It is data that exists nowhere in the `.xls`, and
it is a real partial physical count (§7.1).

The `.xls` holds the correct `codigo` → `nombre` pairing: grouping by `codigo`
yields **0 of 232** conflicting names in the `.xls`, **43 of 232** in the `.txt`.
Domain sanity agrees — the `.xls` pairs `0110004` with `HUEVOS A / UNIDAD` at
433 COP (eggs); the `.txt` pairs the same code and cost with
`ACEITE DE OLIVA / 500 ML`.

**This is a defect in the hotel's manual process, not in Zeus.** The parser reads
what is there. It does not repair.

**The `|` anomaly.** Three rows — all three presentations of one product —
have a `nombre` beginning with a literal `|` (`|MIEL MAPLE SYRUP`). Under Excel's
collation this punctuation leads the file. That the mark covers every
presentation of a single product suggests deliberate annotation rather than a
paste artifact: somebody was flagging that product and had no field to do it in
(`Observacion` is dropped in the `.txt`). Unconfirmed — worth asking the hotel.
The parser reads it faithfully and does not strip it.

---

## 6. CP850 codec

Bytes `0x00`–`0x7F` are ASCII. Bytes `0x80`–`0xFF` map to these 128 characters,
in order (verified against Python's `cp850` codec):

```
ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0
```

Two non-printing entries: `\u00AD` (soft hyphen) at `0xF0`, `\u00A0` (no-break
space) at `0xFF`.

Encoding a character with no CP850 representation is a hard error — never
substitute silently, since that corrupts a product name.

---

## 7. Open questions

Do not resolve these by guessing. Where behaviour depends on them, parameterise.

**7.1 — Which column does Zeus read as the count?**
Evidence favours `toma`. The `.txt`'s displaced block holds a real partial
count: 92 of 298 rows differ from `existencia` in both directions
(`ARROZ DIANA 419 → 100`, `ARVEJA CONGELADA 14 → 30`), ratios 0.01 to 2.14.
That is a human recording a count in `toma`.

Not proof that Zeus *reads* `toma` rather than `conteo1`. Default
`countTargetColumn: 'toma'`; keep `'conteo1'`. When targeting `conteo1`, leave
`toma` and `diferencia` untouched **on counted rows only** — on uncounted rows
§9 takes precedence regardless of target column, or the protection is
bypassable by switching column.

**7.2 — Is `diferencia` read or computed by Zeus?**
`diferencia` is `0` in all 298 rows while `toma ≠ existencia` in 255, so Zeus
probably computes it. But we have **no sample of a file successfully uploaded
carrying a real variance** — the `.txt` is 206 rows incomplete and may never
have been posted.

Parameterise as `differenceColumn: 'computed' | 'zero'`, default `'computed'`,
because the payoff matrix favours it: if Zeus reads the field, `'computed'` is
required and `'zero'` produces an adjustment that posts cleanly and changes
nothing; if Zeus ignores it, both are harmless. Note that the hotel's own files
carry `0` — if Zeus rejects our file, or accepts one that doesn't move the
numbers, flip this first.

**7.3 — What `idconcepto` does a real adjustment carry?** `-1` throughout. Pass
through unchanged.

**7.4 — Does Zeus distinguish "counted as zero" from "not counted"?** See §9.
Highest-risk unknown in the format.

---

## 8. Acceptance tests

Parse fidelity and posting are **separate operations** and must be tested
separately. `reencode` re-emits a parsed file verbatim, applies no counts and no
policy, and is never a posting path. `writeTxt` applies counts and has no
identity mode, so §9 leaves no pass-through door open.

**T1 — parse fidelity.** `reencode(parseTxt(bytes))` reproduces the source byte
for byte, including CRLF, trailing newline and CP850.

**T1b — formatter fidelity.** For every numeric field of all 298 rows,
`formatNumber(Number(text)) === text`.

**T1c — Excel `General` fidelity.** For all 298 rows,
`formatExcelGeneral(Number(xlsCosto)) === txtCosto`. Must be 298/298.

**T2 — Excel import fidelity.** `parseXls` produces 298 items whose `codigo`,
`idarticulo`, `costo`, `costo2`, `conteo1..3`, `bodega`, `fecha` and
`idconcepto` match the parsed `.txt` row for row, with
`nombre`/`presentacion`/`existencia`/`toma` from the Excel (§5). Assert 0 codes
with conflicting `nombre`.

**T3 — count application.** Run against the **`.xls`**, where
`toma == existencia` in 298/298 rows so `'existencia'` is a genuine no-op. The
emitted file differs from the source in exactly the `toma` and `diferencia`
fields of counted rows and nowhere else. Field-level diff, not string
comparison. *(T3 is not satisfiable against the `.txt`: 206 rows sit at
`toma = 0`, so every policy rewrites them.)*

**T4 — encoding survival.** `ARROZ PARBOLIZADO DOÑA PEPA`, `AJÍ CHIPOTLE AMAZON`
and `JAMÓN SELECCIONADO` survive `decode → parse → write → encode → decode`.

**T5 — uncounted policy.** `'reject'` throws naming the missing `idarticulo`s;
`'existencia'` writes `toma = existencia`, `diferencia = 0`; `'zero'` writes
`toma = 0`, `diferencia = -existencia`.

**T6 — bounded divergence (regression).** Round-tripping the `.txt` through
`writeTxt` with counts taken from its own `toma` diverges **only** in
`diferencia`, and only on the 255 rows where `toma ≠ existencia`. With
`'existencia'` and no counts, divergence is confined to `toma` on the same 255
rows. Both assert the divergence set, not merely its existence.

**T7 — collation.** The `.txt`'s `nombre` column is ordered under
`localeCompare(…, 'es')` with 0 of 298 out of place (§5).

---

## 9. Safety: uncounted items must never pass through

In the `.txt`'s real partial count, **206 of 298 rows sit at `toma = 0`** —
including `CREMA DE LECHE` at `existencia 79 → 0` and `CREMA BECHAMEL` at
`18 → 0`. A hotel kitchen does not hold zero cream. These rows are *uncounted*,
represented as zero.

The `.xls` behaves oppositely: `toma` is pre-filled with `existencia` in all 298
rows, so an untouched row means "no change."

**The two source formats carry opposite defaults for an uncounted row.** Passing
`toma` through verbatim is safe against the `.xls` and catastrophic against a
zero-defaulted source — it posts a file zeroing the inventory of every item
nobody reached.

`writeTxt` therefore never emits `toma` implicitly:

```ts
uncountedPolicy: 'existencia' | 'zero' | 'reject'   // library default 'reject'
```

- `'reject'` (library default) — throw. Nothing may post an incomplete count
  without an explicit decision. The *message* names at most 20 uncounted
  `idarticulo`s and states the total; the thrown `UncountedItemsError` carries
  the full, **untruncated** list in `idarticulos`, plus `total`. A capped
  payload would be unusable as data by a caller that has to act on the set.
- `'existencia'` — `toma = existencia`, `diferencia = 0`. The hotel's chosen
  policy, passed by the application at posting time, never silently.
- `'zero'` — `toma = 0`, `diferencia = -existencia` (a row counted at zero has
  the full book quantity as its variance).

This takes precedence over §7.1: uncounted rows are governed by
`uncountedPolicy` regardless of `countTargetColumn`.

**In `countTargetColumn: 'conteo1'` mode, `toma` and `diferencia` are resolved
on every row, counted or not** — `toma = existencia`, `diferencia = 0` — and are
never passed through from the source. "Leave `toma` untouched" in §7.1 means
*do not write the count there*, not *re-emit the source value*. Without this,
posting a zero-defaulted `.txt` in `conteo1` mode would re-emit its 206
uncounted zeros in the column §7.1 judges Zeus most likely to read.

Validation order: unknown-`idarticulo` and duplicate-key errors are raised
*before* the completeness check, so a caller with a typo'd key sees the typo
rather than a 297-item dump.

**Domain-level states** are no longer specified here. An item's verification
state, the waiver that makes an uncounted row postable, and the event log that
carries the attribution are defined in `docs/DOMAIN.md` §2–§4. This section
governs bytes only: what the adapter may and may not emit, given a counts map
and a policy.

**The marker never enters the Zeus file.** `Grupo1..5` stay empty; `Observacion`
is dropped in the `.txt` and cannot carry annotation at all. Notes and waiver
reasons live in the event log because there is physically nowhere else. The
adapter must have no knowledge of *why* a row is uncounted — it receives
resolved counts and a policy, nothing more.

**Before generating a file with uncounted rows**, the application must display
what is being waived. The figures, and why one of them is not enough, are
defined in `docs/DOMAIN.md` §5 — the adapter computes neither and knows about
neither.
