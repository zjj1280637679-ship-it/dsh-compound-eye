# dsh-compound-eye

**Compound-eye image delivery for vision models.** A model that must read small text or resolve small
icons from a large screenshot gets more from many small high-resolution facets than from one
downscaled frame. This plugin is the thing that produces the facets.

It is an **image processor**. It does not click, does not drive the desktop, does not capture the
screen, and registers **no computer-use provider** — so it can be mounted beside any computer-use
plugin, including the one that already owns the exclusive registry slot.

Use it on demand when a large screenshot loses readable text or tiny geometry. In the
[Luna localization pilot](experiments/luna/README.zh.md), ordinary buttons were hit 8/8 with every
delivery; tiny edges were hit 7/8 from the native full frame, 0/8 after downscaling, and 7/8 from native
tiles. Tiling recovered lost detail but did not beat native whole-frame hit rate in that single run.

```
AI: compound_eye(image={path:"shot.png"}, depth=4, targets=[{x:960,y:540,w:80,h:24,label:"save"}])
     -> 16 images, cuts placed to avoid the declared target
```

---

## Why this exists

Three measured facts, from a 3840×2160 experiment with 36 small labels across 11 independent
reader runs ([full record](docs/delivery-scale-theory.zh.md)) plus a later three-arm experiment
([report](docs/experiment-three-arm.zh.md), appendix H of the paper):

| Fact | Measurement |
|---|---|
| A whole-frame capture loses most of its pixels before the model sees it | 3840×2160 → delivered 1568×882 = **83.3% of source pixels discarded** |
| Cropping recovers them, because a region can own the whole delivery budget | whole frame **2.8%** read → 16 tiles **86.1%** read, same model, same prompt |
| **Cutting before downscaling beats cutting after it — and enlargement does not undo the loss** | native frame cut 1:1 **97.2%** read · frame pre-squeezed to the ceiling then cut **44.4%** · those same tiles enlarged back to the ceiling **30.6%** |

The third row is the reason the default is *cut the native source, deliver at 1:1*. The enlarged arm
delivered **2.67× more pixels than the native arm** and lost two thirds of the reads — so the ordering,
not the scale, is what carries the result.

Two caveats, stated because they bound the claim: the three-arm experiment enlarged tiles that had
*already* been downscaled (interpolation cannot invent detail there), so it does **not** show that
enlarging native detail is useless; and the 44.4% vs 30.6% gap is direction-consistent but **not claimed
significant** — p=0.037 when only runs that never read a non-existent path are compared (2 vs 2), p=0.057
pooling all six, and run-level tests are underpowered at these arm sizes (a 2 vs 2 permutation floor is
≈0.20). Every pooled p-value here is also **anti-conservative**: the 36 labels come from 1–3 runs each
and the native arm has a single run. What does hold in every framing is the run-by-run separation —
97.2% against 22.2–50.0%, i.e. 47–75 points.

And one failure that a plain crop loop walks straight into:

| Fact | Measurement |
|---|---|
| A target cut in half by a tile seam is unrecoverable | one clipped label read in **1 of 11 runs**, across two models and every delivery scale tested; upscaling did not help |

That row is the reason this plugin plans cuts instead of computing a grid.

---

## What it does differently from `crop()`

1. **Cuts avoid whole targets.** Declare the boxes that matter in `targets`; each cut is placed at the
   midpoint of the widest free gap between them. If a piece leaves no free gap, the cut is taken and
   **reported** (`report.forcedCuts`, `report.infeasible`, `report.straddling`) rather than silently
   producing half a target.
2. **The crop happens before any resampling.** A tile is cut out of the decoded source and only then
   scaled to its delivery size, never the reverse — and the tool passes that guarantee on by asking for
   the original capture. Measured on the same 36 labels: cut-then-scale **97.2%** read, scale-then-cut
   **44.4%**.
