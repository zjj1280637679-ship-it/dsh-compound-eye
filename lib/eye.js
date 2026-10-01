/**
 * The compound-eye tools.
 *
 * WHAT THIS PLUGIN IS: an image processor. The model says how many pieces it wants; the plugin
 * returns the pieces. It does not click, it does not drive the desktop, it does not register a
 * computer-use provider, and it holds no session state between calls.
 *
 * WHAT IT ADDS over a plain crop loop (three things, each with a measured reason):
 *   1. Cuts avoid whole targets -- a target split across two images is unrecoverable by any delivery
 *      scale (measured: 1 read in 11 runs). Cuts are planned against declared target boxes.
 *   2. Tiles are delivered at native scale, never below -- the interface ceiling forces a whole-frame
 *      capture to be resampled (measured: 83.3% of source pixels discarded), while a tile stays 1:1.
 *   3. The source rectangle is carried on the tile's own filename, so the coordinate contract needs no
 *      legend and no assumption about how large the delivered image is.
 */
import { readFileSync } from 'node:fs'
import { decodePng, encodePng, pngSize } from './png.js'
import { resample } from './resample.js'
import { planGrid } from './grid.js'
import { seamProfiles } from './placement.js'

/** Value schema for one delivered tile (declared so the host validates the render input). */
const TILE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    index: { type: 'integer', required: true },
    name: { type: 'string', required: true },
    source: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        x: { type: 'integer', required: true },
        y: { type: 'integer', required: true },
        w: { type: 'integer', required: true },
        h: { type: 'integer', required: true },
      },
    },
    delivered: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        w: { type: 'integer', required: true },
        h: { type: 'integer', required: true },
        scale: { type: 'number', required: true },
      },
    },
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png'], required: true },
    bytes: { type: 'integer', required: true },
  },
}

/** Turn N persisted images into N model-visible image blocks, each preceded by its own caption. */
export function renderTiles(_args, value) {
  const blocks = [{ type: 'text', text: value.result }]
  if (!Array.isArray(value.tiles)) return blocks
  for (const t of value.tiles) {
    blocks.push({ type: 'text', text: t.caption })
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: t.attachmentId,
        mediaType: t.mediaType,
        bytes: t.bytes,
        width: t.delivered.w,
        height: t.delivered.h,
        name: t.name,
      },
    })
  }
  return blocks
}

export function renderText(_args, value) {
  return [{ type: 'text', text: value.result }]
}

const TILE_NAME = (t, row, col) =>
  `tile_r${row + 1}c${col + 1}_x${t.x}_y${t.y}_w${t.w}_h${t.h}.png`

/**
 * Load the source image. Either an absolute path to a PNG, or raw base64 PNG.
 * Returns the decoded image plus a label used in captions.
 */
function loadSource(src, cwd) {
  if (src.base64) {
    const buf = Buffer.from(String(src.base64), 'base64')
    const size = pngSize(buf)
    return { img: decodePng(buf), label: src.name || 'inline.png', size }
  }
  if (!src.path) throw new Error('image.path or image.base64 is required')
  const p = String(src.path)
  const abs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') ? p : `${cwd || process.cwd()}/${p}`
  const buf = readFileSync(abs)
  const size = pngSize(buf)
  return { img: decodePng(buf), label: src.name || p, size }
}

