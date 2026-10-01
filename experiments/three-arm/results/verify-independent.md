# Independent verification — three-arm image-reading experiment

Written by a verifier that re-derived every number from raw data with its own script
(`verify-independent.mjs`). No experimenter script or score file was imported or read;
in particular `score-runs.json` was deliberately **not** opened. The claims under test come from `stats-arms.md`.

**Snapshot of inputs**

| session | uuid | bytes | sha256 (first 16) | mtime (local) |
|---|---|---|---|---|
| 7ced3634 | 7ced3634-8803-42c0-93f7-c2a48ea4c299 | 63721 | `f0c9599fc5e1b867…` | 2026-09-29T12:08:25.069Z |
| 0ebbb2b2 | 0ebbb2b2-3752-4568-857e-54d78fa548b5 | 87848 | `234ed00ba0276f02…` | 2026-09-29T12:10:20.434Z |
| 9a322102 | 9a322102-ee92-4b9e-8632-ebd28cc0bac4 | 79211 | `613766d05ad42f75…` | 2026-09-29T12:13:34.150Z |
| 63036c9a | 63036c9a-ba2d-4411-932a-01e2cef38543 | 106084 | `c0a47f849c775c96…` | 2026-09-29T12:12:29.409Z |
| e134da0e | e134da0e-76d2-4079-8c79-8af94966ccd7 | 69275 | `33dcd60647f8c49f…` | 2026-09-29T12:13:56.643Z |
| 5d09771c | 5d09771c-3a37-4435-95b1-d6e469ae4f25 | 101748 | `9b163025870e140f…` | 2026-09-29T12:13:15.322Z |
| a9cdcf16 | a9cdcf16-df78-41dc-a7d8-875741ca46a2 | 258987 | `3bc751fb9187c7a5…` | 2026-09-29T12:27:20.522Z |

> **LIVE SESSION WARNING.** `a9cdcf16` was **still appending events while this verification ran**:
> successive reads of the same file during one sitting gave 199,920 → 213,937 → 217,313 → 258987 bytes,
> and its `read_image` count rose 374 → 390 → 406 → 502. Every number for that session
> is therefore a snapshot taken at the mtime shown above, not a final value, and it is excluded from arm
> statistics (see Q4). The claims doc's "341 fabricated" is an earlier snapshot of this same open session.

## 0. Ground truth and stimuli

- `truth.json` is 18811 bytes and carries a **UTF-8 BOM** (it had to be stripped to parse).
- source frame 3840×2160; 36 labels; 16 level-5 tiles; no duplicate codes.
- Minimum pairwise label separation = **203.8 px** (B4X vs G7Y). As this exceeds 2×60 px, a reported
  position can fall within the gate of **at most one** label, so `covered ≤ reported` always holds and the metrics are well-posed.

### Tile dimensions, read independently from the PNG IHDR (bytes 16..24)

| arm | n | IHDR chunk | dimensions found | deviating tiles |
|---|---|---|---|---|
| naive | 16 | `IHDR` | **960×540** ×16 | none |
| down-only | 16 | `IHDR` | **392×221** ×12, **392×220** ×4 | L5_05_x0_y1620_w960_h540.png, L5_07_x960_y1620_w960_h540.png, L5_13_x1920_y1620_w960_h540.png, L5_15_x2880_y1620_w960_h540.png |
| down-then-up | 16 | `IHDR` | **1568×884** ×12, **1568×880** ×4 | L5_05_x0_y1620_w960_h540.png, L5_07_x960_y1620_w960_h540.png, L5_13_x1920_y1620_w960_h540.png, L5_15_x2880_y1620_w960_h540.png |

Filename sets are byte-identical across the three arms, and all 16 truth L5 names are present in each.
`down-then-up` is exactly 4× `down-only` in both dimensions. The four bottom-row tiles are one pixel
shorter than their siblings in both downsampled arms, i.e. the downscale was not perfectly uniform
(392/960 = 0.40833 ⇒ 540 × 0.40833 = 220.5). That is a ~1.2 source-pixel effect, negligible against the
60 px gate, but it means "down-only = 392×221" is not exactly true for 4 of the 16 files.

## 1. Per-session arm identity, read audit, and answer

Arm identity was derived from the directory named in each `read_image` path, **not** from any filename
(filenames are identical across arms). It was cross-checked against the directory named in the session's
own task prompt; the two agree for all 7 sessions.

