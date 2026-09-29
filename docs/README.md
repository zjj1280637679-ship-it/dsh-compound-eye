# Companion documents

The measurements this plugin cites live here, so every number in the top-level README can be checked
from inside the repository instead of being taken on trust.

| File | What it is |
|---|---|
| [`delivery-scale-theory.zh.md`](delivery-scale-theory.zh.md) | The hypothesis paper: statement, evidence, competing theory, falsification conditions, and appendices A–H with the raw measurements. **Appendix H is the three-arm experiment.** |
| [`experiment-three-arm.zh.md`](experiment-three-arm.zh.md) | The three-arm experiment in full: design, run-level data, three statistical framings, the `where`/`what` split, the full misread table, and the honest limits. |
| [`methodology-discriminative-experiments.zh.md`](methodology-discriminative-experiments.zh.md) | The method note: how to build an experiment that can actually discriminate between rival explanations, and the failure modes that were hit while doing it. |
| [`cross-model-replication.zh.md`](cross-model-replication.zh.md) | The cross-model replication (a second model, five arms) that produced the "enlargement is a top-up, not a gain" correction. |
| [`review-dsv4pro.md`](review-dsv4pro.md) | The independent review that found four hard errors in the paper's first draft, and what was done with each finding. |

All five documents are in Chinese. They are snapshots copied from the authoring workspace; the paper is
the living document and this copy tracks it at the commit date.

## The one number that motivates the default

| Delivery | Per-tile | Total delivered pixels | Labels read |
|---|---|---|---|
| Cut the **native** frame, deliver 1:1 | 960×540 | 8.29 M (= the whole frame) | **97.2%** |
| Squeeze the frame to the delivery ceiling, then cut | 392×221 | 1.39 M | 44.4% |
| …then enlarge those tiles back to the ceiling | 1568×884 | 22.2 M (**2.67×** the native arm) | 30.6% |

So the plugin cuts first and resamples second, and never enlarges unless asked. Two caveats the
documents state and this file repeats: the experiment enlarged tiles that had *already* been downscaled
(so it does not show that enlarging native detail is useless), and the 44.4% vs 30.6% gap is
direction-consistent but **not claimed significant** — p=0.037 when only runs that never read a
non-existent path are compared (2 vs 2), p=0.057 pooling all six, and run-level tests are underpowered
at these arm sizes. Every pooled p-value is also anti-conservative (36 labels from 1–3 runs each; the
native arm has one run). The run-by-run separation — 97.2% against 22.2–50.0% — holds in every framing.
