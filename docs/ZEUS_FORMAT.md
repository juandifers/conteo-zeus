# Zeus Inventarios — file format specification (v4)

Reverse-engineered from real samples provided by the hotel
(`samples/COMESTIBLES ALMACEN.xls` and `samples/COMESTIBLES ALMACEN.txt`,
bodega `01`, corte `2025-04-30`, 298 rows).

Single source of truth for anything under `src/zeus/`. No other part of the
codebase may encode knowledge of this format.

> **v4 supersedes v3.** Changes: §7.1, §7.2 and §7.4 are **closed** — a file
> written by this application was uploaded into Zeus, Zeus posted the balances,
> and the person who ran it read them back and found them right (no artefact of
> that comparison was kept; see `PROVENANCE.md`). §7.1 records the
> verified triple and the scope it was verified over; §7.2 closes for
> `'computed'` only; §7.4 closes destructively — a `0` in the count column
> zeroes the balance. §2's note on field 4 changes from "the field we write" to
> "confirmed read by Zeus". §7.5 is new: what the verification run also showed
> about `codigo` width and `Grupo1..2`, neither of which the v3 text allowed
> for. §10 is new: the golden file, what it locks and what it does not. §7.6 is
> new and is **open**: `uncountedPolicy: 'existencia'` has never been exercised
> against Zeus, and `docs/PRIMERA-CORRIDA.md` is the checklist that closes it.
>
> **v3 superseded v2.** Changes: §8 separates parse fidelity from posting (T1
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
| 4 | `toma` | decimal | `28` | The physical count. **Confirmed read by Zeus** on import — §7.1 |
| 5 | `diferencia` | decimal | `0` | `0` in every hotel sample row even where `toma ≠ existencia` (255 rows). A file carrying a real, non-zero `diferencia` posted correctly — §7.2 |
| 6 | `costo` | decimal | `3990.626866` | Unit cost. Excel `General`, ≤ 11 chars — §3 |
| 7 | `lote` | string | `0` | Lot tracking — unused here |
| 8 | `clasificacion` | string | `0` | Unused |
| 9 | `ubicacion` | string | *(empty)* | Location/zone — **empty in Zeus today**. We plan to populate it, from the *physical-place* role only — DOMAIN.md §6.1 |
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
ascending `idarticulo` in this bodega — true of both samples, 0 inversions in
297 pairs — and that order has nothing to do with the alphabet. (It is not true
of *every* Zeus export: the bodega `22` export in `samples/golden/zeus-verified/`
is descending. §7.5. The check handles that by not firing, which is the
behaviour described three paragraphs down.) So the `nombre` column of a file
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

## 7. What the format does, and what is still open

§7.1, §7.2 and §7.4 were open questions in v3 and are closed here. They were
closed by **observation, not inference**: on **2026-08-28** a `.txt` generated by
this application was uploaded into Zeus, Zeus posted the resulting balances, and
the person who ran the upload read them back and found them right.

**No artefact of that comparison was kept** — no count sheet, no balance report,
no screenshot. `PROVENANCE.md` names who made it and says so plainly. The bytes
Zeus accepted are committed and are the strongest evidence here; the *comparison*
is one person's recollection of two rows, and the next closure has to do better,
which is what `docs/PRIMERA-CORRIDA.md` exists to make happen.

The evidence file is committed — `samples/golden/zeus-verified/` — because a
closed question with no provenance is a guess that stopped being questioned.
`samples/golden/PROVENANCE.md` names the run; §10 says what freezing it locks.

**7.1 — Which column does Zeus read as the count? — CLOSED: `toma`.**

Established empirically, not inferred. A `.txt` generated by this application
was uploaded into Zeus, Zeus posted the resulting balances, and the person who
ran it read them back against the two counts as taken and found them right. See
`PROVENANCE.md` for who, and for the fact that no record of that comparison was
kept — the claim is a recollection of two rows, and it is worth exactly as much
as that.

The verified configuration is the triple
`{ countTargetColumn: 'toma', uncountedPolicy: 'existencia',
differenceColumn: 'computed' }`. Evidence for a *combination* does not decompose
into evidence for each parameter separately: nothing here shows what Zeus does
with `conteo1`, and nothing shows what a file carrying a `diferencia` Zeus
disagrees with does. `'conteo1'` remains implemented, untested, and must not
become a default.

**The scope of the run is narrow and stating it exactly is the point.** It was
bodega **`22`**, corte `2026/08/28`, export `LISTADO PRUEBA PPNS.xls`, **two
rows**:

| `idarticulo` | `nombre` | `existencia` | `toma` written | `diferencia` written |
|---|---|---|---|---|
| `91069` | `PASTA NATURAL DE CEREZA` | `1` | `2` | `1` |
| `15450` | `PATICA DE CERDO` | `20.5` | `10.5` | `-10` |

One overage, one shortage, both non-zero, both against a non-zero `existencia`.
That is what was proven. It is *not* bodega `01`, it is not the 298-row
`COMESTIBLES ALMACEN` catalogue, and it does not contain a single zero, an
uncounted row, a multi-presentation `codigo` or a non-ASCII byte. Any change to
the triple, and any bodega whose export differs structurally from the two files
this was run against, is outside what was observed and needs its own first run.

**7.2 — Is `diferencia` read or computed by Zeus? — CLOSED for `'computed'`.**

A file written with `differenceColumn: 'computed'` posted correct balances, so
`'computed'` is proven safe. The verified file carries `1` and `-10` in that
column — real, non-zero variances, not the flat `0` the hotel's own exports
carry — which is what makes this a test of the setting rather than of nothing.

Whether Zeus reads the field or recomputes it is still unknown and no longer
matters: `'zero'` is now the untested branch and should be treated as such.
Keep it; do not default to it.

**7.3 — What `idconcepto` does a real adjustment carry? — still open.** `-1`
throughout both the hotel's export and the verified run. Pass through unchanged.

**7.4 — Does Zeus distinguish "counted as zero" from "not counted"? — CLOSED,
and the answer is destructive.**

**Writing `0` to `toma` zeroes the balance.** A zero is a stock deletion, not a
null.

This makes `uncountedPolicy` load-bearing rather than cautious, and it makes a
zero in the count column something that must be *unforgeable*. In P2 a session
carries the whole catalogue and thousands of rows nobody reached, so the
distance between "nobody looked" and "wiped" is one coalescing bug.

A `0` may reach the count column from exactly two places:

1. an explicit `add`/`set` event whose quantity is `0` — a counter went to the
   shelf and found it empty;
2. `existencia` being `0` on an untouched row under `uncountedPolicy:
   'existencia'` — in bodega 01, the 31 fresh-produce rows.

It may never arise from an empty field, a failed parse, a `null` coalesced to
`0`, a missing catalogue entry, or a row with no events. §9 governs the last of
those and takes precedence over §7.1 regardless of target column. **G2** in §10
is the standing check: for a counts map with no zero in it, the set of emitted
rows carrying `0` in the count column must equal the set of rows whose
`existencia` is `0`, exactly.

Scope, stated as plainly as §7.1's: the verified run **contains no zero**. Both
its rows were counted at a positive quantity. The destructiveness above is
recorded from the hotel's account of what Zeus does with a zeroed column, not
from a row in the committed evidence file. That is the right way round for a
rule this expensive to test — nobody should establish it by uploading one — but
it is a different grade of evidence from §7.1 and §7.2 and is marked as such.

### 7.5 — What the verified run showed that v3 did not allow for

Both files in the run are structurally a Zeus export and neither matches the v3
text in two places. The parser reads both correctly; the *documentation* was
narrower than the format.

- **`codigo` is not always 7 characters.** `01091426` is 8. §3's "zero-padded
  strings stay strings" is what actually matters and it holds; the width is a
  property of the hotel's bodega `01`, not of the format. `CODIGO_WIDTH` is a
  *minimum* pad, applied only when Excel hands the cell back shorter than it,
  so an 8-character code passes through untouched — which is why the verified
  round-trip is byte-exact. Both files store `codigo` as a **text** cell.
  A bodega whose export stored an 8-digit leading-zero code as a *numeric* cell
  would lose the zero and be re-padded to 7, since a number cannot carry one and
  the pad width is fixed. No such file has been seen; if one turns up, the pad
  width has to come from the file rather than from a constant.
- **`Grupo1` and `Grupo2` are not always empty.** In the bodega `22` export they
  repeat `nombre` and `presentacion`. This does not weaken §9: the rule is that
  **we** never *write* to `Grupo1..5`, and `writeTxt` re-emits them from
  `rawRow` verbatim, so a source that populates them survives untouched. It does
  mean `Grupo1..5` cannot be assumed empty on read, and nothing may treat them
  as spare space.

- **Rows are not always in ascending `idarticulo`.** The bodega `22` export is
  `91069` then `15450` — descending. §4.1 measured 0 inversions in 297 pairs on
  *both* hotel files and reads that order as Zeus's own; it is not. This does not
  weaken §4.1's signal two, because that check already treats non-ascending
  `idarticulo` as "the rows were moved, so names and keys travelled together,
  and the file is fine" and returns no fault — the bodega `22` file imports. It
  does mean **ascending order is a property of a source, never of the writer**,
  and nothing may assert it of an emitted file. What is universal, and what the
  shearing failure would break, is that the writer emits the rows it was given
  in the order it was given them.

None of the three observations changes a line of `src/zeus/`. All three are
recorded because the next person to read "7 chars", "unused, empty" or "Zeus
writes rows in ascending `idarticulo`" as a guarantee will write code that
breaks on bodega `22` — and in the third case, a check that refuses a real
export.

### 7.6 — `uncountedPolicy: 'existencia'` against Zeus — **STILL OPEN**

The verified run of 2026-08-28 had **two rows and both were counted**, so the
uncounted branch was code that did not execute. P2.5 makes it the branch that
writes most of a real file: a bodega of 2 400 articles where 1 800 rows were
never reached emits 1 800 lines from this policy and none from a count.

The inference is decent — §9 records that the hotel's own export pre-fills `toma`
with `existencia` in all 298 rows, so the shape is what Zeus already receives —
and decent inference is precisely what §7.1 exists to distinguish from
observation. Nothing here is claimed as closed.

`docs/PRIMERA-CORRIDA.md` is the checklist, with two acceptable resolutions and a
preference between them. The three-row test is cheaper and closes §7.4 as well,
which is today a recollection of what Zeus does with a zeroed column rather than
a committed observation — and P2.4's zeros list and the acta's §4.1 are both
built entirely on §7.4 being true.

**Record here what was done, when, by whom, and what the balances did.** An
empty section below means it has not happened, and one of the two has to happen
before the first real session.

| | |
|---|---|
| Which option was run | **TODO — «prueba de tres filas» or «primera corrida supervisada»** |
| Date | **TODO** |
| Who ran it | **TODO — name and role** |
| Bodega | **TODO** |
| Outcome | **TODO — in particular: did an untouched row's balance move?** |

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

---

## 10. The golden files

`samples/golden/` freezes the writer. `samples/golden/PROVENANCE.md` is the
authority on what each file is; this section says what the tests assert and why
that is the boundary between the two directories.

| Directory | Locks | Because |
|---|---|---|
| `zeus-verified/` | **correctness** | Zeus posted these exact bytes and the balances were right |
| `generated/` | **reproducibility** | this repository wrote it, over the 298-row catalogue, with the §7.1 triple |

`samples/COMESTIBLES ALMACEN.txt` is neither. It is the **sheared** file (§5) and
is a format reference only.

**G1 — byte equality.** `writeTxt` over the parsed `.xls`, with the committed
`counts.json` and the §7.1 triple, equals the frozen `.txt` byte for byte —
CRLF, trailing newline and CP850 included. Run over both directories. On failure
the report names the first differing byte offset, the row, the field *by name*
and both values, because a diff of two 30 KB CP850 blobs is not a usable failure
message.

**G2 — the unforgeable zero.** §7.4's rule, stated as an assertion. Strip every
zero out of the counts map and the set of rows emitting `0` in the count column
must equal the set of rows whose `existencia` is `0` — set equality, not a
subset and not a count. The second half asserts the converse: put the explicit
zero back and it must survive, because a writer that suppressed zeros would pass
the first half and silently lose a real count of an empty shelf.

**G3 — structural invariants.** True of *any* output, so they run over both
catalogues and over an empty counts map as well as the golden one: 24
tab-separated fields per row; CP850-encodable throughout, checked by re-encoding
rather than by inspection; CRLF on every line including the last; no field over
its §3 cap; one row per catalogue row, same keys, **in the source's order**.

Note what G3 does *not* assert: ascending `idarticulo`. §7.5 explains why — it
is a property of the hotel's bodega `01`, not of the format, and the verified
bodega `22` export is descending.

**G1 runs in CI on every commit. When it fails, the default assumption is that
the change is wrong, not that the golden file is stale.** Updating
`generated/expected.txt` requires a commit that touches nothing else and explains
in its message what changed about the output and why that is correct.
`zeus-verified/` is not updatable at all: its authority is that Zeus posted
exactly those bytes, so if the writer stops reproducing them, the writer is wrong.
