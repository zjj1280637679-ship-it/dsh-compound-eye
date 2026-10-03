/**
 * Compound-eye partition: split a viewport into tiles the way a compound eye samples a scene.
 *
 * ONE PLANNER, ORTHOGONAL KNOBS. There is no mode to choose; `report.mode` is a label for what the plan
 * turned out to be, never a fork in behaviour.
 *
 *   fan-out        `depth`, or `rows`+`cols`   -- how many pieces. Always exactly what was asked; no
 *                                                 internal rule is ever allowed to change this number.
 *   placement      `seamProfile`, or `targets`  -- where the cuts fall. With no declared targets the
 *                                                 default is to put them where the picture is empty
 *                                                 (`seamProfile` comes from lib/placement.js); with
 *                                                 targets declared, the targets decide.
 *   extra regions  caller rectangles            -- ADDED to whatever the fan-out produced, never
 *                                                 rewritten, never required to tile the frame.
 *   coverage       derived                      -- measured and reported, never enforced.
 *
 * WHY THE PLACEMENT DEFAULT LOOKS AT PIXELS: the caller always says HOW MANY pieces -- making them also
 * guess WHERE asks them to decide about pixels they have not measured. Measured on the materials in this
 * repository (3840x2160, 36 labels, boxes 58x24): an even ladder slices through 4 of 36 labels at depth 4;
 * snapping the seams to the emptiest nearby band slices through 0 of 36 at depths 3, 4, 5 and 6.
 * `placement: "even"` keeps the historical exact ladder for reproducibility.
 *
 * WHY TARGETS ARE HONOURED WHERE POSSIBLE: a target split by a cut is whole in NO delivered image, and a
 * model cannot combine two images. Measured in this workspace: such a label was read in 1 of 11 runs across
 * two models and every delivery scale tested, and upscaling never helped -- the other half was never in the
 * same image. When the requested fineness makes that impossible, the target is NAMED rather than the
 * fan-out being quietly reduced.
 */