| arm | run | prompt family | real/fab reads | real tiles | reported | abstain | codes | code acc | precision | pos. coverage ≤60px | median nearest | strays | cond. correct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| naive | 7ced3634 | explicit list | 16/0 | 16/16 | 36 | 2 | 35/36 | 97.2% | 97.2% | 36/36 | 6.5 | 0 | 35/36 |
| down-only | 0ebbb2b2 | no list | 16/0 | 16/16 | 34 | 2 | 14/36 | 38.9% | 41.2% | 31/36 | 3.0 | 3 | 13/31 |
| down-only | 9a322102 | explicit list | 16/0 | 16/16 | 34 | 2 | 18/36 | 50.0% | 52.9% | 34/36 | 3.7 | 0 | 18/34 |
| down-then-up | 63036c9a | explicit list | 23/0 | 16/16 | 32 | 5 | 8/36 | 22.2% | 25.0% | 32/36 | 4.9 | 0 | 8/32 |
| down-then-up | e134da0e | explicit list | 16/0 | 16/16 | 24 | 14 | 12/36 | 33.3% | 50.0% | 24/36 | 5.9 | 0 | 12/24 |
| down-then-up | 5d09771c | no list | 17/23 | 16/16 | 34 | 2 | 13/36 | 36.1% | 38.2% | 34/36 | 3.1 | 0 | 13/34 |
| **(excluded)** | a9cdcf16 | no list | 1/501 | 0/16 | — | — | — | — | — | — | — | — | — |

### Session-by-session derivation

**7ced3634** — `7ced3634-8803-42c0-93f7-c2a48ea4c299` — label *"Rerun naive with explicit filenames"* — model `doubao-seed-evolving`
- prompt family: **explicit-16-filename-list**; arm named in prompt = `naive`; read paths = `naive` → consistent = **true**
- steps=10; tools: read_image×16, send_message×1
- `read_image`: 16 in `tool/call` events, 16 in assistant tool-call blocks → **REAL 16, FABRICATED 0, distinct real tiles 16/16**, repeat tile reads 0
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=36, abstain=2, codeAcc=35/36=0.9722, precision=35/36=0.9722
- coverage≤60px=36/36, median of the 36 nearest distances=6.51px, strays=0
- in-range reports=36/36, correct among them=35 → conditional read acc=0.9722; median in-range distance=6.51px, max=43.99px
- coverage sweep: 5px→10, 10px→26, 20px→34, 30px→35, 60px→36, 120px→36, 240px→36

**0ebbb2b2** — `0ebbb2b2-3752-4568-857e-54d78fa548b5` — label *"Read three-arm down-only"* — model `doubao-seed-evolving`
- prompt family: **no-filename-list**; arm named in prompt = `down-only`; read paths = `down-only` → consistent = **true**
- steps=12; tools: glob×2, read_image×16, send_message×1
- `read_image`: 16 in `tool/call` events, 16 in assistant tool-call blocks → **REAL 16, FABRICATED 0, distinct real tiles 16/16**, repeat tile reads 0
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=34, abstain=2, codeAcc=14/36=0.3889, precision=14/34=0.4118
- coverage≤60px=31/36, median of the 36 nearest distances=3.05px, strays=3
- in-range reports=31/34, correct among them=13 → conditional read acc=0.4194; median in-range distance=2.55px, max=11.58px
- coverage sweep: 5px→24, 10px→30, 20px→31, 30px→31, 60px→31, 120px→32, 240px→34

**9a322102** — `9a322102-ee92-4b9e-8632-ebd28cc0bac4` — label *"Relaunch down-only"* — model `doubao-seed-evolving`
- prompt family: **explicit-16-filename-list**; arm named in prompt = `down-only`; read paths = `down-only` → consistent = **true**
- steps=18; tools: read_image×16, send_message×1
- `read_image`: 16 in `tool/call` events, 16 in assistant tool-call blocks → **REAL 16, FABRICATED 0, distinct real tiles 16/16**, repeat tile reads 0
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=34, abstain=2, codeAcc=18/36=0.5000, precision=18/34=0.5294
- coverage≤60px=34/36, median of the 36 nearest distances=3.69px, strays=0
- in-range reports=34/34, correct among them=18 → conditional read acc=0.5294; median in-range distance=3.46px, max=47.48px
- coverage sweep: 5px→22, 10px→32, 20px→32, 30px→33, 60px→34, 120px→34, 240px→34

