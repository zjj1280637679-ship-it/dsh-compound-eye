/**
 * Compound-eye partition: split a viewport into tiles the way a compound eye samples a scene.
 *
 * THREE MODES, in the order they should be tried. This is deliberately tiered: the simple path is the
 * default because it is predictable, and the clever path only runs when there is something to avoid.
 *
 *   1. `simple`   -- divide rows x cols evenly. No search, no surprises. For a 16:9 frame this yields
 *                    2x2 at rows=cols=2, 4x4 at 4, 8x8 at 8, exactly the shapes the L2..L5 experiment
 *                    materials used. This is what you get when you declare no targets.
 *   2. `aware`    -- same fan-out, but every cut may be shifted into a free gap so no declared target is
 *                    split. If the requested depth admits no such partition, the depth is REDUCED and
 *                    said so, rather than cutting through a target.
 *   3. `manual`   -- the caller supplies the rectangles. The planner validates them (full coverage,
 *                    no overlap, no degenerate tile) and reports which targets straddle a boundary, but
 *                    it does NOT silently fix them. This is the escape hatch when a caller knows a layout
 *                    the planner cannot infer -- targets it was never told about, for instance.
 *
 * WHY THE TARGET RULE EXISTS AT ALL: a target split by a cut is whole in NO delivered image, and a model
 * cannot combine two images. Measured in this workspace: such a label was read in 1 of 11 runs across two
 * models and every delivery scale tested, and upscaling never helped -- the other half was never in the
 * same image.
 */

/** Merge overlapping [a,b) spans into a sorted, disjoint list. */
export function mergeSpans(spans) {
  const s = spans.filter(x => x && x.b > x.a).slice().sort((p, q) => p.a - q.a)
  const out = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x.a <= last.b) last.b = Math.max(last.b, x.b)
    else out.push({ a: x.a, b: x.b })
  }
  return out
}

/**
 * Cut positions inside [lo,hi) that do NOT split any span, ordered by balance (closest to the midpoint
 * first).
 *
 * A span [a,b] blocks the open interval (a,b). Its exact edges are legal cuts, but they are NOT offered:
 * a target whose box starts exactly at the cut would sit flush against that image's border, which is the
 * same hazard the planner exists to avoid. So each side of a span is offered one pixel clear of it.
 */
export function validCuts(lo, hi, spans) {
  if (hi - lo < 3) return []
  const inner = mergeSpans((spans || [])
    .map(s => ({ a: Math.max(s.a, lo), b: Math.min(s.b, hi) }))
    .filter(s => s.b > lo && s.a < hi))
  if (!inner.length) return [Math.floor((lo + hi) / 2)]

  const cands = new Set()
  let cursor = lo
  for (const s of inner) {
    if (s.a - 1 > cursor) {
      cands.add(s.a - 1)
      cands.add(Math.floor((cursor + s.a) / 2))
    } else if (s.a > cursor) {
      cands.add(Math.floor((cursor + s.a) / 2))
    }
    cursor = Math.max(cursor, s.b)
    if (s.b + 1 < hi) cands.add(s.b + 1)
  }
  if (cursor < hi) cands.add(Math.floor((cursor + hi) / 2))

  const mid = (lo + hi) / 2
  return [...cands]
    .filter(c => c > lo && c < hi && !inner.some(s => c > s.a && c < s.b))
    .sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))
}

/** A single cut inside [lo,hi) avoiding spans, for callers that want one decision rather than a search. */
export function chooseCut(lo, hi, spans) {
  const c = validCuts(lo, hi, spans)
  if (!c.length) return { cut: null, gap: 0, clean: false }
  const inner = mergeSpans((spans || [])
    .map(s => ({ a: Math.max(s.a, lo), b: Math.min(s.b, hi) }))
    .filter(s => s.b > lo && s.a < hi))
  let gap = hi - lo
  let cursor = lo
  for (const s of inner) { if (s.a > cursor) gap = Math.max(gap, s.a - cursor); cursor = Math.max(cursor, s.b) }
  if (cursor < hi) gap = Math.max(gap, hi - cursor)
  return { cut: c[0], gap, clean: true }
}