import { smoothProfile } from './placement.js'

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
function validCuts(lo, hi, spans) {
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
function evenCuts(total, n) {
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
  let axis = bestAxisHalf(p)
  if (!axis) return null
  let lo = axis === 'x' ? p.x : p.y
  let hi = lo + (axis === 'x' ? p.w : p.h)
  let cands = validCuts(lo, hi, axis === 'x' ? spansX : spansY)
  // A full-width banner can block the preferred x cut while leaving a clean y cut.
  // Depth requests specify a tile count; explicit rows/cols keep their existing axis choice.
  const other = axis === 'x' ? 'y' : 'x'
  if (!cands.length && budget.allowAxisFallback !== false && (other === 'x' ? p.w : p.h) >= 2) {
    axis = other
    lo = axis === 'x' ? p.x : p.y
    hi = lo + (axis === 'x' ? p.w : p.h)
    cands = validCuts(lo, hi, axis === 'x' ? spansX : spansY)
  }

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

const targetLabel = t => t.label ?? `${t.x},${t.y},${t.w},${t.h}`
const containsTarget = (tile, target) => target.x >= tile.x && target.x + target.w <= tile.x + tile.w
  && target.y >= tile.y && target.y + target.h <= tile.y + tile.h

/** Which unprotected targets are crossed by an actual tile edge, not an infinite cut line. */
function straddlersOf(tiles, targets) {
  return targets.filter(t => !tiles.some(tile => containsTarget(tile, t)) && tiles.some(tile => {
    const overlapsY = tile.y < t.y + t.h && tile.y + tile.h > t.y
    const overlapsX = tile.x < t.x + t.w && tile.x + tile.w > t.x
    const cutsX = [tile.x, tile.x + tile.w].some(x => x > t.x && x < t.x + t.w)
    const cutsY = [tile.y, tile.y + tile.h].some(y => y > t.y && y < t.y + t.h)
    return (overlapsY && cutsX) || (overlapsX && cutsY)
  })).map(targetLabel)
}

/** Every declared target must be whole inside at least one tile; returns the ones that are not. */
function unprotectedOf(tiles, targets) {
  return targets.filter(target => !tiles.some(tile => containsTarget(tile, target))).map(targetLabel)
}

/** Only the intersection with the source viewport can actually be delivered. */
function effectiveTiles(tiles, W, H) {
  return tiles.filter(t => [t.x, t.y, t.w, t.h].every(Number.isFinite) && t.w > 0 && t.h > 0)
    .map(t => {
      const x = Math.max(0, t.x), y = Math.max(0, t.y)
      return { x, y, w: Math.min(W, t.x + t.w) - x, h: Math.min(H, t.y + t.h) - y }
    }).filter(t => t.w > 0 && t.h > 0)
}

/** Tile bounds as x/y cut lists, for reporting. */
const cutsOfTiles = (tiles) => [
  ...[...new Set(tiles.map(t => t.x))].filter(x => x > 0).sort((a, b) => a - b).map(x => ({ axis: 'x', at: x })),
  ...[...new Set(tiles.map(t => t.y))].filter(y => y > 0).sort((a, b) => a - b).map(y => ({ axis: 'y', at: y })),
]

/** A target-aware partition need not have the nominal ladder's rows and columns. */
function partitionShape(tiles) {
  const xs = new Set(tiles.map(t => `${t.x},${t.w}`))
  const ys = new Set(tiles.map(t => `${t.y},${t.h}`))
  const pairs = new Set(tiles.map(t => `${t.x},${t.w}|${t.y},${t.h}`))
  if (xs.size * ys.size === tiles.length && pairs.size === tiles.length) {
    return { shape: 'cartesian', rows: ys.size, cols: xs.size }
  }
  return { shape: 'partition', rows: null, cols: null }
}

/**
 * Every cut is an INTEGER in source coordinates, so a cut is not just a boundary -- it is an annotation:
 * a number that can be written down, compared against a label's coordinates, diffed between two runs, and
 * checked by a machine. A fractional cut would be none of those things.
 *
 * Caller rectangles and targets are rounded to integers for that reason, and the rounding is reported
 * (`report.adjusted`) rather than done quietly: a crop of `{x: 10.4, w: 99.7}` is silently a different
 * crop from what was asked, and the caller is entitled to know which region it actually got.
 */
const intRect = r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })
function toIntegerRects(list, kind) {
  const adjusted = []
  const out = list.map((r, i) => {
    if (![r.x, r.y, r.w, r.h].every(v => Number.isFinite(v))) return r
    const n = intRect(r)
    if (n.x !== r.x || n.y !== r.y || n.w !== r.w || n.h !== r.h) {
      adjusted.push({ kind, index: i, from: { x: r.x, y: r.y, w: r.w, h: r.h }, to: n })
    }
    return { ...r, ...n }
  })
  return { out, adjusted }
}

const sortTiles = (tiles) => tiles.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))

/**
 * Cut positions snapped away from ink: start from the even ladder, then move each cut to the cheapest
 * nearby position. The window is a fraction of one tile, so tiles stay close to even -- the point is to
 * dodge content, not to build a ragged layout.
 *
 * Measured on the repository materials: this takes the number of labels whose box a seam passes through
 * from 4/36 to 0/36 at depth 4, and to 0/36 at every depth from 3 to 6 (see lib/placement.js).
 */
function snapCuts(total, n, profile, { radius = 30, windowFrac = 0.25, minTile = 32 } = {}) {
  if (!profile || n < 2) return evenCuts(total, n)
  const smoothed = smoothProfile(profile, radius)
  const span = total / n
  const win = Math.max(1, Math.round(span * windowFrac))
  const out = []
  for (let i = 1; i < n; i++) {
    const base = Math.round(total * i / n)
    const floor = (out.length ? out[out.length - 1] : 0) + minTile
    const lo = Math.max(1, base - win, floor)
    const hi = Math.min(total - 1 - (n - i) * minTile, base + win)
    if (hi < lo) { out.push(base); continue }
    let best = base, bestCost = Infinity
    for (let p = lo; p <= hi; p++) {
      // Ink at the seam, plus a small pull toward the even position so ties do not drift to the edge of
      // the window and leave visibly lopsided tiles.
      const cost = smoothed[p] + Math.abs(p - base) * 0.0005
      if (cost < bestCost) { bestCost = cost; best = p }
    }
    out.push(best)
  }
  return out
}

/** Total ink the given cut positions would pass through -- for reporting the gain over an even ladder. */
function seamInk(cuts, profile, radius = 30) {
  if (!profile || !cuts.length) return 0
  const smoothed = smoothProfile(profile, radius)
  return cuts.reduce((s, c) => s + smoothed[Math.min(smoothed.length - 1, Math.max(0, c))], 0)
}

