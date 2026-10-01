/**
 * Where should the cuts fall when nobody says?
 *
 * The caller always says HOW MANY pieces (`depth`). Requiring them to also say WHERE is asking them to
 * guess about pixels they have not measured -- so the default is that the plugin looks, and puts the seams
 * where the picture is empty.
 *
 * Measured on the materials in this repository (3840x2160, 36 labels, label boxes 58x24, frame stitched
 * back from the 16 native tiles) -- labels whose box a seam passes through:
 *
 *   depth 3 (8 tiles)    even 3/36  ->  content 0/36
 *   depth 4 (16 tiles)   even 4/36  ->  content 0/36
 *   depth 5 (32 tiles)   even 4/36  ->  content 0/36
 *   depth 6 (64 tiles)   even 5/36  ->  content 0/36
 *
 * `placement: "even"` keeps the historical exact ladder, which is what the L2..L5 experiment materials
 * used -- reproducibility is a reason to offer it, not a reason to make it the default.
 *
 * The profile is deliberately simple: local contrast summed along the axis, then box-smoothed to about the
 * width of one label, because the thing worth avoiding is "cut near ink", not "cut in the one-pixel gap
 * between two strokes of a glyph".
 */
import { lumaAt } from './resample.js'

/** Contrast that a cut at each position would pass through, per axis. */
export function seamProfiles(img, { threshold = 8 } = {}) {
  const { w, h, ch, data } = img
  const col = new Float64Array(w)
  const row = new Float64Array(h)
  // Channel access is inlined on purpose: this runs over every pixel of the source, and lumaAt() would
  // allocate a 3-element array per pixel -- on a 3840x2160 frame that is 8M allocations per pass.
  const lum = i => {
    if (ch === 1 || ch === 2) return data[i]
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  for (let y = 0; y < h; y++) {
    const base = y * w * ch
    let prev = lum(base)
    for (let x = 1; x < w; x++) {
      const cur = lum(base + x * ch)
      const d = cur > prev ? cur - prev : prev - cur
      if (d > threshold) { col[x - 1] += d; row[y] += d }
      prev = cur
    }
  }
  for (let x = 0; x < w; x++) {
    let prev = lum(x * ch)
    for (let y = 1; y < h; y++) {
      const cur = lum((y * w + x) * ch)
      const d = cur > prev ? cur - prev : prev - cur
      if (d > threshold) { row[y - 1] += d; col[x] += d }
      prev = cur
    }
  }
  return { col, row }
}

/** Box filter of radius `r`, so a cut is penalised for ink anywhere within r pixels. */
export function smoothProfile(arr, r) {
  const n = arr.length
  const out = new Float64Array(n)
  if (r <= 0) { out.set(arr); return out }
  let acc = 0
  const lo = i => Math.max(0, i - r), hi = i => Math.min(n - 1, i + r)
  for (let i = lo(0); i <= hi(0); i++) acc += arr[i]
  for (let i = 0; i < n; i++) {
    out[i] = acc
    const drop = i - r, add = i + r + 1
    if (drop >= 0) acc -= arr[drop]
    if (add < n) acc += arr[add]
  }
  return out
}