3. **Tiles are delivered at native scale by default.** Enlarging is available (`upscale:"2"` / `"max"`)
   but is **not** the default, because enlargement cannot create detail the source lacks and on
   already-downscaled content it measured *worse* than not enlarging at all. Each caption states whether
   a tile is `source px 1:1`, forced down by the ceiling, or `ENLARGED … interpolation adds no detail`,
   and the result warns when any tile was enlarged.
4. **The source rectangle travels with the image** — on the filename
   (`tile_r2c3_x960_y540_w960_h540.png`) and in a caption directly above the image. The coordinate
   contract needs no legend.

---

## Install

```yaml
# profile composition
- name: '@deepseek-ai/dsh-computer-use'   # only if you also run a computer-use provider
- name: dsh-compound-eye
```

`package.json` declares `dsh.bundle.patch`, so the standard loader picks it up. Configuration:

```yaml
- name: dsh-compound-eye
  config:
    deliveryMaxEdge: 1568   # long edge the delivery channel accepts before it resamples
    maxTiles: 64            # ADVISORY: exceeding it explains the cost, it never trims or refuses
    hardMaxTiles: 10000     # the only real ceiling, and an operator's resource bound, not a layout policy
```

> ⚠️ **Plugin code changes need a host restart.** Editing this package does not affect a running host.

---

## One planner, three orthogonal knobs

There is no mode to choose. `report.mode` is a **label for what the plan turned out to be**, never a fork
in behaviour, and the knobs compose:

| Knob | What it controls | What it never controls |
|---|---|---|
| `depth`, or `rows`+`cols` | **how many pieces**: `2^depth` tiles split across both axes (on 16:9: 2×2 at 2, 4×4 at 4, 8×8 at 6 — the same ladder the L2..L5 materials used) | anything else. The fan-out you ask for is the fan-out you get |
| placement (automatic) | **where the cuts fall when you don't say**: the default looks at the pixels and puts each seam in the emptiest band near its even position | how many pieces. See below — you are not required to answer this question |
| `placement: "even"` | the historical exact ladder, for byte-for-byte reproducible geometry | anything else |
| `targets` | **where the cuts fall when you do say**: each cut is placed in the widest free gap between declared targets | the fan-out. A target that cannot be kept whole at your fineness is **named**, not fixed by lowering your fineness |
| `overlap` | **grow every tile** by this fraction of its own size so neighbours overlap (0.15 = 15%) | the fan-out, and it is not an alternative to placement — it applies to whatever layout came out |
| `tiles` | **extra regions**, ADDED to whatever the fan-out produced — "the 4×4 grid, plus a zoom on the toolbar" is one call | the fan-out. It does not replace the grid, and it is never rewritten |

### Two ways to keep content whole, and neither one dominates

A seam passing through a glyph delivers it in two images, and a model cannot join two images. There are two
ways to prevent that, and they fail differently — so both are parameters, and they compose:

1. **Place the seam where the picture is empty** (the default, `placement`). Costs nothing in pixels, but it
   needs a clean line to *exist* near the even position. On a text-dense frame there is no such line.
2. **Overlap the tiles** (`overlap`). Needs no clean line at all: anything on a seam is whole in at least one
   neighbour. Costs delivered pixels, and can push a grown tile past the delivery ceiling, where that tile
   gets downscaled.

Measured on this repository's materials (3840×2160, 36 labels, boxes 58×24; re-measured in CI by
`experiments/seam-placement.mjs`) — each cell is *labels a seam passes through / labels no tile contains*:

| depth | tiles | even ladder | content placement | even + 15% overlap |
|---|---|---|---|---|
| 3 | 8 | 3/3 | **0/0** | **0/0** |
| 4 | 16 | 4/4 | **0/0** | **0/0** |
| 5 | 32 | 4/4 | **0/0** | **0/0** |
| 6 | 64 | 5/5 | **0/0** | **0/0** |

At depth 4 the delivered pixels are: even 8.29 M · **content 8.29 M (+0%)** · even+overlap 10.28 M (+24%).
These materials are sparse enough that a clean line always exists, so placement wins on cost here.

Then the regime where it does not — a frame with **no** clean line anywhere (a uniform seam profile, i.e. a
stand-in for "my screenshot is text everywhere"):