**63036c9a** — `63036c9a-ba2d-4411-932a-01e2cef38543` — label *"Rerun down-then-up with explicit filenames"* — model `doubao-seed-evolving`
- prompt family: **explicit-16-filename-list**; arm named in prompt = `down-then-up`; read paths = `down-then-up` → consistent = **true**
- steps=25; tools: read_image×23, send_message×1
- `read_image`: 23 in `tool/call` events, 23 in assistant tool-call blocks → **REAL 23, FABRICATED 0, distinct real tiles 16/16**, repeat tile reads 7
- repeated real tile reads: L5_00_x0_y0_w960_h540.png x2, L5_01_x0_y540_w960_h540.png x2, L5_02_x960_y0_w960_h540.png x2, L5_03_x960_y540_w960_h540.png x2, L5_05_x0_y1620_w960_h540.png x2, L5_13_x1920_y1620_w960_h540.png x2, L5_15_x2880_y1620_w960_h540.png x2
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=32, abstain=5, codeAcc=8/36=0.2222, precision=8/32=0.2500
- coverage≤60px=32/36, median of the 36 nearest distances=4.94px, strays=0
- in-range reports=32/32, correct among them=8 → conditional read acc=0.2500; median in-range distance=4.52px, max=8.79px
- coverage sweep: 5px→18, 10px→32, 20px→32, 30px→32, 60px→32, 120px→32, 240px→32

**e134da0e** — `e134da0e-76d2-4079-8c79-8af94966ccd7` — label *"Relaunch down-then-up"* — model `doubao-seed-evolving`
- prompt family: **explicit-16-filename-list**; arm named in prompt = `down-then-up`; read paths = `down-then-up` → consistent = **true**
- steps=6; tools: read_image×16, send_message×1
- `read_image`: 16 in `tool/call` events, 16 in assistant tool-call blocks → **REAL 16, FABRICATED 0, distinct real tiles 16/16**, repeat tile reads 0
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=24, abstain=14, codeAcc=12/36=0.3333, precision=12/24=0.5000
- coverage≤60px=24/36, median of the 36 nearest distances=5.85px, strays=0
- in-range reports=24/24, correct among them=12 → conditional read acc=0.5000; median in-range distance=4.05px, max=40.40px
- coverage sweep: 5px→15, 10px→22, 20px→23, 30px→23, 60px→24, 120px→24, 240px→24

**5d09771c** — `5d09771c-3a37-4435-95b1-d6e469ae4f25` — label *"Read three-arm down-then-up"* — model `doubao-seed-evolving`
- prompt family: **no-filename-list**; arm named in prompt = `down-then-up`; read paths = `down-then-up` → consistent = **true**
- steps=9; tools: read_image×40, glob×1, send_message×1
- `read_image`: 40 in `tool/call` events, 40 in assistant tool-call blocks → **REAL 17, FABRICATED 23, distinct real tiles 16/16**, repeat tile reads 0
- real but not one of the 16 tiles: `D:\deepseek\.tmp\threearm\runs\down-then-up`
- fabricated (nonexistent) paths: **23** calls, 23 distinct names
- answer: carrier(s) **send_message arguments.message + assistant text block**, all carriers byte-identical = true
- reported=34, abstain=2, codeAcc=13/36=0.3611, precision=13/34=0.3824
- coverage≤60px=34/36, median of the 36 nearest distances=3.14px, strays=0
- in-range reports=34/34, correct among them=13 → conditional read acc=0.3824; median in-range distance=3.00px, max=6.88px
- coverage sweep: 5px→30, 10px→34, 20px→34, 30px→34, 60px→34, 120px→34, 240px→34

**a9cdcf16** — `a9cdcf16-df78-41dc-a7d8-875741ca46a2` — label *"Read three-arm naive"* — model `doubao-seed-evolving`
- prompt family: **no-filename-list**; arm named in prompt = `naive`; read paths = `naive` → consistent = **true**
- steps=86; tools: read_image×502, send_message×2, computer_wait×18
- `read_image`: 502 in `tool/call` events, 502 in assistant tool-call blocks → **REAL 1, FABRICATED 501, distinct real tiles 0/16**, repeat tile reads 0
- real but not one of the 16 tiles: `D:\deepseek\.tmp\threearm\runs\naive`
- fabricated (nonexistent) paths: **501** calls, 493 distinct names
- answer: **NONE PRODUCED**
- **no parseable OBSERVED/UNCERTAIN answer**
- it did send a 590-character `send_message` that is a BLOCKER request for the filenames, with no OBSERVED/UNCERTAIN lines