/** Even division of [0,total) into `n` pieces: exact, contiguous, covers everything, no gaps. */
export function evenCuts(total, n) {
  const out = []
  for (let i = 1; i < n; i++) out.push(Math.round((total * i) / n))
  return out
}

const splitAt = (p, c, axis) => (axis === 'x'
  ? [{ x: p.x, y: p.y, w: c - p.x, h: p.h }, { x: c, y: p.y, w: p.x + p.w - c, h: p.h }]
  : [{ x: p.x, y: p.y, w: p.w, h: c - p.y }, { x: p.x, y: c, w: p.w, h: p.y + p.h - c }])

/**
 * Which axis to halve next.
 *
 * THE RULE: halve the LONGER side. It is what makes the per-axis pitch (how much x or y one tile spans)
 * shrink on both axes at the same rate, and pitch is what a model's localization error scales with.
 *
 * Two plausible alternatives were implemented and MEASURED, and both fail the same way:
 *   - "halve the axis whose child lands nearest the frame's aspect ratio": on 16:9, halving the wide side
 *     gives a 1:1 child and halving the tall side gives 0.89; 1:1 is nearer 1.78, so the rule halves the
 *     same axis forever -- at depth 6 it produced 64 strips of 60x2160.
 *   - "halve toward the squarest child": same fixed point, same failure.
 *
 * And what tile shape can and cannot be: every rectangular partition of a 16:9 rectangle yields 16:9
 * tiles. "Square tiles" is unreachable by any strategy -- only the per-axis pitch is a choice.
 */
const bestAxisHalf = (p) => (p.w >= p.h ? (p.w >= 2 ? 'x' : null) : (p.h >= 2 ? 'y' : null))

/**
 * Target-aware search for a partition into exactly `wanted` pieces using cuts that avoid every span.
 * Depth-first with a node budget; returns the lowest-imbalance partition found, or null.
 */
function search(leaves, wanted, spansX, spansY, budget) {
  if (leaves.length >= wanted) return { leaves, cost: 0 }
  if (budget.n <= 0) return null
  budget.n--

  let best = null
  // Largest area first: that ordering is what keeps the result a clean power-of-two grid instead of a
  // ragged layout (prioritising shape produced 7x6 layouts where raising the depth added no columns).
  let idx = 0
  for (let k = 1; k < leaves.length; k++) {
    const a1 = leaves[k].w * leaves[k].h, a0 = leaves[idx].w * leaves[idx].h
    if (a1 > a0 || (a1 === a0 && Math.max(leaves[k].w, leaves[k].h) > Math.max(leaves[idx].w, leaves[idx].h))) idx = k
  }
  const p = leaves[idx]
  const axis = bestAxisHalf(p)
  if (!axis) return null
  const lo = axis === 'x' ? p.x : p.y
  const hi = lo + (axis === 'x' ? p.w : p.h)
  const cands = validCuts(lo, hi, axis === 'x' ? spansX : spansY)

  for (const c of cands) {
    const [a, b] = splitAt(p, c, axis)
    if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) continue
    const next = []
    for (let k = 0; k < leaves.length; k++) { if (k === idx) next.push(a, b); else next.push(leaves[k]) }
    const sub = search(next, wanted, spansX, spansY, budget)
    if (!sub) continue
    const div = Math.abs(a.w * a.h - b.w * b.h) / (a.w * a.h + b.w * b.h)
    const cost = sub.cost + div
    if (!best || cost < best.cost) best = { leaves: sub.leaves, cost }
  }
  return best
}

/** Which targets would be split by any of these cuts (global coordinates). */
function straddlersOf(cuts, targets) {
  return targets.filter(t => cuts.some(c => (c.axis === 'x' ? c.at > t.x && c.at < t.x + t.w
    : c.at > t.y && c.at < t.y + t.h)))
    .map(t => t.label ?? `${t.x},${t.y},${t.w},${t.h}`)
}

/** Every declared target must be whole inside at least one tile; returns the ones that are not. */
function unprotectedOf(tiles, targets) {
  return targets.filter(tg => !tiles.some(t =>
    tg.x >= t.x && tg.x + tg.w <= t.x + t.w && tg.y >= t.y && tg.y + tg.h <= t.y + t.h))
    .map(tg => tg.label ?? `${tg.x},${tg.y},${tg.w},${tg.h}`)
}