/**
 * Grow every tile by `fraction` of its own size (half on each side), so neighbours overlap.
 *
 * This is the second way to keep content whole, and it is a different trade from placing the seams well:
 *   - placement needs a clean line to exist somewhere near the even position; when the frame is dense
 *     there is none, and some glyph will sit on a seam whatever you do.
 *   - overlap does not need a clean line at all: anything near a seam is whole in at least one neighbour,
 *     at the cost of delivering more pixels (and, if a grown tile passes the delivery ceiling, of having
 *     that tile downscaled -- a real cost the result reports).
 * Neither dominates, so both are parameters and they compose: `overlap` applies to whatever layout the
 * placement produced, and to caller rectangles too.
 */
function padTiles(tiles, fraction, W, H) {
  if (!(fraction > 0)) return tiles
  return tiles.map(t => {
    const px = Math.round(t.w * fraction / 2), py = Math.round(t.h * fraction / 2)
    const x = Math.max(0, t.x - px), y = Math.max(0, t.y - py)
    const x2 = Math.min(W, t.x + t.w + px), y2 = Math.min(H, t.y + t.h + py)
    return { x, y, w: x2 - x, h: y2 - y }
  })
}

/** Cut positions a layout implies: every interior x and y boundary, as integers. */
function cutLines(tiles, W, H) {
  const cx = [...new Set(tiles.map(t => t.x))].filter(x => x > 0 && x < W).sort((a, b) => a - b)
  const cy = [...new Set(tiles.map(t => t.y))].filter(y => y > 0 && y < H).sort((a, b) => a - b)
  return { cx, cy }
}

/** Total seam contrast a layout's cuts would pass through. Lower is better; it is a tie-breaker, not a rule. */
function layoutInk(tiles, W, H, profile) {
  if (!profile) return 0
  const { cx, cy } = cutLines(tiles, W, H)
  return seamInk(cx, profile.col) + seamInk(cy, profile.row)
}

/**
 * Raster coverage analysis: how much of the viewport the rectangles actually cover, which parts they
 * miss, and how much they cover twice.
 *
 * Deliberately approximate and deliberately conservative about holes: a cell counts as covered only
 * when its centre lies inside a tile. Reporting a gap slightly too small is a rounding artefact;
 * silently treating a hole as covered would be a lie about what the caller did not see.
 */
function coverageAnalysis(tiles, W, H) {
  const cell = Math.max(1, Math.ceil(Math.max(W, H) / 256))
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell)
  const count = new Uint16Array(cols * rows)
  const centre = i => (i + 0.5) * cell
  const mark = (c, r) => { if (c >= 0 && c < cols && r >= 0 && r < rows) count[r * cols + c]++ }
  for (const t of tiles) {
    const c0 = Math.max(0, Math.floor(t.x / cell)), c1 = Math.min(cols - 1, Math.ceil((t.x + t.w) / cell) - 1)
    const r0 = Math.max(0, Math.floor(t.y / cell)), r1 = Math.min(rows - 1, Math.ceil((t.y + t.h) / cell) - 1)
    let marked = 0
    for (let r = r0; r <= r1; r++) {
      const y = centre(r)
      // Half-open containment. With `<=` on both ends, a cell centre landing exactly on a shared edge was
      // counted in BOTH neighbours, so a perfectly exact 4x4 grid reported a phantom 0.7% overlap and the
      // result text told the caller its tiles overlapped. They did not.
      if (y < t.y || y >= t.y + t.h) continue
      for (let c = c0; c <= c1; c++) {
        const x = centre(c)
        if (x < t.x || x >= t.x + t.w) continue
        count[r * cols + c]++
        marked++
      }
    }
    // A rectangle thinner than one cell can contain no centre at all. It was still delivered, so counting
    // it as nothing would invent a hole -- the one error this report must not make. Count the cell its own
    // midpoint falls in instead; the depth of the under-count is bounded by the stated ±cell precision.
    if (!marked) mark(Math.floor((t.x + t.w / 2) / cell), Math.floor((t.y + t.h / 2) / cell))
  }
  let coveredCells = 0, twiceCells = 0
  for (let i = 0; i < count.length; i++) { if (count[i] > 0) coveredCells++; if (count[i] > 1) twiceCells++ }
  const cellPx = cell * cell
  const coveredPx = Math.min(W * H, coveredCells * cellPx)
  const gapPx = Math.max(0, W * H - coveredPx)
  return {
    cell, cols, rows, approx: `±${cell}px`,
    coveredPx, fraction: coveredPx / (W * H), gapPx,
    gapRects: gapRectsOf(count, cols, rows, cell, W, H),
    overlapPx: twiceCells * cellPx,
    mode: gapPx > 0 ? 'partial' : (twiceCells > 0 ? 'complete-overlapping' : 'exact'),
  }
}