### Answer carrier

For all six answering runs the answer text is **byte-identical** in three places: the `send_message`
tool-call `arguments.message`, the corresponding `tool/call` event, and an assistant `text`
content block. These are three recordings of one message, not three independent answers, so "which carrier"
is a recording detail rather than evidence. `a9cdcf16` produced no answer at all.

### Claimed vs re-derived, run by run

Claim values below are transcribed from `stats-arms.md` §A (table row) and its bullets. They are
verification *inputs*, not trusted outputs.

| run | claim: codes | mine | claim: code acc | mine | claim: precision | mine | claim: coverage | mine | claim: cond. rate | mine | claim: median (table) | claim: median (bullet) | mine: 36-nearest | mine: in-range only |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7ced3634 | 35 | 35 | 97.2% | 97.2% | 97.2% | 97.2% | 36/36 | 36/36 | 97.2% | 97.2% | 6.5px | 6.5px | 6.51px | 6.51px |
| 0ebbb2b2 | 14 | 14 | 38.9% | 38.9% | 41.2% | 41.2% | 31/36 | 31/36 | 45.2% | 41.9% | 3.3px | 3px | 3.05px | 2.55px |
| 9a322102 | 18 | 18 | 50.0% | 50.0% | 52.9% | 52.9% | 34/36 | 34/36 | 52.9% | 52.9% | 3.3px | 3.7px | 3.69px | 3.46px |
| 63036c9a | 8 | 8 | 22.2% | 22.2% | 25.0% | 25.0% | 32/36 | 32/36 | 25.0% | 25.0% | 3.9px | 4.9px | 4.94px | 4.52px |
| e134da0e | 12 | 12 | 33.3% | 33.3% | 50.0% | 50.0% | 24/36 | 24/36 | 50.0% | 50.0% | 4.6px | 5.9px | 5.85px | 4.05px |
| 5d09771c | 13 | 13 | 36.1% | 36.1% | 38.2% | 38.2% | 34/36 | 34/36 | 38.2% | 38.2% | 2.4px | 3.1px | 3.14px | 3.00px |

Every code count, accuracy, precision and coverage reproduces. The only conditional-rate mismatch is
`0ebbb2b2` (45.2% claimed vs 41.9% re-derived). Note also that the doc's per-run median column and its own
bullet list disagree with each other for 5 of 6 runs, and its table column matches neither of the two
defensible definitions (36-nearest median = the bullet values, which I reproduce; or the in-range-only median).

## 2. Hand-verified worked example

Session `0ebbb2b2`, first OBSERVED line: `L5_00_x0_y0_w960_h540.png | KPQ | u=0.285 v=0.510`.
Tile `L5_00` has `gx=0, gy=0, gw=960, gh=540`.

- hand: `gx = 0 + 0.285×960 = 273.6`, `gy = 0 + 0.510×540 = 275.4`
- script row: `gx=273.6, gy=275.4` ✓
- nearest true label is `K7Q` at **154.4 px** → outside the 60 px gate → counted as a stray, and `KPQ` is not a true code so it adds nothing to code accuracy.

Full hand recount from that session's printed per-row table: 34 OBSERVED rows; **31** lie within 60 px of some
label; of those 31 the reported code equals the nearby label's code in **13** rows. The script reports exactly
`reported=34, inRange=31, strays=3, coverage=31, hitCodes=14, condCorrect=13`.
A synthetic cross-check (4 hand-placed reports) likewise reproduced its expected `hitCodeCount=2/36`, `precision=0.5` and conditional counts.

## 3. Statistics

The normal tail is computed in log space with the Laplace continued fraction and self-tested against published
values (P(Z>1.96)=0.0249979, P(Z>5)=2.866516e−7, P(Z>6)=9.865876e−10, P(Z>8)=6.220961e−16); all agreed to
within 1e−7 relative error, so the very small p-values below are not a polynomial approximation
saturating at zero. The Fisher-exact routine is checked the same way against the tea-tasting table
(3/1/1/3 → 0.485714) and the classic 1/9/11/3 table (→ 0.002759).

