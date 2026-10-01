/**
 * Same filename, different bytes -- are they the same image?
 *
 * The published coordinates come from `truth.json`, while the three-arm stimuli sit in
 * `three-arm/stimuli/`. Both directories contain a file called `L5_00_x0_y0_w960_h540.png`, and their
 * SHA256 differ. If the *content* differed, then "the same 36 labels on the same frame" would be an
 * unverified claim -- so measure it instead of assuming.
 *
 * Decoded with this plugin's own codec (lib/png.js). Run from the repository root:
 *   node experiments/three-arm/as-run/compare-stimuli.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng } from '../../../lib/png.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const A = join(HERE, '..', '..', 'first-experiment', 'tiles') + '/'
const B = join(HERE, '..', '..', 'three-arm', 'stimuli', 'naive') + '/'
const names = ['L5_00_x0_y0_w960_h540.png', 'L5_03_x960_y540_w960_h540.png', 'L5_15_x2880_y1620_w960_h540.png']

let allIdentical = true
for (const n of names) {
  const a = decodePng(readFileSync(A + n)), b = decodePng(readFileSync(B + n))
  const sameShape = a.w === b.w && a.h === b.h && a.ch === b.ch && a.data.length === b.data.length
  let diff = 0, maxAbs = 0, sumAbs = 0
  if (sameShape) {
    for (let i = 0; i < a.data.length; i++) {
      const d = Math.abs(a.data[i] - b.data[i])
      if (d) { diff++; sumAbs += d; if (d > maxAbs) maxAbs = d }
    }
  }
  if (diff !== 0) allIdentical = false
  console.log(`${n}`)
  console.log(`   first-experiment  ${a.w}x${a.h} ch=${a.ch} ${a.data.length} bytes`)
  console.log(`   three-arm/naive   ${b.w}x${b.h} ch=${b.ch} ${b.data.length} bytes`)
  console.log(`   per-channel differences: ${diff} of ${a.data.length} (${(diff / a.data.length * 100).toFixed(4)}%)`
    + `  max ${maxAbs}  mean over differing ${diff ? (sumAbs / diff).toFixed(2) : 0}`)
  console.log(`   -> ${diff === 0 ? 'IDENTICAL after decoding; the difference is PNG encoding only' : 'the content itself differs and needs its own explanation'}\n`)
}
console.log(allIdentical
  ? '=> truth.json is valid for both sets, and the naive arm of the three-arm experiment IS the L5 level of the first experiment.'
  : '=> STOP: the two sets are not the same image, so the shared ground truth does not apply to both.')