| depth | tiles | content placement | content + 15% overlap | overlap cost |
|---|---|---|---|---|
| 3 | 8 | 3/36 lost | **0/36 lost** | +20% pixels |
| 4 | 16 | 4/36 lost | **0/36 lost** | +24% pixels |
| 6 | 64 | 5/36 lost | **0/36 lost** | +28% pixels |

⇒ With a clean line available, place the seam. With none, overlap is the only thing that saves the labels.
The plugin does not decide this for you: `placement` defaults to content-aware because it is free when it
works, and `overlap` is there for when it doesn't. They can be used together. Declared `targets` are not
suppressed by either — targets and content are two kinds of evidence for the same objective (do not cut
through things), so all candidate placements are scored on *targets left not-whole first, then seam contrast*,
and the winner is named in `report.candidates`.

### You do not have to decide where to cut

The caller always says *how many* pieces. Making them also say *where* would ask them to decide about pixels
they have not measured — so the default is that the plugin looks, and drops each seam into the emptiest band
near its even position. Measured on this repository's own materials (3840×2160, 36 labels, boxes 58×24,
re-measured in CI by `experiments/seam-placement.mjs`):

| depth | tiles | even ladder slices | default placement slices |
|---|---|---|---|
| 2 | 4 | 0/36 | **0/36** |
| 3 | 8 | 3/36 | **0/36** |
| 4 | 16 | **4/36** | **0/36** |
| 5 | 32 | 4/36 | **0/36** |
| 6 | 64 | 5/36 | **0/36** |

A label a seam passes through is delivered in two images, and a model cannot join two images — measured
earlier at 1 read in 11 runs across two models, with upscaling never helping. So this is the failure the
default exists to avoid. `placement: "even"` remains for the case where you want the exact historical
geometry; declared `targets` always take precedence over both.

### Cuts are integers, and they are stated

Every cut is a whole number in **source coordinates**, which makes a cut an *annotation*: something that can
be written down, compared against a label's coordinates, diffed between two runs, and checked by a machine.
So the result states them, and `report.cuts` carries them as data:

```
CUTS (integer source coordinates): x=829,1982,2789  y=657,1142,1518. Why they are stated: anything crossing
one of these lines ends up in two images, and a model cannot join two images.
```

The same rule is applied to input: fractional rectangles and targets are rounded to whole pixels, and the
rounding is **reported** in `report.adjusted` rather than done quietly, because a rounded crop is a different
crop from the one that was asked for.

An earlier design had three "modes" instead, and the target-aware one carried a self-imposed invariant —
*never split a declared target* — that could **contradict the fan-out the caller asked for**. It resolved
that contradiction by reducing the fan-out. That is the tool fighting itself: invent a strict rule, then
break the caller's explicit request to keep it, and call the result "reduced" as if the caller had asked
for it. Splitting a target is a **consequence of a fineness the caller chose**, so it is reported:

```
PLAN: grid 4x4 (depth 4); even cuts (no target-aware placement was better).
TARGETS: at this fan-out no cut placement keeps every declared target whole, so these are cut:
toolbar-band; not whole inside any single tile: toolbar-band. The fan-out is the one you asked for --
reported, not corrected. Lower the depth, add your own rectangles via `tiles`, or accept the split.
```

Coverage is described, not judged, because "deliver all 16 quadrants" and "zoom into three regions" are
both legitimate requests and a deliberate overlap is how you keep a target whole across a seam:

| The rectangles you ended up with | What you are told |
|---|---|
| a gapless partition | `LAYOUT: the delivered rectangles tile the whole frame exactly (100% coverage, no overlap).` |
| overlapping | `LAYOUT: … cover the whole frame, and overlap by 182 kpx (35.2% of the frame is delivered twice) -- overlap is how a target gets kept whole across a seam, so nothing is wrong here.` |
| partial | `LAYOUT is a PARTIAL delivery: 50.4% of the frame is delivered and 257 kpx (49.6%) is NOT delivered at all -- you will see nothing in those regions. Gaps, largest first (±4px): x=0 y=272 w=960 h=268. Add rectangles for any that matter…` |