### Per-run code accuracy (the requested per-arm range)

| arm | runs | per-run code accuracy | range | pooled |
|---|---|---|---|---|
| naive | 1 | 97.2% | **0.0 points** | 35/36 = 97.2% |
| down-only | 2 | 38.9%, 50.0% | **11.1 points** | 32/72 = 44.4% |
| down-then-up | 3 | 22.2%, 33.3%, 36.1% | **13.9 points** | 33/108 = 30.6% |

### Pooled two-proportion z (pooled variance, positions treated as independent)

| comparison | arm A | arm B | Δ | pooled p̂ | SE | z | p (two-sided) | Fisher two-sided |
|---|---|---|---|---|---|---|---|---|
| naive vs down-then-up | 35/36 (97.2%) | 33/108 (30.6%) | 66.7 pts | 0.4722 | 0.0961 | **6.939** | 3.951e-12 | log10 p = -12.72 |
| naive vs down-only | 35/36 (97.2%) | 32/72 (44.4%) | 52.8 pts | 0.6204 | 0.0991 | **5.328** | 9.939e-8 | log10 p = -7.93 |
| down-only vs down-then-up | 32/72 (44.4%) | 33/108 (30.6%) | 13.9 pts | 0.3611 | 0.0731 | **1.901** | 5.736e-2 | log10 p = -1.09 |

### Paired / run-level

- Run-level exact permutation (down-only vs down-then-up): observed |Δmean| = 0.1389, 2/10 arrangements as extreme → **minimum achievable two-sided p = 0.200**. With 2 vs 3 runs, no run-level test can reach 0.05.
- Paired by **design generation**: originals (no-filename-list prompt) → down-only 0ebbb2b2 38.9% vs down-then-up 5d09771c 36.1% = **2.8 points**
- Paired by **design generation**: relaunches (explicit-filename-list prompt) → down-only 9a322102 50.0% vs down-then-up e134da0e 33.3% = **16.7 points**
- Sign test on those 2 pairs (2 positive): **p = 0.500** (two-sided; the doc quotes 0.25, which is the one-sided value)
- Code-level paired McNemar (9a322102 vs e134da0e, same prompt family): both=8, only-down-only=10, only-down-then-up=4, neither=14 → exact p = 0.180

### Scope restriction "runs with zero fabricated filenames"

| arm | qualifying runs |
|---|---|
| naive | 7ced3634 |
| down-only | 0ebbb2b2, 9a322102 |
| down-then-up | 63036c9a, e134da0e |

Corrected contrast under this scope: down-only 32/72 vs down-then-up 20/72, z = 2.082, **p = 0.0373**.

### Abstention behaviour

| run | arm | UNCERTAIN lines | of which within 2% of a tile edge | code acc | code acc if true-code UNCERTAINs were counted | codes recovered |
|---|---|---|---|---|---|---|
| 7ced3634 | naive | 2 | 2 | 97.2% | 97.2% | none |
| 0ebbb2b2 | down-only | 2 | 1 | 38.9% | 38.9% | none |
| 9a322102 | down-only | 2 | 2 | 50.0% | 50.0% | none |
| 63036c9a | down-then-up | 5 | 3 | 22.2% | 22.2% | none |
| e134da0e | down-then-up | 14 | 6 | 33.3% | 33.3% | none |
| 5d09771c | down-then-up | 2 | 2 | 36.1% | 36.1% | none |
| **total** | | 27 | 16 (59.3%) | | | |

Two facts matter here. First, **no session recovers a single true code** from its UNCERTAIN lines — the
codes those lines carry are not true codes — so abstention does **not** affect code accuracy at all.
Second, 59.3% of all abstentions sit within 2% of a tile edge, i.e. they are codes cut in half by the split.
Abstention is therefore principled boundary caution, not random reluctance — but because coverage equals
the reported count in five of six runs, each abstention still removes one position from the "where" axis.
That is exactly the channel through which a reporting-policy difference masquerades as an arm effect.


## 4. Answers to the six questions

### Q1. Range of code accuracy per arm — YES, derived

- **naive**: 97.2% → range **0.0 points** (1 run)
- **down-only**: 38.9%, 50.0% → range **11.1 points** (2 runs)
- **down-then-up**: 22.2%, 33.3%, 36.1% → range **13.9 points** (3 runs)

