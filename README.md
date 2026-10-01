# dsh-compound-eye

**Compound-eye image delivery for vision models.** A model that must read small text or resolve small
icons from a large screenshot gets more from many small high-resolution facets than from one
downscaled frame. This plugin is the thing that produces the facets.

It is an **image processor**. It does not click, does not drive the desktop, does not capture the
screen, and registers **no computer-use provider** — so it can be mounted beside any computer-use
plugin, including the one that already owns the exclusive registry slot.

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
    maxTiles: 64            # refuse instead of flooding the context
```

> ⚠️ **Plugin code changes need a host restart.** Editing this package does not affect a running host.

---

## Three modes, in the order they should be tried

The plugin picks the mode from what you pass, and always reports which one ran (`report.mode`).

| Mode | When | What happens |
|---|---|---|
| **`simple`** | you declare no `targets` | An exact grid, no search. `depth` d gives `2^d` tiles split across both axes: on 16:9 that is 2×2 at 2, 4×4 at 4, 8×8 at 6 — the same ladder the L2..L5 experiment materials used. Predictable by construction. |
| **`aware`** | you declare `targets` | Same fan-out, but every cut may shift into a free gap so no declared target is split. If the requested depth admits no such partition, the depth is **reduced** and said so; if *no* partition can keep a target whole (e.g. the target is a full-width band), you get a loud `infeasible` naming it. |
| **`manual`** | you pass `tiles` | You supply the rectangles. The plugin **describes** them instead of judging them: it measures coverage and overlap and reports which targets straddle a boundary, but it does **not** rewrite anything and it does **not** require the layout to tile the frame. This is the escape hatch for a layout the planner cannot infer. |

Coverage in `manual` mode is not a pass/fail question, because "deliver all 16 quadrants" and "zoom into
the three regions I care about" are both legitimate requests, and a deliberate overlap is how you keep a
target whole across a seam. So the three cases are named rather than allowed or forbidden:

| You built | You get |
|---|---|
| a gapless, non-overlapping partition | `Manual layout accepted: the tiles tile the whole frame exactly (100% coverage, no overlap).` |
| an overlapping layout | `…cover the whole frame, and overlap by 182 kpx (35.2% of the frame is delivered twice) -- overlap is how a target gets kept whole across a seam, so nothing is wrong here.` |
| a partial layout | `…it is a PARTIAL delivery: 50.4% of the frame is delivered and 257 kpx (49.6%) is NOT delivered at all -- you will see nothing in those regions. Gaps, largest first (±4px): x=0 y=272 w=960 h=268. If any of them matter, add tiles for them…` |

A layout that silently drops a region is the only real failure mode here, so the holes are named as
rectangles (`report.coverage.gapRects`) instead of being summarised into a number. Only genuinely
impossible rectangles are refused, and only before anything is persisted: a degenerate tile, or one
lying entirely outside the frame. A tile that merely sticks out is delivered clipped and listed in
`report.clipped`.

```
# simple: 16 tiles, all 960x540
compound_eye(image={path:"shot.png"}, depth=4)

# aware: same 16 tiles, but no cut through the declared button
compound_eye(image={path:"shot.png"}, depth=4,
             targets=[{x:936,y:884,w:58,h:20,label:"save"}])

# manual: your own layout, described and reported back (partial or overlapping layouts welcome)
compound_eye(image={path:"shot.png"},
             tiles=[{x:0,y:0,w:960,h:2160},{x:960,y:0,w:960,h:2160},
                    {x:1920,y:0,w:960,h:2160},{x:2880,y:0,w:960,h:2160}])