/** Maximal uncovered rectangles: take each horizontal run of uncovered cells and extend it downwards. */
function gapRectsOf(count, cols, rows, cell, W, H) {
  const used = new Uint8Array(cols * rows)
  const out = []
  const free = (r, c) => count[r * cols + c] === 0 && used[r * cols + c] === 0
  for (let r = 0; r < rows; r++) {
    let c = 0
    while (c < cols) {
      if (!free(r, c)) { c++; continue }
      let end = c
      while (end + 1 < cols && free(r, end + 1)) end++
      let rEnd = r
      while (rEnd + 1 < rows) {
        let whole = true
        for (let k = c; k <= end; k++) if (!free(rEnd + 1, k)) { whole = false; break }
        if (!whole) break
        rEnd++
      }
      for (let rr = r; rr <= rEnd; rr++) for (let k = c; k <= end; k++) used[rr * cols + k] = 1
      const x = c * cell, y = r * cell
      const w = Math.min(W - x, (end - c + 1) * cell), h = Math.min(H - y, (rEnd - r + 1) * cell)
      if (w > 0 && h > 0) out.push({ x, y, w, h })
      c = end + 1
    }
  }
  out.sort((a, b) => b.w * b.h - a.w * a.h)
  return out
}

/**
 * Validate caller-supplied rectangles.
 *
 * Coverage and overlap are **described, not forbidden**: a caller may legitimately deliver a subset
 * (zoom into three regions and ignore the rest), or deliberately overlap tiles to keep a target whole
 * across a seam. Making that a pass/fail question would force the caller to lie about intent, so this
 * returns a classification instead. Only genuinely impossible input is fatal -- a degenerate rectangle,
 * or one that lies entirely outside the frame. Rectangles that stick out are delivered clipped and listed.
 *
 * This does NOT adjust anything: `manual` exists because a caller may know a layout the planner cannot
 * infer, so the planner's job is to say what the layout is, not to overrule it.
 */
function validateTiles(tiles, viewport, targets = []) {
  const W = Math.floor(viewport.width), H = Math.floor(viewport.height)
  const empty = { ok: false, problems: ['no tiles supplied'], clipped: [], coverage: null, straddling: [], unprotected: [] }
  if (!Array.isArray(tiles) || !tiles.length) return empty

  const problems = []          // fatal: nothing can be delivered for this rectangle
  const clipped = []           // deliverable, but only partly inside the frame
  const usable = []
  for (const [i, t] of tiles.entries()) {
    if (![t.x, t.y, t.w, t.h].every(v => Number.isFinite(v))) { problems.push(`tile ${i} has non-numeric bounds`); continue }
    if (t.w <= 0 || t.h <= 0) { problems.push(`tile ${i} is degenerate (${t.w}x${t.h})`); continue }
    if (t.x + t.w <= 0 || t.y + t.h <= 0 || t.x >= W || t.y >= H) { problems.push(`tile ${i} lies entirely outside the ${W}x${H} viewport`); continue }
    if (t.x < 0 || t.y < 0 || t.x + t.w > W || t.y + t.h > H) clipped.push({ index: i, x: t.x, y: t.y, w: t.w, h: t.h })
    usable.push(...effectiveTiles([t], W, H))
  }

  const coverage = usable.length ? coverageAnalysis(usable, W, H) : null
  return {
    ok: problems.length === 0,
    problems, clipped, coverage,
    straddling: straddlersOf(usable, targets),
    unprotected: unprotectedOf(usable, targets),
  }
}