/** Deliver one tile: resample to the delivery size, persist it, return its record. */
async function deliverTile(ctx, cfg, img, tile, row, col, upscale, label, index) {
  const nativeLong = Math.max(tile.w, tile.h)
  const maxEdge = cfg.deliveryMaxEdge

  let scale
  if (upscale === 'max') scale = maxEdge / nativeLong          // fill the ceiling (the F-arm rule)
  else if (typeof upscale === 'number' && upscale > 0) scale = upscale
  else scale = Math.min(1, maxEdge / nativeLong)               // default: native, never enlarge

  // Downscaling below native is forced only by the ceiling; enlargement happens only if asked.
  const forcedDown = nativeLong > maxEdge
  const effScale = forcedDown ? Math.min(scale, maxEdge / nativeLong) : scale

  const dw = Math.max(1, Math.round(tile.w * effScale))
  const dh = Math.max(1, Math.round(tile.h * effScale))
  const out = resample(img, tile.x, tile.y, tile.w, tile.h, dw, dh)
  const png = encodePng(out)
  const name = TILE_NAME(tile, row, col)

  const attachments = ctx?.get?.('attachments')
  if (!attachments) throw new Error('attachments service unavailable; cannot deliver image.')
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name })

  // "native" here means the SOURCE FILE's own pixels, not the pixels the screen once had. If the caller
  // hands us a frame that was already squeezed through the delivery ceiling, the source is already
  // downsampled and no scale below can put that detail back. Naming the two apart matters because the
  // difference is not cosmetic: measured on 3840x2160 with 36 labels, cutting the native frame 1:1 read
  // 97.2%, while cutting a 0.408x frame read 44.4% and enlarging those same tiles read 30.6%.
  const scaleFromSource = effScale
  const enlarged = effScale > 1
  const caption = `[${name}] source x=${tile.x} y=${tile.y} w=${tile.w} h=${tile.h}`
    + ` | delivered ${dw}x${dh}`
    + (enlarged
      ? ` (${scaleFromSource.toFixed(3)}x ENLARGED from ${tile.w}x${tile.h} source px; interpolation adds no detail)`
      : scaleFromSource === 1
        ? ' (source px 1:1)'
        : ` (${scaleFromSource.toFixed(3)}x of source px, forced by the ${maxEdge}px delivery ceiling)`)
    + ` | coordinates inside THIS image: u,v in [0,1], global = (x + u*w, y + v*h)`

  return {
    index,
    name,
    source: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    delivered: { w: dw, h: dh, scale: Number(scaleFromSource.toFixed(6)) },
    enlarged,
    attachmentId: ref.image.attachmentId,
    mediaType: 'image/png',
    bytes: png.length,
    caption,
  }
}

const fmtPx = n => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mpx' : n >= 1e3 ? Math.round(n / 1e3) + ' kpx' : Math.round(n) + ' px'
const fmtNum = n => n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n))

/**
 * Describe the layout instead of judging it.
 *
 * Coverage is not a pass/fail question. "Deliver all 16 quadrants", "grid plus three zoom regions" and
 * "zoom into the three regions I care about" are all legitimate, and a deliberate overlap is how you keep
 * a target whole across a seam. So the text says WHICH ONE the caller built, and when part of the frame is
 * missed it names the holes -- a layout that silently omits a region is the only real failure mode here.
 */
function coverageSummary(cov, clipped) {
  const lines = []
  if (cov) {
    const pct = (cov.fraction * 100).toFixed(1)
    if (cov.mode === 'exact') {
      lines.push('LAYOUT: the delivered rectangles tile the whole frame exactly (100% coverage, no overlap).')
    } else if (cov.mode === 'complete-overlapping') {
      lines.push(`LAYOUT: the delivered rectangles cover the whole frame, and overlap by ${fmtPx(cov.overlapPx)} `
        + `(${(cov.overlapPx / cov.coveredPx * 100).toFixed(1)}% of the frame is delivered twice) -- overlap is how a `
        + `target gets kept whole across a seam, so nothing is wrong here.`)
    } else {
      const gaps = cov.gapRects.slice(0, 6).map(r => `x=${r.x} y=${r.y} w=${r.w} h=${r.h}`).join('  ')
      const more = cov.gapRects.length > 6 ? `  ...and ${cov.gapRects.length - 6} more` : ''
      lines.push(`LAYOUT is a PARTIAL delivery: ${pct}% of the frame is delivered and ${fmtPx(cov.gapPx)} `
        + `(${(100 - pct).toFixed(1)}%) is NOT delivered at all -- you will see nothing in those regions. `
        + `Gaps, largest first (${cov.approx}): ${gaps}${more}. Add rectangles for any that matter; a deliberate `
        + `subset is a legitimate layout, so this is reported rather than refused.`)
    }
  }
  if (clipped && clipped.length) {
    lines.push(`NOTE: rectangle(s) ${clipped.map(c => c.index).join(', ')} stick out of the frame; they were delivered clipped to it.`)
  }
  return lines
}