/** Tile bounds as x/y cut lists, for reporting. */
const cutsOfTiles = (tiles) => [
  ...[...new Set(tiles.map(t => t.x))].filter(x => x > 0).sort((a, b) => a - b).map(x => ({ axis: 'x', at: x })),
  ...[...new Set(tiles.map(t => t.y))].filter(y => y > 0).sort((a, b) => a - b).map(y => ({ axis: 'y', at: y })),
]

const sortTiles = (tiles) => tiles.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))

/**
 * Validate caller-supplied rectangles. Returns { ok, problems, straddling, unprotected }.
 *
 * This does NOT adjust anything: `manual` exists because a caller may know a layout the planner cannot
 * infer, so the planner's job is to say what is wrong, not to overrule it.
 */
export function validateTiles(tiles, viewport, targets = []) {
  const W = Math.floor(viewport.width), H = Math.floor(viewport.height)
  const problems = []
  if (!Array.isArray(tiles) || !tiles.length) return { ok: false, problems: ['no tiles supplied'], straddling: [], unprotected: [] }

  for (const [i, t] of tiles.entries()) {
    if (![t.x, t.y, t.w, t.h].every(v => Number.isFinite(v))) { problems.push(`tile ${i} has non-numeric bounds`); continue }
    if (t.w <= 0 || t.h <= 0) problems.push(`tile ${i} is degenerate (${t.w}x${t.h})`)
    if (t.x < 0 || t.y < 0 || t.x + t.w > W || t.y + t.h > H) problems.push(`tile ${i} leaves the viewport`)
  }
  // Overlap: any two tiles sharing area (touching edges is fine).
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i], b = tiles[j]
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > 0 && oy > 0) problems.push(`tiles ${i} and ${j} overlap by ${ox}x${oy}px`)
    }
  }
  // Total area must equal the viewport (contiguous, gapless). Overlap already reported separately.
  const area = tiles.reduce((s, t) => s + t.w * t.h, 0)
  if (area !== W * H) problems.push(`tiles cover ${area}px but the viewport is ${W * H}px (${area < W * H ? 'gap' : 'overlap'})`)

  return { ok: problems.length === 0, problems, straddling: straddlersOf(cutsOfTiles(tiles), targets), unprotected: unprotectedOf(tiles, targets) }
}

/**
 * Plan the tile grid.
 * @param {{width:number,height:number}} viewport
 * @param {number} depth  alias for rows/cols when no targets are declared; 2^depth tiles
 * @param {Array<{x:number,y:number,w:number,h:number,label?:string}>} targets objects that must stay whole
 * @param {{rows?:number,cols?:number,tiles?:Array}} [opts] explicit rows/cols, or caller-supplied tiles
 * @returns {{tiles:Array, report:object}} report.mode is 'simple' | 'aware' | 'manual'
 */