Within-arm spread (11.1 and 13.9 points) is the same order as the between-arm difference, and the naive arm
has no spread at all because it has a single usable run.

### Q2. "The native-resolution arm beats both downsampled arms" — SUPPORTED in direction, but the stated p-value is not valid

| comparison | inputs pooled | Δ | SE | z | p (two-sided) |
|---|---|---|---|---|---|
| naive vs down-then-up | 35/36 vs 33/108 | 66.7 pts | 0.0961 | **6.939** | 3.951e-12 |
| naive vs down-only | 35/36 vs 32/72 | 52.8 pts | 0.0991 | **5.328** | 9.939e-8 |

Numbers pooled: naive 35/36 (97.2%); down-then-up 8+12+13 = 33/108 (30.6%); down-only 14+18 = 32/72 (44.4%). The direction is
unambiguous — the naive run is above every individual downsampled run (97.2% vs a per-run range of 22.2%–50.0%), far exceeding
any within-arm drift. **However**, the naive "sample" is 36 positions from **one** session: treating
positions as independent observations is pseudoreplication, and at the run level the naive arm has n=1,
so no arm-level test is possible. Verdict: supported in direction and magnitude, with an overstated p-value.

### Q3. "An enlarged (interpolated) tile is WORSE than the same content un-enlarged" — NOT SUPPORTED at conventional significance

- Pooled, all runs (2 vs 3): 32/72 (44.4%) vs 33/108 (30.6%), Δ = 13.9 points, SE = 0.0731, **z = 1.901, p = 0.0574** (two-sided). Misses 0.05.
- The claims doc's own §C declines to claim this. Note its §C quotes "p=0.027" for this comparison, which is the **one-sided** value of the same z while §A quotes the two-sided 0.0574 — the same comparison is given two different p-values.
- Paired per-run differences: pairing by completion order (as the doc does) gives +16.7 and +16.7 points, but pairing by **design generation** gives **+2.8** (originals) and **+16.7** (relaunches). So "same sign and same magnitude" is an artefact of the chosen pairing. The sign test is p = 0.500 either way.
- Under the doc's restricted scope (runs with zero fabricated filenames) it drops 63036c9a — but 63036c9a has **zero fabricated reads** (its 7 extra reads are repeats of real tiles). Applying that scope correctly gives down-only 32/72 vs down-then-up 20/72, **p = 0.0373** — nominally significant, the opposite of the doc's "p=0.27, therefore not claimed".

**Verdict: no.** The direction is consistent (down-only above down-then-up in every comparison), but the
effect is not established: the position-level pooled test misses 0.05 (p = 0.0574), the run-level permutation floor is
p = 0.200, and the two-sided sign test is p = 0.500. The one pooled contrast that does reach 0.05 is the
scope-corrected one (p = 0.0373), which is itself a position-level test with only 2 vs 2 runs behind it.

### Q4. Sessions to EXCLUDE — YES: a9cdcf16, and it changes the arm sizes

**Exclusion rule (applied before any statistic):** drop a session that did not receive the stimulus or did
not produce a scorable answer — i.e. (a) it read **0 of the 16 real tile files**, or (b) it produced **no
parseable OBSERVED/UNCERTAIN answer**.

`a9cdcf16` fails both. It issued 502 `read_image` calls, of which **501 were
fabricated, nonexistent filenames** (`00.png`, `sub_00.webp`, `00.bmp`, …) and exactly **1** path existed —
the *directory* `D:\deepseek\.tmp\threearm\runs\naive`, not a tile. It read 0/16 tiles, produced no answer, and sent a
BLOCKER request for the filenames. It was also **still running while this verification executed**.

Effect: counting it as a 0-scoring run would leave the naive arm with 2 runs at {0%, 97.2%}; excluding it
leaves **naive = 1 run**. Arm sizes become **1 / 2 / 3** (naive / down-only / down-then-up) — exactly the
imbalance that makes the pooled p-values optimistic.

I did **not** exclude `5d09771c` (23 fabricated reads) or `63036c9a` (7 duplicate reads): both read
all 16 real tiles and delivered answers, so the stimulus was delivered and the fabricated calls cost only
steps. They are carried as a sensitivity scope instead.

### Q5. On the "where" axis, do the arms differ? — NO: the differences are report-count, not position