/**
 * Plan the tile grid.
 * @param {{width:number,height:number}} viewport
 * @param {number} depth  alias for rows/cols when no targets are declared; 2^depth tiles
 * @param {Array<{x:number,y:number,w:number,h:number,label?:string}>} targets objects that must stay whole
 * @param {{rows?:number,cols?:number,tiles?:Array,hardMaxTiles?:number}} [opts]
 * @returns {{tiles:Array, report:object}}
 *
 * The knobs are ORTHOGONAL and compose, which is the whole point:
 *   fan-out        `depth`, or `rows`+`cols`          -- how many pieces, decided by the caller
 *   cut placement  `targets`                          -- where the cuts fall, nothing else
 *   extra regions  `tiles`                            -- caller rectangles, ADDED to whatever the fan-out produced
 *   coverage       derived                            -- measured and reported, never enforced
 *
 * `report.mode` is a descriptive label, not a fork in behaviour. An earlier design had three "modes" where
 * one of them -- target-aware -- carried a self-imposed invariant ("never split a declared target") that
 * could CONTRADICT the fan-out the caller asked for, and resolved the contradiction by reducing the
 * fan-out. That is the tool fighting itself: it invents a rule, then has to break the caller's request to
 * keep it. Now the placement is optimised as far as it goes and the outcome is reported.
 */
