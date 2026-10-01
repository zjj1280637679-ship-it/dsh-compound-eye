/**
 * Self-test for dsh-compound-eye. No harness required: it exercises the pure parts.
 *
 *   node test/selftest.mjs
 *
 * The three groups below are the three claims the plugin makes about itself. Each has a negative
 * case: a test that cannot fail is not evidence, so every group states what it would catch.
 */
import { decodePng, encodePng, pngSize } from '../lib/png.js'
import { resample, highFrequencyEnergy } from '../lib/resample.js'
import { planGrid, chooseCut, mergeSpans } from '../lib/grid.js'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`) }
}

// ---------------------------------------------------------------- a synthetic source
// A dark frame with light 3-character-ish blocks, so ink exists to measure.
function synth(w, h) {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const on = (x % 37 < 12) && (y % 41 < 9) && x > 20 && y > 20
    const v = on ? 236 : 28
    data[i] = v; data[i + 1] = v; data[i + 2] = v + (on ? 9 : -2); data[i + 3] = 255
  }
  return { w, h, ch: 4, data }
}

console.log('1) PNG codec is lossless and refuses what it cannot honour')
{
  const img = synth(200, 120)
  const png = encodePng(img)
  const size = pngSize(png)
  ok(size.w === 200 && size.h === 120, 'pngSize reads the header without decoding')
  const back = decodePng(png)
  let d = 0
  for (let i = 0; i < img.data.length; i++) d += Math.abs(img.data[i] - back.data[i])
  ok(d === 0, 'encode -> decode round-trip is byte-identical', `total abs diff ${d}`)
  // negative cases: these are the failures a silent codec would hide
  let threw = false
  try { decodePng(Buffer.from('not a png at all, definitely not')) } catch { threw = true }
  ok(threw, 'a non-PNG buffer is refused, not mis-parsed')
  threw = false
  const bad = Buffer.from(png)
  bad[24] = 16                       // bit depth 16 in IHDR
  try { decodePng(bad) } catch { threw = true }
  ok(threw, 'a 16-bit PNG is refused by name (only 8-bit is implemented)')
}

console.log('2) Resampling: shrinking keeps the source value range, growing adds none')
{
  const img = synth(400, 240)
  const e0 = highFrequencyEnergy(img)

  const down = resample(img, 0, 0, 400, 240, 200, 120)
  ok(down.w === 200 && down.h === 120, 'shrink delivers the requested size')
  // NOTE on what is NOT asserted: per-pixel high-frequency energy RISES when you shrink a fixed
  // region, because the same contrast lands on fewer pixels. An earlier version of this test asserted
  // it must fall -- that was wrong, and the wrong assertion is left documented rather than deleted.
  // The property that actually holds is a range property, and it is the one worth having: averaging
  // cannot produce a value outside the source range, so it cannot invent a brighter stroke.
  let lo = 255, hi = 0, slo = 255, shi = 0
  for (let i = 0; i < down.data.length; i += 4) { lo = Math.min(lo, down.data[i]); hi = Math.max(hi, down.data[i]) }
  for (let i = 0; i < img.data.length; i += 4) { slo = Math.min(slo, img.data[i]); shi = Math.max(shi, img.data[i]) }
  ok(lo >= slo && hi <= shi, 'area-average shrink stays inside the source value range (invents no ink)',
    `[${lo},${hi}] within [${slo},${shi}]`)

  const up = resample(img, 0, 0, 400, 240, 800, 480)
  const eUp = highFrequencyEnergy(up)
  ok(up.w === 800 && up.h === 480, 'grow delivers the requested size')
  // This IS the mechanical signature of interpolation: smoother per pixel, i.e. no new information.
  ok(eUp < e0, 'bilinear grow yields LESS per-pixel high-frequency energy (interpolation, not detail)',
    `${e0.toFixed(3)} -> ${eUp.toFixed(3)}`)

  // A crop keeps native pixel values exactly (no resample path).
  const crop = resample(img, 40, 30, 100, 60, 100, 60)
  let d = 0
  for (let y = 0; y < 60; y++) for (let x = 0; x < 100; x++) {
    const a = (y * 100 + x) * 4, b = ((y + 30) * 400 + (x + 40)) * 4
    d += Math.abs(crop.data[a] - img.data[b])
  }
  ok(d === 0, 'a 1:1 crop is exact (no interpolation in the crop path)', `total abs diff ${d}`)

  let threw = false
  try { resample(img, 5000, 5000, 10, 10, 10, 10) } catch { threw = true }
  ok(threw, 'a crop outside the image is refused, not padded with blank pixels')
}

console.log('3) Cuts avoid whole targets; when they cannot, the plan says so')
{
  ok(JSON.stringify(mergeSpans([{ a: 5, b: 10 }, { a: 8, b: 14 }])) === JSON.stringify([{ a: 5, b: 14 }]),
    'overlapping spans merge')
  ok(chooseCut(0, 100, [{ a: 40, b: 60 }]).clean === true
    && (chooseCut(0, 100, [{ a: 40, b: 60 }]).cut < 40 || chooseCut(0, 100, [{ a: 40, b: 60 }]).cut > 60),
    'a cut is placed outside a span when free space exists')
  ok(chooseCut(0, 100, [{ a: 0, b: 100 }]).clean === false, 'a fully covered range reports that no clean cut exists')

  const V = { width: 3840, height: 2160 }
  const straddle = { x: 936, y: 884, w: 58, h: 20, label: 'straddler' }

  const plain = planGrid(V, 4, [])
  ok(plain.tiles.length === 16, 'depth 4 yields 16 tiles (the shape the L4 materials used)')

  const aware = planGrid(V, 4, [straddle])
  const whole = aware.tiles.filter(t =>
    straddle.x >= t.x && straddle.x + straddle.w <= t.x + t.w &&
    straddle.y >= t.y && straddle.y + straddle.h <= t.y + t.h)
  ok(whole.length >= 1, 'a declared target ends up whole inside at least one tile',
    `found in ${whole.length} tile(s)`)
  ok(aware.report.straddling.length === 0, 'and the plan reports no straddling target')

  // depth 0 is the whole frame as one tile -- the "no split" case must not silently split.
  const none = planGrid(V, 0, [])
  ok(none.tiles.length === 1 && none.tiles[0].w === 3840, 'depth 0 returns the whole frame as one tile')

  // The refusal path. Two distinct ways a plan can fail to protect continuity, both must be REPORTED
  // rather than silently producing a half target:
  //   (a) spans tile the region so densely that no free gap exists at all -> forced cuts
  //   (b) free gaps exist but are narrower than the span pitch -> a cut lands inside some target
  //
  // (a) Full-width bands leave no vertical cut that avoids them, so no partition can keep them whole.
  //     The planner must SAY SO and name them -- an even grid plus a loud report is the honest outcome.
  const bands = []
  for (let y = 0; y < 2160; y += 300) bands.push({ x: 0, y, w: 3840, h: 299, label: `band${y}` })
  const d1 = planGrid(V, 4, bands)
  ok(d1.report.infeasible === true && d1.report.straddling.length === 8
    && d1.report.straddling.every(s => /^band\d+$/.test(s)),
    'targets that no partition can keep whole are reported as infeasible, and every one is named',
    `infeasible=${d1.report.infeasible} straddling=${d1.report.straddling.length}`)

  // (b) free gaps exist (about 260px per 320px pitch). At depth 5 a 3840px frame wants 32 tiles, i.e.
  //     strips near 120px, which cannot avoid a 320px pitch -- so EITHER the planner finds a feasible
  //     partition OR it refuses. Both are honest; what is forbidden is straddling a target.
  const cols = []
  for (let i = 0; i < 12; i++) cols.push({ x: i * 320 + 100, y: 0, w: 200, h: 2160, label: `c${i}` })
  const d2 = planGrid(V, 5, cols)
  ok(d2.report.infeasible === true || d2.report.straddling.length === 0,
    'a crowded plan either refuses or protects every target -- never straddles',
    `infeasible=${d2.report.infeasible} straddling=${d2.report.straddling.length} tiles=${d2.tiles.length}`)

  // A shallower, genuinely feasible crowded case: 6 columns leave gaps wide enough for a depth-2 split.
  const few = cols.filter((_, i) => i % 2 === 0)
  const d3 = planGrid(V, 2, few)
  ok(d3.report.infeasible === false && d3.report.straddling.length === 0,
    'with room to spare the planner finds a feasible partition and straddles nothing',
    `infeasible=${d3.report.infeasible} straddling=${d3.report.straddling.length}`)

  // The fan-out is the caller's, at every depth, without exception: exactly 2^dep tiles, non-degenerate.
  // A declared target that cannot be kept whole at that fineness must be NAMED, not silently fixed by
  // changing the fan-out -- that silent fix was the planner fighting its own rule (see the plan summary).
  let degenerated = 0, badCount = 0, unnamedSplits = 0
  for (let dep = 0; dep <= 6; dep++) {
    const g = planGrid(V, dep, [straddle, ...cols])
    if (g.tiles.length !== 2 ** dep) badCount++
    for (const t of g.tiles) if (t.w <= 0 || t.h <= 0) degenerated++
    for (const tg of [straddle, ...cols]) {
      const fits = g.tiles.some(t => tg.x >= t.x && tg.x + tg.w <= t.x + t.w && tg.y >= t.y && tg.y + tg.h <= t.y + t.h)
      const named = g.report.straddling.includes(tg.label) || g.report.unprotected.includes(tg.label)
      if (!fits && !named) unnamedSplits++
    }
  }
  ok(degenerated === 0 && badCount === 0,
    'at every depth the fan-out is exactly 2^depth, with no degenerate tiles',
    `degenerate=${degenerated} badCount=${badCount}`)
  ok(unnamedSplits === 0,
    'and any declared target that the requested fineness cannot keep whole is NAMED rather than fixed by reducing the fan-out',
    `unnamed splits=${unnamedSplits}`)
}

console.log('4) One planner, orthogonal knobs: fan-out | targets (placement) | rectangles (extra regions)')
{
  const V = { width: 3840, height: 2160 }
  const straddle = { x: 936, y: 884, w: 58, h: 20, label: 'straddler' }

  // `report.mode` is a LABEL for what the plan turned out to be, not a fork in behaviour. The earlier
  // design had three "modes" where one of them carried a self-imposed invariant that could contradict the
  // caller's fan-out and resolved that by lowering the fan-out -- the tool fighting itself.
  const s4 = planGrid(V, 4, [])
  ok(s4.report.mode === 'grid' && s4.tiles.length === 16 && s4.tiles[0].w === 960 && s4.tiles[0].h === 540,
    'fan-out alone labels the plan "grid" and gives a 4x4 grid of 960x540 tiles on 16:9',
    `${s4.report.mode} ${s4.tiles.length} ${s4.tiles[0].w}x${s4.tiles[0].h}`)
  const dims = new Set(s4.tiles.map(t => `${t.w}x${t.h}`))
  ok(dims.size === 1, 'and every tile is the same size (no ragged edges)', [...dims].join(' '))

  // targets change WHERE the cuts fall. Nothing else -- in particular not how many tiles come back.
  const a4 = planGrid(V, 4, [straddle])
  const fits = a4.tiles.some(t => straddle.x >= t.x && straddle.x + straddle.w <= t.x + t.w
    && straddle.y >= t.y && straddle.y + straddle.h <= t.y + t.h)
  ok(a4.report.mode === 'grid+targets' && fits && a4.report.straddling.length === 0,
    'declaring a target keeps it whole and reports no straddle',
    `${a4.report.mode} fits=${fits} straddling=${a4.report.straddling.length}`)
  ok(a4.tiles.length === 16 && a4.report.depth === 4,
    'and the fan-out is still exactly the one that was asked for', `${a4.tiles.length} tiles, depth ${a4.report.depth}`)

  // rectangles on their own: described, never rewritten, never required to tile the frame.
  const good = [{ x: 0, y: 0, w: 960, h: 2160 }, { x: 960, y: 0, w: 960, h: 2160 },
                { x: 1920, y: 0, w: 960, h: 2160 }, { x: 2880, y: 0, w: 960, h: 2160 }]
  const m = planGrid(V, 0, [straddle], { tiles: good })
  ok(m.report.mode === 'rectangles' && m.report.ok === true, 'rectangles alone label the plan "rectangles"')
  ok(JSON.stringify(m.report.straddling) === JSON.stringify(['straddler']),
    'and it tells the caller that this layout splits the target (it does not fix it)',
    JSON.stringify(m.report.straddling))
  ok(m.tiles.length === 4 && m.tiles[0].x === 0 && m.tiles[0].w === 960, 'caller rectangles come back unchanged')
  ok(m.report.coverage.mode === 'exact' && m.report.coverage.fraction === 1 && m.report.coverage.overlapPx === 0,
    'and classifies a gapless non-overlapping layout as exact',
    JSON.stringify(m.report.coverage.mode))

  // COMPOSITION: fan-out and rectangles are not an either/or. "The 4x4 grid, plus a zoom on the toolbar"
  // is one call. The earlier design made `tiles` REPLACE the grid, so the two could not be combined.
  const composed = planGrid(V, 4, [], { tiles: [{ x: 900, y: 860, w: 120, h: 60 }] })
  ok(composed.tiles.length === 17 && composed.report.gridTiles === 16 && composed.report.extraTiles === 1,
    'a fan-out and extra rectangles compose into one delivery (grid + the regions you care about)',
    `${composed.tiles.length} tiles = ${composed.report.gridTiles} grid + ${composed.report.extraTiles} extra`)
  ok(composed.report.mode === 'grid+rectangles', 'and the label says so', composed.report.mode)
  ok(composed.report.coverage.mode === 'complete-overlapping' && composed.report.coverage.overlapPx > 0,
    'with the overlap measured rather than forbidden (the zoom region is inside a grid tile)',
    `${composed.report.coverage.mode} overlap=${composed.report.coverage.overlapPx}`)

  // ---- a cut is an annotation, so it has to be an exact integer in source coordinates ----
  const fractions = planGrid(V, 2, [], { tiles: [{ x: 10.4, y: 20.6, w: 99.7, h: 50.2 }, { x: 110.1, y: 20.6, w: 90.4, h: 50.2 }] })
  ok(fractions.tiles.every(t => [t.x, t.y, t.w, t.h].every(Number.isInteger)),
    'fractional caller rectangles are rounded to whole pixels',
    JSON.stringify(fractions.tiles.map(t => [t.x, t.y, t.w, t.h])))
  ok(fractions.report.adjusted.length === 2 && fractions.report.adjusted[0].kind === 'rectangle',
    'and the rounding is REPORTED, not done quietly (a rounded crop is a different crop)',
    JSON.stringify(fractions.report.adjusted))
  const fractionalTarget = planGrid(V, 2, [{ x: 100.5, y: 200.5, w: 30.4, h: 10.6, label: 't' }])
  ok(fractionalTarget.report.adjusted.some(a => a.kind === 'target'),
    'declared targets are rounded the same way, so straddle detection and labels share one integer grid')

  // ---- the default placement looks at the picture; "even" keeps the historical ladder ----
  const ink = { col: new Float64Array(V.width), row: new Float64Array(V.height) }
  for (let x = 900; x < 1020; x++) ink.col[x] = 5000        // a band of ink sitting on the even cut at 960
  const content = planGrid(V, 4, [], { seamProfile: ink })   // depth 4 -> cuts at x=960,1920,2880
  const even = planGrid(V, 4, [], { seamProfile: ink, placement: 'even' })
  const cutX = g => [...new Set(g.tiles.map(t => t.x))].sort((a, b) => a - b)
  ok(even.report.placement === 'even' && cutX(even).join(',') === '0,960,1920,2880',
    'placement "even" reproduces the exact historical ladder', cutX(even).join(','))
  ok(content.report.placement === 'content' && !cutX(content).includes(960),
    'the default moves the cut off the ink band instead of through it', cutX(content).join(','))
  ok(content.report.seamInk.chosen < content.report.seamInk.even,
    'and reports how much seam contrast it avoided, so the caller can see the gain',
    JSON.stringify(content.report.seamInk))
  ok(content.tiles.every(t => Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.w) && Number.isInteger(t.h)),
    'content-aware cuts are integers too -- a cut has to be nameable to be an annotation')
  ok(content.report.cuts.every(c => Number.isInteger(c.at)) && content.report.cuts.length > 0,
    'and the cuts come back as an explicit list of integer source coordinates',
    JSON.stringify(content.report.cuts))
  const spread = content.tiles.map(t => t.w)
  ok(Math.max(...spread) - Math.min(...spread) < 0.4 * (V.width / 4),
    'while tiles stay close to even (dodging content, not building a ragged layout)',
    `widths ${Math.min(...spread)}..${Math.max(...spread)}`)


  // Coverage is DESCRIBED, not forbidden. A caller may deliberately deliver a subset ("zoom into the
  // three regions I care about") or deliberately overlap ("keep this target whole across a seam").
  // The earlier version made both fatal, which forced the caller to lie about intent -- the plugin's
  // job is to say what the layout IS, not to overrule it. Only impossible rectangles stay fatal.
  const gapped = [{ x: 0, y: 0, w: 960, h: 2160 }, { x: 960, y: 0, w: 960, h: 2160 }]
  const gap = planGrid(V, 0, [], { tiles: gapped }).report
  ok(gap.ok === true, 'a partial layout is ACCEPTED (not refused)')
  ok(gap.coverage.mode === 'partial' && gap.coverage.fraction > 0.49 && gap.coverage.fraction < 0.51,
    'and is classified as partial with the covered fraction measured',
    `mode=${gap.coverage.mode} fraction=${gap.coverage.fraction.toFixed(3)}`)
  ok(gap.coverage.gapRects.length >= 1 && gap.coverage.gapRects[0].x >= 1920,
    'and the uncovered region is named as a rectangle, not just summarised as a number',
    JSON.stringify(gap.coverage.gapRects))
  ok(gap.coverage.gapRects.reduce((s, r) => s + r.w * r.h, 0) > 0.45 * 3840 * 2160,
    'and the named gaps account for the missing area (they are not a token gesture)',
    String(gap.coverage.gapRects.reduce((s, r) => s + r.w * r.h, 0)))

  const overlapping = [{ x: 0, y: 0, w: 2000, h: 2160 }, { x: 1000, y: 0, w: 2840, h: 2160 }]
  const ovr = planGrid(V, 0, [], { tiles: overlapping }).report
  ok(ovr.ok === true, 'an overlapping layout is ACCEPTED (overlap is a legitimate way to keep a target whole)')
  ok(ovr.coverage.mode === 'complete-overlapping' && ovr.coverage.overlapPx > 0,
    'and the overlap is measured and reported',
    `mode=${ovr.coverage.mode} overlap=${ovr.coverage.overlapPx}`)

  const outside = [{ x: 0, y: 0, w: 4000, h: 2160 }]
  const out1 = planGrid(V, 0, [], { tiles: outside }).report
  ok(out1.ok === true && out1.clipped.length === 1, 'a tile sticking out of the frame is delivered clipped, and listed')
  const outside2 = [{ x: 5000, y: 0, w: 400, h: 400 }]
  ok(planGrid(V, 0, [], { tiles: outside2 }).report.ok === false,
    'but a tile lying entirely outside the frame is fatal (there is nothing to deliver)')
  const degenerate = [{ x: 0, y: 0, w: 0, h: 100 }]
  ok(planGrid(V, 0, [], { tiles: degenerate }).report.ok === false, 'and a degenerate tile is fatal')
}

console.log('5) Real screenshot: the crop path against the measured materials')
{
  const p = 'D:/deepseek/.tmp/attn-exp/tiles/L5_00_x0_y0_w960_h540.png'
  let img
  try { img = decodePng(readFileSync(p)) } catch { img = null }
  if (!img) {
    console.log('  skip (measured sample not present on this machine)')
  } else {
    ok(img.w === 960 && img.h === 540, `decodes a real capture (${img.w}x${img.h})`)
    const e = highFrequencyEnergy(img)
    ok(e > 0, 'the real capture has measurable high-frequency energy', e.toFixed(3))
    const up = resample(img, 0, 0, img.w, img.h, Math.round(img.w * 1.633), Math.round(img.h * 1.633))
    ok(highFrequencyEnergy(up) < e, 'enlarging the real capture is smoother per pixel, as interpolation must be')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
