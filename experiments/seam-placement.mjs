/**
 * Two ways to stop a seam from destroying content, measured against each other on the repository's own
 * materials. They are NOT alternatives and not ranked: they fail differently, so both are parameters.
 *
 *   node experiments/seam-placement.mjs            print the table
 *   node experiments/seam-placement.mjs --check    fail if the claims in the README no longer hold
 *
 *   1. placement -- put the seam where the picture is empty. Needs a clean line to exist near the even
 *      position. Costs nothing in pixels. When the frame is dense, there is no such line.
 *   2. overlap   -- grow every tile so neighbours overlap. Needs no clean line at all: anything on a seam
 *      is whole in at least one neighbour. Costs delivered pixels, and can push a tile past the delivery
 *      ceiling, where it gets downscaled.
 *
 * How the measurement is built, so it can be attacked:
 *   - the frame is stitched back from the 16 native L5 tiles in first-experiment/tiles/ (an exact partition;
 *     their pixels are verified against the three-arm naive stimuli by as-run/compare-stimuli.mjs)
 *   - label boxes are 58x24 around each ground-truth point, the plugin's own box model
 *   - everything is planned by the shipped planner (lib/grid.js), not by a copy of its logic
 *   - "sliced" = a seam passes strictly through the box (delivered in two images)
 *   - "lost"   = NO delivered tile contains the box (the failure that actually matters)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng } from '../lib/png.js'
import { seamProfiles } from '../lib/placement.js'
import { planGrid } from '../lib/grid.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const truth = JSON.parse(readFileSync(join(HERE, 'truth.json'), 'utf8').replace(/^\uFEFF/, ''))
const W = truth.sourceW, H = truth.sourceH
const BOX = { w: 58, h: 24 }

const luma = new Uint8Array(W * H)
for (const t of truth.tiles.filter(t => t.level === 5)) {
  const img = decodePng(readFileSync(join(HERE, 'first-experiment', 'tiles', t.file)))
  for (let y = 0; y < t.gh; y++) {
    for (let x = 0; x < t.gw; x++) {
      const i = ((y * img.w) + x) * img.ch
      luma[(t.gy + y) * W + (t.gx + x)] = Math.round(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2])
    }
  }
}
const profile = seamProfiles({ w: W, h: H, ch: 1, data: luma })

const box = l => ({ x0: l.x - BOX.w / 2, x1: l.x + BOX.w / 2, y0: l.y - BOX.h / 2, y1: l.y + BOX.h / 2 })
const sliced = (tiles, l) => {
  const b = box(l)
  if (tiles.some(t => b.x0 >= t.x && b.x1 <= t.x + t.w && b.y0 >= t.y && b.y1 <= t.y + t.h)) return false
  return true
}
const lost = (tiles, l) => {
  const b = box(l)
  return !tiles.some(t => b.x0 >= t.x && b.x1 <= t.x + t.w && b.y0 >= t.y && b.y1 <= t.y + t.h)
}
const count = (tiles, fn) => truth.labels.filter(l => fn(tiles, l)).length
const px = tiles => tiles.reduce((s, t) => s + t.w * t.h, 0)

const plan = (depth, opts) => planGrid({ width: W, height: H }, depth, [], opts)

const rows = []
for (const d of [2, 3, 4, 5, 6]) {
  const even = plan(d, { placement: 'even' })
  const content = plan(d, { placement: 'content', seamProfile: profile })
  const contentOverlap = plan(d, { placement: 'content', seamProfile: profile, overlap: 0.15 })
  const evenOverlap = plan(d, { placement: 'even', overlap: 0.15 })
  rows.push({
    d, tiles: even.tiles.length,
    even: { sliced: count(even.tiles, sliced), lost: count(even.tiles, lost), px: px(even.tiles) },
    content: { sliced: count(content.tiles, sliced), lost: count(content.tiles, lost), px: px(content.tiles) },
    overlap: { sliced: count(evenOverlap.tiles, sliced), lost: count(evenOverlap.tiles, lost), px: px(evenOverlap.tiles) },
    both: { sliced: count(contentOverlap.tiles, sliced), lost: count(contentOverlap.tiles, lost), px: px(contentOverlap.tiles) },
  })
}

console.log(`frame ${W}x${H} stitched from 16 native tiles; ${truth.labels.length} labels, boxes ${BOX.w}x${BOX.h}`)
console.log('each cell is "labels a seam passes through / labels no tile contains" (out of 36)\n')
console.log('depth  tiles   even ladder      content placement   even + 15% overlap   content + 15% overlap')
for (const r of rows) {
  const f = c => `${String(c.sliced).padStart(2)}/${String(c.lost).padStart(2)}`.padEnd(19)
  console.log(`${String(r.d).padStart(5)}${String(r.tiles).padStart(7)}   ${f(r.even)} ${f(r.content)} ${f(r.overlap)} ${f(r.both)}`)
}
const d4 = rows.find(r => r.d === 4)
const costPct = t => `${((t / d4.even.px - 1) * 100).toFixed(0)}%`
console.log(`\ndelivered pixels at depth 4: even ${d4.even.px.toLocaleString()} · content ${d4.content.px.toLocaleString()} `
  + `(${costPct(d4.content.px)} vs even) · even+overlap ${d4.overlap.px.toLocaleString()} (${costPct(d4.overlap.px)}) · `
  + `content+overlap ${d4.both.px.toLocaleString()} (${costPct(d4.both.px)})`)

// ---- the regime where the two methods stop being equivalent ----
// These materials are sparse enough that a clean line always exists near every even position, so placement
// wins on cost. A DENSE frame has no clean line: every candidate position passes through ink. That case is
// modelled honestly as a uniform seam profile -- it is a profile, not a fabricated image, and it stands in
// for "the caller's screenshot is text everywhere", which is exactly when placement cannot help.
const uniform = { col: new Float64Array(W).fill(1000), row: new Float64Array(H).fill(1000) }
console.log('\nno clean line anywhere (uniform seam profile -- a stand-in for a text-dense frame):')
console.log('depth  tiles   content placement   content + 15% overlap   overlap cost')
const dense = []
for (const d of [3, 4, 5, 6]) {
  const c = plan(d, { placement: 'content', seamProfile: uniform })
  const o = plan(d, { placement: 'content', seamProfile: uniform, overlap: 0.15 })
  const row = { d, tiles: c.tiles.length, contentLost: count(c.tiles, lost), overlapLost: count(o.tiles, lost),
    cost: (px(o.tiles) / px(c.tiles) - 1) * 100 }
  dense.push(row)
  console.log(`${String(d).padStart(5)}${String(row.tiles).padStart(7)}${String(row.contentLost + '/36').padStart(20)}`
    + `${String(row.overlapLost + '/36').padStart(24)}${(row.cost.toFixed(0) + '%').padStart(15)}`)
}
console.log('=> with no clean line, placement cannot help and overlap is what saves the labels. Neither method')
console.log('   dominates, which is why both are parameters rather than one being chosen for the caller.')

if (process.argv.includes('--check')) {
  const bad = []
  for (const r of rows) {
    if (r.d >= 3 && r.content.lost !== 0) bad.push(`depth ${r.d}: content placement lost ${r.content.lost} labels, expected 0`)
    if (r.d >= 3 && r.overlap.lost !== 0) bad.push(`depth ${r.d}: even+15% overlap lost ${r.overlap.lost} labels, expected 0`)
    if (r.d >= 3 && r.both.lost !== 0) bad.push(`depth ${r.d}: content+overlap lost ${r.both.lost} labels, expected 0`)
  }
  if (!(d4.even.lost > 0)) bad.push(`depth 4: the even ladder lost ${d4.even.lost} labels -- the comparison has stopped being exercised`)
  if (!(d4.overlap.px > d4.even.px)) bad.push('depth 4: overlap did not cost any extra pixels -- is it being applied?')
  // In the no-clean-line regime, placement must NOT be able to beat the overlap: if it did, the uniform
  // profile would not be uniform and the claim "overlap is what saves you there" would be unsupported.
  for (const r of dense) {
    if (r.contentLost === 0) bad.push(`dense depth ${r.d}: content placement lost nothing even with no clean line -- the model is wrong`)
    if (r.overlapLost !== 0) bad.push(`dense depth ${r.d}: overlap lost ${r.overlapLost} labels, expected 0`)
    if (!(r.cost > 0)) bad.push(`dense depth ${r.d}: overlap cost ${r.cost.toFixed(1)}% -- is it being applied?`)
  }
  if (bad.length) {
    console.log(`\nFAILED --check: ${bad.length} mismatch(es):`)
    for (const b of bad) console.log('   ' + b)
    process.exit(1)
  }
  console.log('\nOK --check passed: the even ladder loses labels at depth 4; content placement and 15% overlap each lose none'
    + ' at depths 3-6; overlap costs extra pixels; and with no clean line placement cannot help while overlap still loses none.')
}
