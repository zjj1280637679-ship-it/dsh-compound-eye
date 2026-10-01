/**
 * Does the default cut placement actually help? Measure it on the repository's own materials.
 *
 *   node experiments/seam-placement.mjs            print the table
 *   node experiments/seam-placement.mjs --check    fail if the claim in the README no longer holds
 *
 * The claim: an even ladder slices through labels; placing each seam in the emptiest nearby band does not.
 *
 * How the measurement is built, so it can be attacked:
 *   - The frame is stitched back from the 16 native L5 tiles in first-experiment/tiles/. They are an exact
 *     partition of the 3840x2160 source, and decoding them yields the native pixels (verified pixel-identical
 *     against the three-arm naive stimuli by as-run/compare-stimuli.mjs).
 *   - Label boxes are 58x24 around each of the 36 ground-truth points, the same box model the plugin's
 *     e2e test uses.
 *   - "Sliced" means: a seam passes strictly through the box, so the glyph is delivered in two images and a
 *     model cannot join them.
 *   - Seam cost is local contrast summed along the axis and box-smoothed to ~one label width (lib/placement.js).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng } from '../lib/png.js'
import { seamProfiles, smoothProfile } from '../lib/placement.js'
import { evenCuts, snapCuts } from '../lib/grid.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const truth = JSON.parse(readFileSync(join(HERE, 'truth.json'), 'utf8').replace(/^\uFEFF/, ''))
const W = truth.sourceW, H = truth.sourceH
const BOX = { w: 58, h: 24 }

// ---- stitch the native frame back together ----
const luma = new Float32Array(W * H)
for (const t of truth.tiles.filter(t => t.level === 5)) {
  const img = decodePng(readFileSync(join(HERE, 'first-experiment', 'tiles', t.file)))
  for (let y = 0; y < t.gh; y++) {
    for (let x = 0; x < t.gw; x++) {
      const i = ((y * img.w) + x) * img.ch
      luma[(t.gy + y) * W + (t.gx + x)] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    }
  }
}
const profiles = seamProfiles({ w: W, h: H, ch: 1, data: Uint8Array.from(luma, v => Math.max(0, Math.min(255, Math.round(v)))) })
const colS = smoothProfile(profiles.col, 30), rowS = smoothProfile(profiles.row, 30)

const slicedBy = (xs, ys) => truth.labels.filter(l => {
  const x0 = l.x - BOX.w / 2, x1 = l.x + BOX.w / 2, y0 = l.y - BOX.h / 2, y1 = l.y + BOX.h / 2
  return xs.some(c => c > x0 && c < x1) || ys.some(c => c > y0 && c < y1)
}).length

const rows = []
for (const d of [2, 3, 4, 5, 6]) {
  const half = Math.floor(d / 2), cols = 2 ** (half + (d % 2)), rowsN = 2 ** half
  const ex = evenCuts(W, cols), ey = evenCuts(H, rowsN)
  const cx = snapCuts(W, cols, colS), cy = snapCuts(H, rowsN, rowS)
  rows.push({ d, tiles: cols * rowsN, even: slicedBy(ex, ey), content: slicedBy(cx, cy), cx, cy })
}

console.log(`stiched frame ${W}x${H} from ${truth.tiles.filter(t => t.level === 5).length} native tiles; `
  + `${truth.labels.length} labels, boxes ${BOX.w}x${BOX.h}\n`)
console.log('depth  tiles   even  content   content cuts')
for (const r of rows) {
  console.log(`${String(r.d).padStart(5)}${String(r.tiles).padStart(7)}${String(r.even).padStart(7)}${String(r.content).padStart(9)}   x=${r.cx.join(',')} y=${r.cy.join(',')}`)
}

if (process.argv.includes('--check')) {
  const bad = []
  for (const r of rows) {
    if (r.d >= 3 && r.content !== 0) bad.push(`depth ${r.d}: content placement sliced ${r.content} labels, expected 0`)
  }
  const d4 = rows.find(r => r.d === 4)
  if (!(d4.even > 0)) bad.push(`depth 4: the even ladder sliced ${d4.even} labels -- the comparison is not being exercised`)
  if (bad.length) {
    console.log(`\nFAILED --check: ${bad.length} mismatch(es):`)
    for (const b of bad) console.log('   ' + b)
    process.exit(1)
  }
  console.log('\nOK --check passed: the even ladder slices labels at depth 4 and the content-aware default slices none at depths 3-6.')
}