/**
 * Describe the plan as orthogonal facts: what fan-out ran, where the cuts came from, and what happened to
 * the declared targets.
 *
 * This replaces a design in which the planner carried a self-imposed invariant -- "never split a declared
 * target" -- that could CONTRADICT the fan-out the caller asked for. It resolved that contradiction by
 * lowering the fan-out, which is the tool fighting itself: invent a rule, then break the caller's request
 * to honour it. Now the fan-out is the caller's, the placement is optimised as far as it goes, and a
 * target that could not be kept whole is named along with the three ways out.
 */
function planSummary(report) {
  const lines = []
  const parts = []
  if (report.rows) parts.push(`grid ${report.cols}x${report.rows} (depth ${report.depth})`)
  if (report.extraTiles) parts.push(`+ ${report.extraTiles} caller rectangle(s)`)
  if (report.placement === 'content' || report.placement?.startsWith('content')) {
    const g = report.seamInk
    const gained = g && g.chosen < g.even * 0.95
    parts.push(`cuts placed where the picture is empty${gained ? ` (seam contrast ${fmtNum(g.even)} -> ${fmtNum(g.chosen)})` : ''}`)
  } else if (report.placement?.startsWith('targets')) parts.push('cuts placed to keep the declared targets whole')
  else if (report.placement?.startsWith('even')) parts.push('even cuts')
  if (report.overlap > 0) {
    parts.push(`every tile grown by ${(report.overlap * 100).toFixed(0)}% so neighbours overlap`
      + ` (anything on a seam is whole in at least one neighbour; the cost is more delivered pixels)`)
  }
  if (parts.length) lines.push(`PLAN: ${parts.join('; ')}.`)
  if (report.candidates && report.candidates.length > 1) {
    lines.push(`PLACEMENT CONSIDERED: ${report.candidates.map(c => `${c.placement} (${c.notWhole} target(s) not whole, seam contrast ${fmtNum(c.seamInk)})`).join(' vs ')} `
      + `-> ${report.placement}. Declared targets and picture content are scored together rather than one suppressing the other.`)
  }

  // The cuts themselves, as data. A cut is an integer in SOURCE coordinates, which makes it an annotation:
  // it can be written down, compared with a label position, diffed between runs, and checked by a machine.
  if (report.cuts && report.cuts.length) {
    const cx = report.cuts.filter(c => c.axis === 'x').map(c => c.at)
    const cy = report.cuts.filter(c => c.axis === 'y').map(c => c.at)
    lines.push(`CUTS (integer source coordinates): ${[cx.length ? `x=${cx.join(',')}` : '', cy.length ? `y=${cy.join(',')}` : ''].filter(Boolean).join('  ')}. `
      + `Why they are stated: anything crossing one of these lines ends up in two images, and a model cannot join two images.`)
  }
  if (report.adjusted && report.adjusted.length) {
    const shown = report.adjusted.slice(0, 4).map(a => `${a.kind} ${a.index}: ${JSON.stringify(a.from)} -> ${JSON.stringify(a.to)}`)
    lines.push(`NOTE: ${report.adjusted.length} of your coordinates were fractional and were rounded to whole pixels `
      + `(${shown.join('; ')}${report.adjusted.length > 4 ? `; ...and ${report.adjusted.length - 4} more` : ''}). `
      + `Cuts are integer source coordinates so they can be used as annotations; this is stated rather than done quietly.`)
  }
  if (report.targetCount) {
    if (report.infeasible) {
      const split = (report.straddling || []).join(', ')
      const unprot = (report.unprotected || []).join(', ')
      lines.push(`TARGETS: at this fan-out no cut placement keeps every declared target whole, so these are cut: `
        + `${split || '(none named)'}${unprot ? `; not whole inside any single tile: ${unprot}` : ''}. `
        + `The fan-out is the one you asked for -- reported, not corrected. Lower the depth, add your own `
        + `rectangles via \`tiles\`, or accept the split.`)
    } else {
      lines.push(`TARGETS: all ${report.targetCount} declared target(s) are whole inside one tile.`)
    }
  }
  return lines
}

