# Experiments

The evidence behind every number the plugin's README cites. Kept here rather than in the authoring
workspace so that a claim can be checked from inside the repository.

Documents live in [`../docs/`](../docs/README.md); this directory holds the **raw material** — the
stimuli, the readers' answers, the ground truth and the scoring code.

```
truth.json                 36 ground-truth labels {code,x,y} + the 16 source rectangles used for reading
three-arm/                 the experiment that decided the plugin's default: cut native, or cut after downscaling
  stimuli/{naive,down-only,down-then-up}/   48 PNGs -- the actual images three readers were given
  answers/                 the final answer of each run, verbatim, plus registry.json (which run is which arm)
  rescore.mjs              run this: reproduces the published table from the files in this directory
  as-run/                  the scripts that produced the published numbers, kept verbatim for audit
  results/                 their outputs, including the independent verification
first-experiment/          the L2..L5 level ladder (whole frame vs 2/4/16/32 tiles)
cross-model/               the replication on a second model, 5 arms x 16 reads
```

## Reproducing the three-arm numbers

```bash
node experiments/three-arm/rescore.mjs
```

It needs nothing but this repository: `truth.json`, `answers/*.txt`, `answers/registry.json`.
It prints the per-run table and the three statistical framings, and its output **matches the published
table figure for figure** — including the corrected conditional-read rate of 13/31 = 41.9% for
`0ebbb2b2`, which an earlier version of the report got wrong.

## Two things verified rather than assumed

1. **Which run is which arm.** All three arms use *identical filenames*
   (`L5_00_x0_y0_w960_h540.png` …), because a filename describes the **source rectangle**, not the
   delivered size. So arm identity cannot come from filenames; `answers/registry.json` derives it from
   the `read_image` paths each session actually touched. An analysis that groups by filename would
   silently merge all three arms into one.
2. **The two L5 tile sets are the same image.** `first-experiment/tiles/L5_*.png` and
   `three-arm/stimuli/naive/L5_*.png` share names but have different SHA256. Decoded with this
   plugin's own codec they are **pixel-identical** (0 differing channel values out of 2,073,600 per
   tile, checked with `as-run/compare-stimuli.mjs`) — the difference is PNG encoding only. That is
   what makes `truth.json` valid for both sets, and it means the `naive` arm of the three-arm
   experiment *is* the L5 level of the first experiment.

## What is deliberately not here

- **The raw session transcripts.** They are tens of megabytes each and contain the full prompts. The
  answers they produced are shipped instead, verbatim, so the scoring is reproducible without them.
  For the same reason `as-run/*.mjs` reads the author's session store and will not run elsewhere —
  it is kept as an audit trail of what was actually executed, not as a tool. `rescore.mjs` is the
  runnable path.
- **One-off diagnostics.** `as-run/` keeps the twelve scripts that produced or checked published
  numbers; the ~35 exploratory scratch scripts (peek/dbg/diag/tally variants) are omitted. If a number
  in a report ever needs re-deriving from scratch, the sessions are the source of truth, not those.

## Path mapping

The reports were written in the authoring workspace and cite paths like
`D:\deepseek\.tmp\threearm\score-runs.mjs`. In this repository:

| cited path | here |
|---|---|
| `.tmp/attn-exp/truth.json` | [`truth.json`](truth.json) |
| `.tmp/threearm/runs/<arm>/*.png` | `three-arm/stimuli/<arm>/*.png` |
| `.tmp/threearm/out/*.txt` | *(superseded — early extractions; the shipped `answers/` are the final ones)* |
| `.tmp/threearm/{audit-runs,score-runs,stats-arms,verify-reads}.mjs` | `three-arm/as-run/` |
| `.tmp/threearm/{score-runs.json,stats-arms.md,verify-independent.*}` | `three-arm/results/` |
| `.tmp/attn-exp/arm-*.txt`, `tiles/`, `tiles-up/`, `full/` | `first-experiment/` |
| `.tmp/xmodel/` | `cross-model/` |

## Using these numbers honestly

Three warnings, all of which the reports themselves state:

- **Every pooled p-value is anti-conservative.** The 36 labels are treated as independent samples but
  come from 1–3 runs each, and the native arm has a single run (pseudoreplication). At run level this
  design has almost no power. The durable evidence is the run-by-run separation: 97.2% against
  22.2–50.0%, i.e. 47–75 points, versus a within-arm drift of at most 13.9 points.
- **`down-only` vs `down-then-up` is direction-only.** All four framings point the same way
  (enlarging a downsampled tile read lower), but significance depends on how runs are pooled, and
  "both paired differences are +16.7" is an artefact of pairing by completion order — pairing by
  prompt generation gives +2.8 and +16.7.
- **The fourth cell is missing.** The experiment enlarged tiles cut from an *already downsampled*
  frame, where interpolation cannot invent detail. It therefore does **not** show that enlarging
  native detail is useless.

`three-arm/answers/a9cdcf16.txt` is the abandoned run: 590 `read_image` calls, 589 of them against
paths that do not exist, delivering `TOTAL_OBSERVED: 0`. It is kept because it documents the failure
mode that a missing filename list causes, and because a reader should be able to see that this run
contributed nothing.