export function planGrid(viewport, depth, targets = [], opts = {}) {
  const W = Math.max(1, Math.floor(viewport.width))
  const H = Math.max(1, Math.floor(viewport.height))
  const limit = Number.isFinite(opts.hardMaxTiles) && opts.hardMaxTiles > 0 ? Math.floor(opts.hardMaxTiles) : 10000
  // Integer source coordinates everywhere (see toIntegerRects): cuts are annotations, so they have to be
  // exact numbers. Rounding of caller input is disclosed, not silent.
  const tz = toIntegerRects(targets, 'target')
  const targetsI = tz.out
  const rawExtras = Array.isArray(opts.tiles) && opts.tiles.length ? opts.tiles : null
  const ex = rawExtras ? toIntegerRects(rawExtras, 'rectangle') : { out: null, adjusted: [] }
  const extras = ex.out
  const adjusted = [...tz.adjusted, ...ex.adjusted]
  const fanoutAsked = Number.isFinite(opts.rows) || Number.isFinite(opts.cols) || Number(depth) > 0
  targets = targetsI

  // ---- caller rectangles on their own: described, never required to tile the frame ----
  if (extras && !fanoutAsked) {
    const v = validateTiles(extras, { width: W, height: H }, targets)
    const tiles = sortTiles(extras)
    return {
      tiles,
      report: {
        mode: 'rectangles', tiles: tiles.length, gridTiles: 0, extraTiles: tiles.length,
        targetCount: targets.length, adjusted,
        ok: v.ok, problems: v.problems, clipped: v.clipped, coverage: v.coverage,
        straddling: v.straddling, unprotected: v.unprotected,
        feasible: v.unprotected.length === 0,
        infeasible: v.unprotected.length > 0,
        cuts: cutsOfTiles(tiles),
      },
    }
  }

  // ---- fan-out: explicit rows x cols, else the 2^depth ladder across both axes ----
  // Neither `opts.maxTiles` nor an unavailable cut placement may change this number. The caller named the
  // fineness; the fineness is what gets delivered. Only the physical bound below can stop it, and that
  // bound is the operator's to raise (hardMaxTiles), not a taste about layouts.
  let rows, cols
  const explicitShape = Number.isFinite(opts.rows) || Number.isFinite(opts.cols)
  if (explicitShape) {
    rows = Math.max(1, Math.floor(opts.rows ?? 1))
    cols = Math.max(1, Math.floor(opts.cols ?? 1))
  } else {
    const d = Math.max(0, Math.floor(Number(depth) || 0))
    if (2 ** d > limit) {
      throw new Error(`planGrid: depth ${d} would produce ${2 ** d} tiles, above the deliverable bound of ${limit} `
        + `images in one call (hardMaxTiles -- a resource bound, not a rule about your layout). `
        + `Lower the depth, or use compound_eye_probe to inspect a fan-out without images.`)
    }
    // Split the halves across the two axes so tiles stay as close to the frame's own shape as integers
    // allow: on 16:9 that is 1x1, 2x1, 2x2, 4x2, 4x4 ... the same ladder the L2..L5 materials used.
    const half = Math.floor(d / 2)
    cols = 2 ** (half + (d % 2))
    rows = 2 ** half
  }
  if (rows * cols > limit) {
    throw new Error(`planGrid: ${rows}x${cols} = ${rows * cols} tiles is above the deliverable bound of ${limit} `
      + `images in one call (hardMaxTiles). Use compound_eye_probe to plan without images.`)
  }

  const spansX = mergeSpans(targets.map(t => ({ a: t.x, b: t.x + t.w })))
  const spansY = mergeSpans(targets.map(t => ({ a: t.y, b: t.y + t.h })))
  const profile = opts.seamProfile
  const wantContent = !!profile && opts.placement !== 'even'
  const tilesFrom = (xc, yc) => {
    const xs = [0, ...xc, W], ys = [0, ...yc, H]   // the helpers return INTERIOR cuts only
    const out = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] })
    }
    return sortTiles(out)
  }
  const overlapFrac = Number(opts.overlap) > 0 ? Math.min(0.9, Number(opts.overlap)) : 0
  const notWholeIn = list => unprotectedOf(effectiveTiles([
    ...padTiles(list, overlapFrac, W, H), ...(extras || []),
  ], W, H), targets).length

  // WHERE the cuts fall is a comparison, not a hierarchy. Declared targets and the ink profile are two
  // kinds of evidence for the SAME objective -- do not cut through anything -- so they are scored together
  // instead of one suppressing the other. Ranking: fewest declared targets left not-whole first, then least
  // seam contrast, then the more structured layout. A caller who declares one button must not thereby push
  // the other three seams into blind positions.
  const candidates = []
  candidates.push({ name: 'even', tiles: tilesFrom(evenCuts(W, cols), evenCuts(H, rows)) })
  if (wantContent) candidates.push({ name: 'content', tiles: tilesFrom(snapCuts(W, cols, profile.col), snapCuts(H, rows, profile.row)) })
  if (targets.length && rows * cols > 1) {
    const found = search([{ x: 0, y: 0, w: W, h: H }], rows * cols, spansX, spansY,
      { n: 20000, allowAxisFallback: !explicitShape })
    if (found) candidates.push({ name: 'targets', tiles: sortTiles(found.leaves) })
  }
  const rank = { even: 2, content: 1, targets: 0 }        // ties: prefer the target-aware one, then content
  for (const c of candidates) {
    c.notWhole = notWholeIn(c.tiles)
    c.ink = layoutInk(c.tiles, W, H, profile)
  }
  const chosen = candidates.slice().sort((a, b) => (a.notWhole - b.notWhole) || (a.ink - b.ink) || (rank[a.name] - rank[b.name]))[0]
  const shape = partitionShape(chosen.tiles)
  let gridTiles = chosen.tiles
  let placedWith = chosen.name
  if (overlapFrac > 0) { gridTiles = sortTiles(padTiles(gridTiles, overlapFrac, W, H)); placedWith += '+overlap' }
  const evenInk = layoutInk(candidates[0].tiles, W, H, profile)
  const seamGain = profile ? { even: evenInk, chosen: chosen.ink } : null

  const delivered = extras ? sortTiles([...gridTiles, ...extras]) : gridTiles
  const v = extras
    ? validateTiles(delivered, { width: W, height: H }, targets)
    : { ok: true, problems: [], clipped: [], coverage: coverageAnalysis(delivered, W, H) }
  // Judge the actual source intersections of every delivered region, including overlap and extras.
  // A seam crossing a target is harmless when another delivered image contains that target whole.
  const actualTiles = effectiveTiles(delivered, W, H)
  const straddling = straddlersOf(actualTiles, targets)
  const unprotected = unprotectedOf(actualTiles, targets)
  const notWhole = unprotected.length
  return {
    tiles: delivered,
    report: {
      mode: extras ? 'grid+rectangles' : (targets.length ? 'grid+targets' : 'grid'),
      ...shape, nominalRows: rows, nominalCols: cols,
      depth: Math.round(Math.log2(rows * cols)), requestedDepth: Math.round(Math.log2(rows * cols)),
      tiles: delivered.length, gridTiles: gridTiles.length, extraTiles: extras ? extras.length : 0,
      targetCount: targets.length, adjusted,
      placement: placedWith, seamInk: seamGain, overlap: overlapFrac,
      candidates: candidates.map(c => ({ placement: c.name, notWhole: c.notWhole, seamInk: c.ink })),
      ok: v.ok, problems: v.problems, clipped: v.clipped, coverage: v.coverage,
      feasible: notWhole === 0, infeasible: targets.length > 0 && notWhole > 0,
      reason: notWhole === 0 ? null
        : `the chosen layout at this fan-out (${rows * cols} tiles) does not keep every declared target whole; other placements may work`,
      straddling, unprotected,
      cuts: cutsOfTiles(delivered),
    },
  }
}