export function makeCompoundEyeTool({ Config, cwd }) {  return {
    name: 'compound_eye',
    description:
      'Split one image into tiles the way a compound eye samples a scene: many small high-resolution '
      + 'facets instead of one downscaled frame. Use it when a model must READ small text or resolve '
      + 'small icons from a large screenshot.\n'
      + 'WHY it helps: a whole-frame capture is forced through the delivery ceiling (the host resamples '
      + 'it to a maximum long edge), which discards most source pixels; a tile cropped from the source '
      + 'stays at native resolution. Measured on 3840x2160 with 36 small labels: whole frame 2.8% read, '
      + '16 tiles 86.1%, same model and same prompt.\n'
      + 'ORDER MATTERS MORE THAN SCALE: cut from the NATIVE source and only then resample. Same 36 labels: '
      + 'cutting the native frame 1:1 read 97.2%; cutting a frame already squeezed to the delivery ceiling '
      + 'read 44.4%; enlarging those squeezed tiles back to the ceiling read 30.6%. The enlarged arm held '
      + '2.67x MORE pixels than the native arm and lost two thirds of the reads. So never hand this tool a '
      + 'pre-downscaled copy of the frame, and do not expect `upscale` to undo a downscale.\n'
      + 'WHAT IS DIFFERENT FROM A PLAIN CROP LOOP: cuts are PLANNED to avoid targets you declare in '
      + '`targets`. A target split across two tiles is never present whole in any delivered image, and '
      + 'no amount of upscaling recovers it (measured: 1 read in 11 runs). When the region leaves no '
      + 'room, the tool says so in `report.infeasible` instead of silently cutting through.\n'
      + 'OUTPUT: one image per tile, plus its source rectangle BOTH in the result and in the image '
      + 'filename. Report coordinates as normalized (u,v) inside the single image you looked at; the '
      + 'caller maps back with global = (x + u*w, y + v*h). Do not guess the delivered pixel size -- '
      + 'normalization is size-independent, which is why the contract survives resizing.\n'
      + 'It only processes images: it does not click and it does not capture the screen.',
    parameters: {
      image: {
        type: 'object',
        description: 'The source image. Either {"path": "C:\\\\...\\\\shot.png"} or {"base64": "...", "name": "shot.png"}. PNG only. '
          + 'Pass the ORIGINAL capture, never a resized copy: this tool cuts first and resamples second, so it can '
          + 'only preserve the detail the file still has. If the file was already downscaled, its detail is gone '
          + 'before the tool is called and no upscale brings it back.',
      },
      depth: {
        type: 'integer',
        description: 'How many times to split; the fan-out is 2^depth tiles and the halves are spread across '
          + 'both axes so tiles keep the frame\'s own shape (16:9 -> depth 2 = 2x2, 4 = 4x4, 6 = 8x8). '
          + 'The long axis is halved first, which is what keeps the per-axis pitch -- and therefore '
          + 'localization precision -- balanced. This is the model\'s knob; the plugin never picks it.',
      },
      rows: {
        type: 'integer',
        description: 'Optional explicit row count. Use with cols instead of depth when you want a specific '
          + 'grid (e.g. rows=4 cols=4). Overrides depth.',
      },
      cols: {
        type: 'integer',
        description: 'Optional explicit column count. Use with rows.',
      },
      tiles: {
        type: 'array',
        description: 'Optional extra rectangles, ADDED to whatever the fan-out produced -- so `depth=4` plus one '
          + 'rectangle means "the 4x4 grid, and also this region", in one call. On its own (no depth/rows/cols) '
          + 'the list IS the layout. Rectangles are never rewritten and are not required to tile the frame: a '
          + 'PARTIAL layout (only the regions you care about) and a deliberately OVERLAPPING layout (to keep a '
          + 'target whole across a seam) are both accepted, and the result says which one you built, naming the '
          + 'uncovered gaps when there are any. Use it for a layout the planner cannot infer, or to zoom '
          + 'somewhere the grid does not resolve.',
      },
      targets: {
        type: 'array',
        description: 'Optional: objects that must remain WHOLE inside a single tile, in source pixels, e.g. '
          + '[{"x":960,"y":540,"w":80,"h":24,"label":"save button"}]. This controls WHERE the cuts fall and '
          + 'nothing else -- it never changes how many tiles you get. If the fan-out you asked for cannot keep '
          + 'one of them whole, that target is named in report.straddling and in the result text; the planner '
          + 'does not lower your fan-out to protect it. Supply these whenever you know them.',
      },
      placement: {
        type: 'string',
        description: 'Where the cuts fall. "content" (default) looks at the pixels and puts each seam in the '
          + 'emptiest band near its even position, so a cut is unlikely to pass through a glyph. Measured on '
          + 'this repository\'s materials (3840x2160, 36 labels, boxes 58x24): an even ladder slices through '
          + '4 of 36 labels at depth 4, the content-aware default slices through 0 of 36 at depths 3-6. '
          + '"even" keeps the exact historical ladder, which is what the L2..L5 experiment materials used -- '
          + 'use it when you need byte-for-byte reproducible geometry. Declared `targets` are NOT suppressed '
          + 'by either: targets and content are scored together as two kinds of evidence for the same thing.',
      },
      overlap: {
        type: 'number',
        description: 'Grow every tile by this fraction of its own size so neighbours overlap (0.15 = 15%, '
          + 'half on each side). This is the second way to keep content whole, and it is not an alternative '
          + 'to `placement` -- it applies to whatever layout came out, grid or caller rectangles. Placement '
          + 'needs a clean line to exist near the even position; overlap does not need one at all: anything '
          + 'near a seam ends up whole in at least one neighbour. The cost is more delivered pixels, and if a '
          + 'grown tile passes the delivery ceiling that tile is downscaled -- the result says which tiles '
          + 'were and by how much.',
      },
      upscale: {
        type: 'string',
        description: 'Optional delivery scale: "native" (default) delivers tiles at their own resolution and '
          + 'never enlarges; a number (e.g. "2") enlarges by that factor with bilinear interpolation; "max" '
          + 'enlarges every tile to fill the delivery ceiling. Enlarging cannot create detail that the source '
          + 'lacks -- it changes how much of the captured signal survives the model\'s own encoding, which is '
          + 'a measurable effect but a model-specific one, and it does not always point the same way: on 36 '
          + 'labels, enlarging tiles cut from an already-downscaled frame measured 30.6% read against 44.4% '
          + 'for the same tiles delivered un-enlarged. Treat enlargement as topping up a delivery that '
          + 'undershoots the ceiling, never as a substitute for capturing at native resolution.',
      },
      maxTiles: {
        type: 'integer',
        description: 'Optional ADVISORY threshold on the number of delivered images (default from config). '
          + 'Exceeding it does not trim or refuse anything: the plugin delivers exactly what you asked for '
          + 'and then reports the size and its cost, because the size of the request is yours to decide. '
          + 'Set it to make that note appear earlier.',
      },
    },
  }
}