- Median distance from each of the 36 labels to the nearest report: **6.5, 3.0, 3.7, 4.9, 5.9, 3.1 px** across the six runs — every run is within ~7 px, an order of magnitude inside the 60 px gate.
- Median distance restricted to reports that are in range: 6.5, 2.5, 3.5, 4.5, 4.1, 3.0 px; the worst single in-range report in the whole experiment is 47.5 px.
- **Five of the six runs have coverage exactly equal to their reported count** (7ced3634, 9a322102, 63036c9a, e134da0e, 5d09771c): every position they reported landed inside the gate, with zero positional misses. The only exception is `0ebbb2b2` (31/34), whose 3 strays are mislocated codes rather than noise.
- The coverage sweep is nearly flat across gate widths (e.g. 7ced3634 covers 10 labels at 5px, 26 labels at 10px, 34 labels at 20px, 35 labels at 30px, 36 labels at 60px, 36 labels at 120px, 36 labels at 240px), so the choice of 60 px is doing almost no work.
- Consequently `covered ≈ reported`, and since `covered ≤ reported` must hold here (labels are ≥203.8 px apart), **the entire "where" difference between arms is the number of lines emitted and abstained on**, not annotation accuracy. The "where" task is saturated for all arms.

**Verdict: no.** Positional annotation is saturated in every arm; the arms differ only in how many codes
they were willing to report.

### Q6. Things that should make a reader distrust these numbers