A layout that silently drops a region is the only real failure mode here, so the holes are named as
rectangles (`report.coverage.gapRects`) instead of being summarised into a number. Only genuinely
impossible rectangles are refused, and only before anything is persisted: a degenerate tile, or one
lying entirely outside the frame. A tile that merely sticks out is delivered clipped and listed in
`report.clipped`.

```
# fan-out only: 16 tiles, all 960x540
compound_eye(image={path:"shot.png"}, depth=4)

# same fan-out, but no cut through the declared button
compound_eye(image={path:"shot.png"}, depth=4,
             targets=[{x:936,y:884,w:58,h:20,label:"save"}])

# the grid AND a zoom region, in one call (they compose; `tiles` does not replace the grid)
compound_eye(image={path:"shot.png"}, depth=4,
             tiles=[{x:880,y:840,w:200,h:120}])

# rectangles only, described and reported back (partial or overlapping layouts welcome)
compound_eye(image={path:"shot.png"},
             tiles=[{x:0,y:0,w:960,h:2160},{x:960,y:0,w:960,h:2160},
                    {x:1920,y:0,w:960,h:2160},{x:2880,y:0,w:960,h:2160}])
```

### Choosing a depth

There is nothing to tune by feel — the depth is set by what must stay readable and whole:

| Want | Do |
|---|---|
| an object must be whole in one image | declare it in `targets`; the planner tries to keep it whole and reports any target the chosen layout does not protect |
| an object must be *readable* | deep enough that the tile is at native scale (a tile near the frame's own size gains nothing) |
| finer localization | **not** a reason to go deeper — see below |

**Finer splits do not buy localization precision.** A tile's per-axis pitch is what a coordinate error
scales with, so splitting the 3840px axis into n columns bounds the horizontal error at about
`3840/(2n)` px — 480px at n=4, 270px at n=8. Meanwhile the measured error of the normalized-coordinate
contract is **2–13px**, because client-side mapping is deterministic. Reaching that by tiling would need
n≈150. So depth is for *legibility*, and every extra cut costs a seam — and a seam is what breaks the
11% of targets that touch one.

## Tools

### The real cost of an image is not its pixels

In an agent loop, step k resends the **whole accumulated context** — system prompt, tool definitions,
every image already delivered, and the history. With a fixed baseline B, new content δ per step, and N
steps:

```
cumulative input ≈ N·B + δ·N(N-1)/2
```

Under this full-history model, step count sits in the **quadratic** term. The following are modeled
using measured token parameters for the same 16 images, not a controlled trial of delivery shapes:

| Delivery | cumulative inputTokens | relative |
|---|---|---|
| **one call, 16 images** | **47,940** | 1.00× |
| 4 calls of 4 images | 174,960 | **3.65×** |
| 16 calls of 1 image | 1,043,040 | **21.76×** |

And the comparison that decides design questions:

| | cumulative inputTokens |
|---|---|
| depth 4 (16 images, 1 call) | 47,940 |
| depth 5 (32 images, **1 call**) | 75,140 (1.57×) |
| depth 4 **plus one more step** | 99,880 (2.08×) |

**In this model, doubling the tiles is cheaper than adding a step.** Actual billed cost also depends on
caching and the host's context handling; the Luna pilot did not measure cost. So:

- **This plugin returns all tiles from one call, by design.** Never make the caller loop to fetch tiles
  one at a time; that is the 21× case.
- **A feature that adds a step must earn more than one that adds images.** "Verify by looking again" is
  expensive; "hand back everything needed to decide once" is not.
- Adding tiles is not free either — they stay in the context and are resent every later step. Depth is
  for legibility, not for precision (see above).

### `compound_eye`
Splits an image and returns the tiles as images.

| Parameter | Meaning |
|---|---|
| `image` | `{path}` or `{base64, name}`. PNG only. |
| `depth` | Number of splits; `2^depth` tiles. `0` = whole frame. **This is the model's knob** — the plugin never picks it. |
| `rows` / `cols` | Explicit grid instead of `depth`. |
| `targets` | Optional boxes that must stay whole in one tile. **Supply these whenever you know them** — this decides where the cuts fall, and nothing else. If your fan-out cannot honour one, it is named, not fixed by shrinking your fan-out. |
| `placement` | `"content"` (default) or `"even"`. Judged together with `targets`, never suppressing them. |
| `overlap` | Grow every tile by this fraction so neighbours overlap, e.g. `0.15`. The other way to keep content whole; applies to any layout and composes with everything above. |
| `tiles` | Rectangles to ADD to the fan-out — they compose (grid + zoom regions in one call); on their own they ARE the layout. Described and reported, never rewritten. Partial and overlapping layouts are accepted and classified; only degenerate or fully off-frame rectangles are refused. |
| `upscale` | `"native"` (default, never enlarges), a number, or `"max"`. |
| `maxTiles` | Advisory threshold on images per call. Exceeding it does not trim or refuse: you get what you asked for, plus a note on the cost. |

### `compound_eye_probe`
Same parameters and planning, **no images returned**: effective source rectangles, delivery sizes, and
whether any declared target is missing from every whole tile. It accepts the same full PNG as delivery;
content-aware placement needs decoded pixels, not only a header. Zero image cost. Use it when unsure how
deep to split, or to confirm continuity before spending a call that returns pictures. It persists nothing.

### The coordinate contract

Report coordinates as **normalized `(u,v) ∈ [0,1]` inside the single image you looked at**. The caller
maps back with:

```
global = (source.x + u * source.w, source.y + v * source.h)
```

For a rectangle extending outside the image, `source`, filename, caption, and delivery size all describe
the effective clipped region. The original requested rectangle remains in `report.clipped`. Numeric
`upscale` and `"max"` both respect `deliveryMaxEdge`; enlargement never bypasses the configured ceiling.
Target protection is checked against every effective delivered region, including overlap and extra
rectangles. A failed heuristic search reports the chosen layout's missing targets, not global impossibility.

Normalization is **size-independent on purpose**: a reader that has the wrong idea about how large the
delivered image is still maps correctly. That is not a theory — it is the measured behaviour of a
reader that misreported the delivered size and still landed every point within 8 px.

---

## What is verified, and what is not

`node test/selftest.mjs` — **63 assertions** on the pure core: lossless PNG round-trip, refusal of
formats it does not implement, exact 1:1 crops, range preservation under area-average shrink, the
interpolation signature under enlargement, and the planner (fan-out never reduced at any depth, no
degenerate tiles, targets kept whole where the fineness allows and named where it does not, coverage
classified, grid-plus-rectangles composition, integer cuts and reported rounding, content-aware placement
beating the even ladder on a synthetic ink band, overlap growing every tile and being measured, and
targets-plus-content scored together rather than one suppressing the other).

`node test/e2e-stub.mjs` — **50 assertions** on the full delivery path against a stub attachments
service (plan → resample → encode → persist → image block), including a continuity re-check against the
real label boxes measured in the originating experiment, the separation of the three delivery states a
caption can report (1:1 / forced down / enlarged), the classification a set of rectangles gets
(exact / complete-overlapping / partial, with named holes), and the defaults at the tool boundary
(content-aware placement, cuts stated as integer coordinates, `placement:"even"` on demand).

`node --test test/package-manifest.test.mjs` — **4 assertions** locking the packaging contract that
prevents the dual-package hazard.

`node --test test/image-regression.test.mjs test/grid-regression.test.mjs` — **14 portable tests** for
all four clipped edges and coordinate mappings, the delivery ceiling and probe parity, weighted-area
shrinking, crop-boundary interpolation, invalid-layout atomicity, overlapping/extra target protection,
the target-search axis fallback, and actual partition shape reporting. These tests need neither a host
nor the external screenshot archive. `report.rows/cols` describe an actual Cartesian grid; for a
non-Cartesian partition they are null and `report.shape` is `"partition"`. The original requested shape
remains in `report.nominalRows/nominalCols`.

**Not yet verified, stated plainly:**

- **The three-arm numbers were not produced by this plugin.** They come from a script that reproduced
  the plugin's three calling semantics (native cut · pre-downscaled cut · pre-downscaled cut + enlarge)
  on the same source and labels. The plugin's own delivery path is exercised by the stub tests, not by
  that experiment — the two are *isomorphic*, not identical.
- **No end-to-end run inside a live host.** The tools have not been mounted and called through the
  attachments service in a real session. Everything above runs against a stub.
- **The live host coordinate loop remains unverified.** The Luna pilot round-tripped PNGs from the
  real executor through a file-image tool and normalized reports; live host attachments, desktop
  DPI/window mapping, and actual clicks have not been tested.
- **The clipping threshold is not calibrated against this planner.** The measured 19.4% of labels whose
  ink crosses a tile seam (5.6% never fully delivered) came from a **geometric** grid. This planner's
  target-aware cuts should reduce that, and the reduction has not been measured.
- **The historical figures come from two models and one synthetic capture.** The sample is small
  (`n=36`, 1 SE ≈ 6.7 points) and the effect sizes for upscaling are within noise on the second model.
  They are quoted as measurements with their conditions, not as general laws.

---

## Companion documents

The paper, the three-arm experiment, the cross-model replication, the method note and the independent
review live in [`docs/`](docs/README.md). They are included rather than linked because every number the
README cites should be checkable from inside this repository.

The raw material behind those numbers lives in [`experiments/`](experiments/README.md): the 48 stimuli
the three readers were actually given, their answers verbatim, the ground truth, and the scoring code.

```bash
node experiments/three-arm/rescore.mjs --check   # reproduces the published table, or fails loudly
```

That check runs in CI, so the published figures cannot drift away from the shipped data unnoticed.

---

## Design constraints this package follows

- **No a-priori pruning.** The plugin describes; it does not decide for the caller. The caller is a model
  in conditions this plugin cannot see — a different budget, a different consumer for the images, a reason
  that only exists at call time — so a capability is never added by taking a freedom away. Concretely:
  - the size of a request is the caller's call. Ask for 64 tiles and you get 64, with a note about what
    that costs; `maxTiles` is an **advisory** threshold that makes the note appear earlier, not a wall.
  - the shape of a layout is the caller's call. Rectangles you supply are classified (exact /
    complete-overlapping / partial) with uncovered holes named, rather than refused for being a subset you
    deliberately chose; and they **compose** with the fan-out instead of replacing it.
  - the only ceiling left is physical and belongs to the operator: `hardMaxTiles` (one call cannot return
    more images than a context could hold). A refusal that does exist is a resource bound, not a taste,
    and it says so.
  - "I cannot do this" is reserved for the physically impossible, always before anything is persisted:
    an unreadable image, an unsupported PNG, a missing attachments service, a degenerate rectangle, a
    rectangle lying entirely outside the frame. A rectangle that merely sticks out is delivered clipped
    and listed.
- **No rule that has to break the request to keep itself.** An invariant the tool invents internally must
  never be paid for with the caller's explicit instruction. The planner used to treat "never split a
  declared target" as such an invariant and, when the requested fan-out made it unsatisfiable, lowered the
  fan-out — the tool fighting itself, and calling the result "reduced" as if the caller had asked for it.
  Splitting a target is a *consequence of a fineness the caller chose*, so it is reported by name along
  with the ways out (lower the depth, add rectangles, accept the split). The same shape of mistake is what
  "no a-priori pruning" rules out one level up.
- **No shared mutable state.** Every call states its own source; there is no "last image" or "last
  grid" to be overwritten by another caller.
- **No implicit coupling.** The plugin imports from `lib/*` explicitly and stores nothing module-level.
- **Refusals are named.** A missing attachments service, an unsupported PNG, a depth that would
  explode: each throws with its reason instead of degrading quietly.
- **The encoder is lossless.** This plugin's whole subject is whether pixels survive delivery, so it
  must not be the thing that blurs them.

## License

MIT