```

### Choosing a depth

There is nothing to tune by feel — the depth is set by what must stay readable and whole:

| Want | Do |
|---|---|
| an object must be whole in one image | declare it in `targets`; the planner refuses to cut through it |
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

Step count sits in the **quadratic** term; per-call data volume sits in the **linear** one. Measured from
the experiment that produced this plugin (same 16 images, different delivery shapes):

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

**Doubling the tiles is cheaper than adding a step.** So:

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
| `targets` | Optional boxes that must stay whole in one tile. **Supply these whenever you know them** — this is what turns a grid into a plan. |
| `tiles` | Optional manual layout: your own rectangles, described and reported, never rewritten. Partial and overlapping layouts are accepted and classified; only degenerate or fully off-frame rectangles are refused. |
| `upscale` | `"native"` (default, never enlarges), a number, or `"max"`. |
| `maxTiles` | Per-call cap. |

### `compound_eye_probe`
Same planning, **no images returned**: tile rectangles, delivery sizes, and whether any declared target
would straddle a cut. Zero image cost. Use it when unsure how deep to split, or to confirm continuity
before spending a call that returns pictures. It persists nothing.

### The coordinate contract

Report coordinates as **normalized `(u,v) ∈ [0,1]` inside the single image you looked at**. The caller
maps back with:

```
global = (source.x + u * source.w, source.y + v * source.h)
```

Normalization is **size-independent on purpose**: a reader that has the wrong idea about how large the
delivered image is still maps correctly. That is not a theory — it is the measured behaviour of a
reader that misreported the delivered size and still landed every point within 8 px.

---

## What is verified, and what is not

`node test/selftest.mjs` — **33 assertions** on the pure core: lossless PNG round-trip, refusal of
formats it does not implement, exact 1:1 crops, range preservation under area-average shrink, the
interpolation signature under enlargement, and the partition planner (fan-out, target continuity,
refusal reporting, no degenerate tiles at any depth).

`node test/e2e-stub.mjs` — **29 assertions** on the full delivery path against a stub attachments
service (plan → resample → encode → persist → image block), including a continuity re-check against the
real label boxes measured in the originating experiment, and the separation of the three delivery
states a caption can report (1:1 / forced down / enlarged).

`node --test test/package-manifest.test.mjs` — **4 assertions** locking the packaging contract that
prevents the dual-package hazard.

**Not yet verified, stated plainly:**

- **The three-arm numbers were not produced by this plugin.** They come from a script that reproduced
  the plugin's three calling semantics (native cut · pre-downscaled cut · pre-downscaled cut + enlarge)
  on the same source and labels. The plugin's own delivery path is exercised by the stub tests, not by
  that experiment — the two are *isomorphic*, not identical.
- **No end-to-end run inside a live host.** The tools have not been mounted and called through the
  attachments service in a real session. Everything above runs against a stub.
- **Coordinates have not been round-tripped through a real delivery.** The mapping arithmetic is
  tested; the full loop (plugin → host → model → normalized report → mapped back) has not.
- **The clipping threshold is not calibrated against this planner.** The measured 19.4% of labels whose
  ink crosses a tile seam (5.6% never fully delivered) came from a **geometric** grid. This planner's
  target-aware cuts should reduce that, and the reduction has not been measured.
- **The figures in this README come from two models and one synthetic capture.** The sample is small
  (`n=36`, 1 SE ≈ 6.7 points) and the effect sizes for upscaling are within noise on the second model.
  They are quoted as measurements with their conditions, not as general laws.

---

## Companion documents

The paper, the three-arm experiment, the cross-model replication, the method note and the independent
review live in [`docs/`](docs/README.md). They are included rather than linked because every number the
README cites should be checkable from inside this repository.

---

## Design constraints this package follows

- **Rather see more than miss.** A request is never refused merely because it asked for more than the
  cap allows: the plugin delivers the deepest split that fits and says the depth was capped. A refusal
  costs the caller another STEP, and a step resends the whole context (see the cost table above). Only
  genuinely impossible requests are refused, and only before anything is persisted:
  an unreadable image, a missing attachments service, an over-cap **manual** layout (which cannot be
  reduced without breaking the rectangles the caller chose).
- **Cuts never break a declared target.** If a target cannot be kept whole (it is a full-width band, say),
  that is reported by name rather than silently cut through.
- **No shared mutable state.** Every call states its own source; there is no "last image" or "last
  grid" to be overwritten by another caller.
- **No implicit coupling.** The plugin imports from `lib/*` explicitly and stores nothing module-level.
- **Refusals are named.** A missing attachments service, an unsupported PNG, a depth that would
  explode: each throws with its reason instead of degrading quietly.
- **The encoder is lossless.** This plugin's whole subject is whether pixels survive delivery, so it
  must not be the thing that blurs them.

## License

MIT