1. **One arm has a single usable run.** naive = 1 answering run. Every pooled z treats 36 positions from one session as 36 independent observations.
2. **The design changed mid-experiment.** Three "original" runs used a prompt with no filename list; four later runs used a prompt containing the explicit 16-filename list. Arms are not balanced across prompt families (naive 1+1, down-only 1+1, down-then-up 1+2).
3. **Survival was confounded with instruction compliance.** The no-list prompt forbade every tool except `read_image`. Of the three originals, the two that survived (`0ebbb2b2`, `5d09771c`) did so by calling `glob` — a prompt violation — while `a9cdcf16`, which complied, produced nothing. "Which arm won" partly reflects which run cheated successfully.
4. **`a9cdcf16` is a live, still-writing session**, so its row in any table is a moving target (374 → 390 → 406 reads while I verified). The doc's "341 fabricated" is an earlier snapshot of the same open session.
5. **`63036c9a`'s "7 fabricated reads" is a misclassification.** Those are 7 *repeat reads of real tiles* (L5_00_x0_y0_w960_h540.png x2, L5_01_x0_y540_w960_h540.png x2, L5_02_x960_y0_w960_h540.png x2, L5_03_x960_y540_w960_h540.png x2, L5_05_x0_y1620_w960_h540.png x2, L5_13_x1920_y1620_w960_h540.png x2, L5_15_x2880_y1620_w960_h540.png x2); that session has **0** fabricated calls. The doc's §B therefore excludes it for a reason that is false, and its §B conclusion (p = 0.27) becomes p = 0.0373 when corrected.
6. **Abstention differs ~7× across runs and drives the coverage axis.** UNCERTAIN counts are 2, 2, 2, 5, 14, 2, and 59.3% of all abstentions are codes cut in half at a tile edge. Abstention does **not** move code accuracy (no UNCERTAIN line in any session carries a true code that was not already reported), but since coverage equals the reported count in five of six runs, every abstention removes one label from the "where" axis. So the coverage gap between arms is partly a reporting-policy difference rather than a perception difference.
7. **One comparison carries two different p-values** in the claims doc: §A gives two-sided 0.0574, §C gives 0.027 (one-sided). Both cannot be the headline.
8. **The pairing in §C is a choice, not a design feature.** Pairing by completion order yields two +16.7-point diffs; pairing by design generation yields +2.8 and +16.7.
9. **Fabricated reads inflate step counts and cost.** `a9cdcf16` burned 502 calls for zero tiles; `5d09771c` burned 40 calls for 16 tiles. Any steps- or token-cost comparison across arms is contaminated.
10. **Metric-definition subtleties.** "Conditional read accuracy" and "code accuracy" have different numerators: a code can be a true code yet sit far from its label (0ebbb2b2's `M3Z`, reported 163 px from the nearest label). The doc's table for 0ebbb2b2 substitutes the code-accuracy numerator (14) for the conditional numerator, giving 45.2% instead of the correct 41.9%.
11. **All runs used one model** (`doubao-seed-evolving`, same provider) — good for internal comparability, but this is a single-model result with no replication across models.
12. **`truth.json` has a UTF-8 BOM**, and the downsampled arms contain four tiles whose delivered height differs from the stated tile size — both small, both signs that the pipeline is not exactly as documented.

## 5. Disagreements with the claims document (`stats-arms.md`)

| # | doc says | re-derivation | impact |
|---|---|---|---|
| 1 | 0ebbb2b2 conditional read rate **45.2%** (14/31) | **41.9%** (13/31) | Overstates it by 3.3 points. The 14 is the *code-accuracy* numerator; `M3Z` is a true code reported 163 px from its label, so it is not an in-range correct read. |
| 2 | 63036c9a: 16 real / **7 fabricated** | 23 real / **0 fabricated** (7 are repeats of real tiles: L5_00_x0_y0_w960_h540.png, L5_01_x0_y540_w960_h540.png, L5_02_x960_y0_w960_h540.png, L5_03_x960_y540_w960_h540.png, L5_05_x0_y1620_w960_h540.png, L5_13_x1920_y1620_w960_h540.png, L5_15_x2880_y1620_w960_h540.png) | Inflates the fabrication count, and causes §B to drop a run it should keep. |
| 3 | §B down-only vs down-then-up p = **0.2679** (2 vs 1 runs) | scope applied correctly: 2 vs 2 runs, z = 2.082, **p = 0.0373** | Reverses "depends on scope, therefore not claimed" into a nominally significant pooled result — still not a valid run-level test. |
| 4 | §C "both paired diffs are +16.7 points" | design-based pairing gives **+2.8** and **+16.7** | The "same sign and same magnitude" claim depends on an arbitrary pairing. |
| 5 | §A p = 0.0574 vs §C p = 0.027 for the same comparison | 0.0574 two-sided / 0.0287 one-sided | The document mixes one- and two-sided p-values. |
| 6 | a9cdcf16 "341 fabricated reads" | snapshot-dependent: 501 fabricated of 502 calls at my largest read, and still growing | Not a stable number; the session is still open. |
| 7 | per-run "命中中位误差" column (6.5, 3.3, 3.3, 3.9, 4.6, 2.4 px) vs the doc's own bullets (6.5, 3.0, 3.7, 4.9, 5.9, 3.1 px) | 36-nearest medians **6.51, 3.05, 3.69, 4.94, 5.85, 3.14** (the bullets) and in-range-only medians **6.51, 2.55, 3.46, 4.52, 4.05, 3.00** | The table column matches neither definition for 4 of 6 runs, and contradicts the doc's own bullet list for 5 of 6. Two different quantities share one column name. |
| 8 | §C sign test "p = 0.25" | two-sided sign test p = **0.500** (0.25 is the one-sided value) | Same one-sided/two-sided mixing as #5. |

Everything else I checked reproduced exactly: all six code accuracies (35, 14, 18, 8, 12, 13), all
precisions, the coverage counts (36, 31, 34, 32, 24, 34), five of the six conditional rates (97.2%, 52.9%,
25.0%, 50.0%, 38.2%), the pooled z = 6.94 / 5.33 / 1.90, the whole of §B's arithmetic as written, and the §C
pairing table itself.

## 6. Could NOT verify

- **`累计input` (cumulative input tokens)** in the doc's run table — I did not locate per-step usage records in the session JSONL and did not attempt to reconstruct token counts.
- **That the tiles were produced by the transform the doc claims.** I verified delivered dimensions only; I did not compare pixels, so "enlarged/interpolated" is taken from the experiment description, not confirmed.
- **That the 16 real tiles actually contain the 36 codes** `truth.json` asserts. I treated truth.json as ground truth without re-reading the images, so my metrics measure agreement *with truth.json*, not with the pixels.
- **What the scoring agent did.** I did not open or execute `score-runs.json` / `score-runs.mjs`; my numbers are independent, so agreement is a genuine cross-check, but I cannot speak to how those files computed theirs.
- **`a9cdcf16`'s final state** — it was still appending when I stopped; its counts will differ if read later.
- **Full prompt texts.** Prompt-family assignment matched on the literal `L5_00_x0_y0_w960_h540.png` appearing in the first user message, which is unambiguous, but I did not diff the complete prompt bodies.