export function makeProbeTool() {
  return {
    name: 'compound_eye_probe',
    description:
      'Plan a compound-eye split and report the topology WITHOUT delivering any image: tile rectangles, '
      + 'delivery sizes, and whether any declared target would straddle a cut. Zero image cost, so use it '
      + 'first when you are unsure how deep to split, or when you need to confirm that every target stays '
      + 'whole before spending a call that returns pictures. It is read-only: it persists nothing.',
    parameters: {
      image: {
        type: 'object',
        description: 'The source image: {"path": ...} or {"base64": ..., "name": ...}. Only the header is needed, but a full PNG is accepted.',
      },
      depth: { type: 'integer', description: 'Same meaning as in compound_eye.' },
      targets: { type: 'array', description: 'Same meaning as in compound_eye. This is what the probe checks.' },
      upscale: { type: 'string', description: 'Same meaning as in compound_eye; affects the reported delivery sizes only.' },
    },
  }
}

/** Shared body: plan, optionally deliver. */
export function createExecutor({ ctx, cfg }) {
  const resolveCfg = () => ({
    deliveryMaxEdge: Number(cfg?.deliveryMaxEdge) > 0 ? Number(cfg.deliveryMaxEdge) : 1568,
    maxTiles: Number(cfg?.maxTiles) > 0 ? Number(cfg.maxTiles) : 64,
    // The physical bound. It has to be listed here explicitly -- an earlier version of this whitelist
    // dropped it, so the bound silently became the built-in default and the test that checks it failed.
    hardMaxTiles: Number(cfg?.hardMaxTiles) > 0 ? Number(cfg.hardMaxTiles) : 10000,
  })

  const parseUpscale = (v) => {
    if (v === undefined || v === null || v === '') return 1
    if (v === 'max') return 'max'
    if (v === 'native') return 1
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`upscale must be "native", "max", or a positive number; got ${JSON.stringify(v)}`)
    return n
  }

  const plan = (args) => {
    const c = resolveCfg()
    const src = loadSource(args.image ?? {}, c.processCwd)
    const depth = Math.max(0, Math.floor(Number(args.depth) ?? 0))
    const targets = Array.isArray(args.targets) ? args.targets : []
    const cap = Number(args.maxTiles) > 0 ? Number(args.maxTiles) : c.maxTiles
    const opts = { maxTiles: cap }
    if (Number.isFinite(Number(args.rows)) || Number.isFinite(Number(args.cols))) {
      opts.rows = Number(args.rows) || 1
      opts.cols = Number(args.cols) || 1
    }
    if (Array.isArray(args.tiles) && args.tiles.length) opts.tiles = args.tiles
    // WHERE the cuts fall is not the caller's burden by default: the plugin has the pixels, so it looks and
    // puts the seams where the picture is empty. Measured on the materials in experiments/ (3840x2160, 36
    // labels, boxes 58x24): an even ladder slices through 4 of 36 labels at depth 4; choosing the emptiest
    // nearby band slices through 0 of 36 at depths 3-6. `placement: "even"` keeps the historical exact
    // ladder, which is what the L2..L5 materials used.
    const placement = args.placement === 'even' ? 'even' : 'content'
    opts.placement = placement
    if (placement === 'content') opts.seamProfile = seamProfiles(src.img)
    // Overlap is the other way to keep content whole, and it is not an alternative to placement -- it
    // applies to whatever layout the placement produced. Fraction of each tile's own size.
    const overlap = Number(args.overlap) > 0 ? Math.min(0.9, Number(args.overlap)) : 0
    opts.overlap = overlap
    // NO A-PRIORI PRUNING. The earlier version refused an over-cap manual layout and silently reduced an
    // over-cap depth. Both decide FOR the caller, and the caller is a model in conditions this plugin
    // cannot see -- it may have a huge budget, a different consumer for the images, or a reason that only
    // exists at call time. A refusal also costs another step, and a step resends the whole context.
    // So: deliver exactly what was asked, and report the size so the caller can judge it.
    // The one bound kept is physical, and it is the operator's to set (config.hardMaxTiles), not a taste:
    // a single call cannot hand back more images than a context could ever hold. The planner applies the
    // same bound, so a manual layout and a depth request hit the identical ceiling.
    const hardMax = Number.isFinite(c.hardMaxTiles) && c.hardMaxTiles > 0 ? c.hardMaxTiles : 10000
    opts.hardMaxTiles = hardMax
    const { tiles, report } = planGrid({ width: src.img.w, height: src.img.h }, depth, targets, opts)
    if (tiles.length > hardMax) {
      throw new Error(`compound_eye: ${tiles.length} tiles exceeds what one call can return (${hardMax} images); `
        + `this is a physical/context bound, configurable as hardMaxTiles, not a policy on your layout. `
        + `Nothing was delivered. Use compound_eye_probe to plan without images, or ask for a coarser split.`)
    }
    const upscale = parseUpscale(args.upscale)
    return { c, src, tiles, report, upscale, depth, cap }
  }

  const deliverSize = (tile, upscale, maxEdge) => {
    const nativeLong = Math.max(tile.w, tile.h)
    const forcedDown = nativeLong > maxEdge
    let scale = upscale === 'max' ? maxEdge / nativeLong
      : typeof upscale === 'number' ? upscale
        : Math.min(1, maxEdge / nativeLong)
    if (forcedDown) scale = Math.min(scale, maxEdge / nativeLong)
    return { scale, w: Math.max(1, Math.round(tile.w * scale)), h: Math.max(1, Math.round(tile.h * scale)) }
  }

  return {
    async run(args) {
      const { c, src, tiles, report, upscale, depth, cap } = plan(args)
      const cols = new Set(tiles.map(t => t.x)).size
      const out = []
      for (let i = 0; i < tiles.length; i++) {
        const row = Math.floor(i / cols), col = i % cols
        out.push(await deliverTile(ctx, { deliveryMaxEdge: c.deliveryMaxEdge }, src.img, tiles[i], row, col, upscale, src.label, i))
      }
      const totalBytes = out.reduce((a, t) => a + t.bytes, 0)
      const srcPx = src.img.w * src.img.h
      const deliveredPx = out.reduce((a, t) => a + t.delivered.w * t.delivered.h, 0)
      const mode = report.mode ?? 'grid'
      const result = [
        `compound_eye: ${src.label} ${src.img.w}x${src.img.h} -> ${out.length} tiles (${mode}).`,
        `Delivered ${deliveredPx.toLocaleString()} px in ${out.length} images (${(totalBytes / 1024).toFixed(0)} KiB); source ${srcPx.toLocaleString()} px.`,
        out.some(t => t.enlarged)
          ? `NOTE: ${out.filter(t => t.enlarged).length} of ${out.length} tiles were ENLARGED by interpolation, so this `
            + `delivery contains more pixels than the source region actually resolved. Measured on 36 labels: enlarging `
            + `tiles that had been cut from an already-downscaled frame read 30.6%, against 44.4% for the same tiles `
            + `delivered un-enlarged and 97.2% for the same regions cut from the native frame 1:1. If the source was `
            + `itself pre-downscaled, re-capture at native resolution instead of enlarging.`
          : '',
        out.length > cap
          ? `NOTE ON SIZE: you asked for ${out.length} images in one call; the advisory threshold is ${cap}. `
            + `Nothing was trimmed -- a layout you named is yours to name, and this plugin does not cap it. `
            + `The cost, so you can judge it: every one of these images stays in the context, and each further `
            + `step resends all of it. If this was not the intent, compound_eye_probe plans the same layout `
            + `for zero images, and a coarser split simply means one more call.`
          : '',
        ...planSummary(report),
        ...(report.ok === false
          ? [`WARNING: these rectangles cannot be delivered as given: ${(report.problems || []).join('; ')}.`]
          : coverageSummary(report.coverage, report.clipped)),
        'Coordinates: report normalized (u,v) INSIDE the single tile you read; the source rectangle is on each caption.',
      ].filter(Boolean).join('\n')
      return { result, tiles: out, report, source: { w: src.img.w, h: src.img.h, label: src.label }, requested: { depth, upscale: String(args.upscale ?? 'native') } }
    },
    async probe(args) {
      const { c, src, tiles, report, upscale, depth } = plan(args)
      const cols = new Set(tiles.map(t => t.x)).size
      const shaped = tiles.map((t, i) => {
        const d = deliverSize(t, upscale, c.deliveryMaxEdge)
        return { index: i, row: Math.floor(i / cols), col: i % cols, source: t, delivered: d }
      })
      const lines = shaped.map(s =>
        `  [${s.row + 1},${s.col + 1}] source x=${s.source.x} y=${s.source.y} w=${s.source.w} h=${s.source.h}`
        + ` -> delivered ${s.delivered.w}x${s.delivered.h} (${s.delivered.scale.toFixed(3)}x)`)
      const result = [
        `compound_eye_probe: ${src.label} ${src.img.w}x${src.img.h}, ${report.mode ?? 'grid'}`
        + `${report.rows ? ` (${report.cols}x${report.rows})` : ''} -> ${tiles.length} tiles. No image delivered.`,
        ...planSummary(report),
        ...(report.ok === false
          ? [`CANNOT DELIVER AS GIVEN: ${(report.problems || []).join('; ')}`]
          : coverageSummary(report.coverage, report.clipped)),
        ...lines,
      ].filter(Boolean).join('\n')
      return { result, report, tiles: shaped, source: { w: src.img.w, h: src.img.h, label: src.label } }
    },
  }
}