export function planGrid(viewport, depth, targets = [], opts = {}) {
  const W = Math.max(1, Math.floor(viewport.width))
  const H = Math.max(1, Math.floor(viewport.height))

  // ---- mode 3: caller-supplied rectangles (validated, never rewritten) ----
  if (opts.tiles) {
    const v = validateTiles(opts.tiles, { width: W, height: H }, targets)
    const tiles = sortTiles(opts.tiles)
    return {
      tiles,
      report: {
        mode: 'manual', tiles: tiles.length, ok: v.ok, problems: v.problems,
        straddling: v.straddling, unprotected: v.unprotected,
        infeasible: false,
        cuts: cutsOfTiles(tiles),
      },
    }
  }

  // ---- fan-out: explicit rows x cols, else square-ish from depth ----
  let rows, cols
  const cap = Number.isFinite(opts.maxTiles) && opts.maxTiles > 0 ? Math.floor(opts.maxTiles) : null
  let cappedFrom = null
  if (Number.isFinite(opts.rows) || Number.isFinite(opts.cols)) {
    rows = Math.max(1, Math.floor(opts.rows ?? 1))
    cols = Math.max(1, Math.floor(opts.cols ?? 1))
  } else {
    let d = Math.max(0, Math.floor(Number(depth) || 0))
    if (d > 12) throw new Error(`planGrid: depth ${d} would produce ${2 ** d} tiles; refusing rather than exhausting memory`)
    // NEVER refuse a request just because it asked for more than the cap allows: a refusal costs the
    // caller another STEP, and in an agent loop a step resends the whole context (the quadratic term).
    // Deliver the deepest split that fits and say the depth was capped. This is the "rather see more
    // than miss" rule applied to the caller's budget.
    if (cap !== null && 2 ** d > cap) {
      const fit = Math.max(0, Math.floor(Math.log2(cap)))
      cappedFrom = d
      d = fit
    }
    // Split the halves across the two axes so tiles stay as close to the frame's own shape as integers
    // allow: on 16:9 that is 1x1, 2x1, 2x2, 4x2, 4x4 ... the same ladder the L2..L5 materials used.
    const half = Math.floor(d / 2)
    cols = 2 ** (half + (d % 2))
    rows = 2 ** half
  }
  if (rows * cols > 4096) throw new Error(`planGrid: ${rows}x${cols} tiles is beyond the cap; refusing`)
  if (rows * cols === 1) {
    const tiles = [{ x: 0, y: 0, w: W, h: H }]
    return { tiles, report: { mode: 'simple', rows: 1, cols: 1, tiles: 1, feasible: true, infeasible: false, cappedFrom, straddling: [], unprotected: unprotectedOf(tiles, targets), cuts: [] } }
  }

  const spansX = mergeSpans(targets.map(t => ({ a: t.x, b: t.x + t.w })))
  const spansY = mergeSpans(targets.map(t => ({ a: t.y, b: t.y + t.h })))

  // ---- mode 1: even grid (no targets => nothing to avoid, so nothing to search) ----
  const evenTiles = () => {
    const xs = [0, ...evenCuts(W, cols), W]
    const ys = [0, ...evenCuts(H, rows), H]
    const tiles = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      tiles.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] })
    }
    return sortTiles(tiles)
  }

  if (!targets.length) {
    const tiles = evenTiles()
    return {
      tiles,
      report: {
        mode: 'simple', rows, cols, tiles: tiles.length,
        // The depth actually used, after any cap reduction: callers and tests both need to tell
        // "what I asked for" from "what I got".
        depth: Math.round(Math.log2(rows * cols)), requestedDepth: cappedFrom ?? Math.round(Math.log2(rows * cols)),
        cappedFrom, feasible: true, infeasible: false,
        straddling: [], unprotected: [], cuts: cutsOfTiles(tiles),
      },
    }
  }

  // ---- mode 2: target-aware; reduce the depth if the request admits no partition ----
  const wantDepth = Math.round(Math.log2(rows * cols))
  let found = null, usedDepth = wantDepth
  for (let dep = wantDepth; dep >= 0; dep--) {
    found = search([{ x: 0, y: 0, w: W, h: H }], 2 ** dep, spansX, spansY, { n: 20000 })
    if (found) { usedDepth = dep; break }
  }
  if (found) {
    const tiles = sortTiles(found.leaves)
    const cuts = cutsOfTiles(tiles)
    const straddling = straddlersOf(cuts, targets)
    const unprotected = unprotectedOf(tiles, targets)
    // A partition that leaves a target unprotected is not acceptable: fall back to the even grid and
    // report the conflict, rather than delivering a layout that breaks the invariant silently.
    if (!straddling.length && !unprotected.length) {
      return {
        tiles,
        report: {
          mode: 'aware', requestedDepth: wantDepth, depth: usedDepth, tiles: tiles.length,
          reduced: usedDepth !== wantDepth, feasible: usedDepth === wantDepth, infeasible: false,
          straddling, unprotected, cuts, balanceCost: Number(found.cost.toFixed(6)),
        },
      }
    }
  }

  const tiles = evenTiles()
  return {
    tiles,
    report: {
      mode: 'aware', requestedDepth: wantDepth, depth: wantDepth, tiles: tiles.length,
      reduced: false, feasible: false, infeasible: true,
      reason: 'no cut sequence keeps every declared target whole at this depth',
      straddling: straddlersOf(cutsOfTiles(tiles), targets),
      unprotected: unprotectedOf(tiles, targets),
      cuts: cutsOfTiles(tiles),
    },
  }
}
