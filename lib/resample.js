/**
 * Resampling: area average when shrinking, bilinear when growing.
 *
 * WHY this distinction is not a detail:
 *   - Shrinking with point sampling destroys thin strokes (a 12px glyph loses character strokes before
 *     the model ever sees it). Area average is what keeps the ink.
 *   - Growing with area average is undefined; bilinear is the honest "we are inventing no detail, only
 *     spreading what exists" operation. Interpolation adds NO information -- that is a property of the
 *     operation, not a claim about the pipeline. What it changes is how much of the already-captured
 *     signal survives the model's own encoding (measured: same pixels, +8.3 recall points at 1.633x).
 */
import { LUMA } from './png.js'

/** Pixel accessor returning [r,g,b] for ch in {1,2,3,4}. */
function rgbAt(img, x, y) {
  const { ch, data, w } = img
  const i = (y * w + x) * ch
  if (ch === 1 || ch === 2) {
    const g = data[i]
    return [g, g, g]
  }
  return [data[i], data[i + 1], data[i + 2]]
}

/** Luma for one pixel (used by highFrequencyEnergy below; kept private -- nothing outside needs it). */
function lumaAt(img, x, y) {
  const [r, g, b] = rgbAt(img, x, y)
  return LUMA(r, g, b)
}

/**
 * Resolve the integer source rectangle shared by resampling and coordinate metadata.
 * A rectangle that ends up empty after clipping is refused rather than returned blank.
 */
export function clipRect(src, sx, sy, sw, sh) {
  if (![sx, sy, sw, sh].every(Number.isFinite) || sw <= 0 || sh <= 0) {
    throw new Error('resample: source rect must have finite bounds and positive size')
  }
  const x0 = Math.max(0, Math.min(src.w, Math.round(sx)))
  const y0 = Math.max(0, Math.min(src.h, Math.round(sy)))
  const x1 = Math.max(x0, Math.min(src.w, Math.round(sx + sw)))
  const y1 = Math.max(y0, Math.min(src.h, Math.round(sy + sh)))
  const cw = x1 - x0, chh = y1 - y0
  if (cw <= 0 || chh <= 0) throw new Error('resample: source rect is empty after clamping')
  return { x: x0, y: y0, w: cw, h: chh }
}

/** Crop the effective source rectangle and deliver dw x dh pixels. */
export function resample(src, sx, sy, sw, sh, dw, dh) {
  const { x: x0, y: y0, w: cw, h: chh } = clipRect(src, sx, sy, sw, sh)
  const x1 = x0 + cw, y1 = y0 + chh
  if (!Number.isSafeInteger(dw) || !Number.isSafeInteger(dh) || dw <= 0 || dh <= 0) {
    throw new Error('resample: output size must be positive integers')
  }

  const out = Buffer.alloc(dw * dh * 4)
  const scaleX = cw / dw, scaleY = chh / dh
  const shrink = scaleX > 1.0001 || scaleY > 1.0001

  for (let dy = 0; dy < dh; dy++) {
    const oy = dy * dw * 4
    if (shrink) {
      // Area average: integrate every source pixel the output pixel covers.
      const gy0 = y0 + dy * scaleY, gy1 = y0 + (dy + 1) * scaleY
      const py0 = Math.floor(gy0), py1 = Math.max(py0 + 1, Math.ceil(gy1))
      for (let dx = 0; dx < dw; dx++) {
        const gx0 = x0 + dx * scaleX, gx1 = x0 + (dx + 1) * scaleX
        const px0 = Math.floor(gx0), px1 = Math.max(px0 + 1, Math.ceil(gx1))
        let r = 0, g = 0, b = 0, weight = 0
        for (let y = py0; y < py1; y++) {
          const yy = y < y0 ? y0 : (y >= y1 ? y1 - 1 : y)
          const wy = Math.max(0, Math.min(gy1, y + 1) - Math.max(gy0, y))
          for (let x = px0; x < px1; x++) {
            const xx = x < x0 ? x0 : (x >= x1 ? x1 - 1 : x)
            const wx = Math.max(0, Math.min(gx1, x + 1) - Math.max(gx0, x))
            const area = wx * wy
            const [pr, pg, pb] = rgbAt(src, xx, yy)
            r += pr * area; g += pg * area; b += pb * area; weight += area
          }
        }
        const o = oy + dx * 4
        out[o] = Math.round(r / weight); out[o + 1] = Math.round(g / weight); out[o + 2] = Math.round(b / weight); out[o + 3] = 255
      }
    } else {
      // Bilinear: sample the source at the output pixel's centre.
      const fy = Math.min(y1 - 1, Math.max(y0, y0 + (dy + 0.5) * scaleY - 0.5))
      const iy0 = Math.floor(fy), iy1 = Math.min(y1 - 1, iy0 + 1), ty = fy - iy0
      for (let dx = 0; dx < dw; dx++) {
        const fx = Math.min(x1 - 1, Math.max(x0, x0 + (dx + 0.5) * scaleX - 0.5))
        const ix0 = Math.floor(fx), ix1 = Math.min(x1 - 1, ix0 + 1), tx = fx - ix0
        const p00 = rgbAt(src, ix0, iy0), p10 = rgbAt(src, ix1, iy0)
        const p01 = rgbAt(src, ix0, iy1), p11 = rgbAt(src, ix1, iy1)
        const o = oy + dx * 4
        for (let c = 0; c < 3; c++) {
          const top = p00[c] * (1 - tx) + p10[c] * tx
          const bot = p01[c] * (1 - tx) + p11[c] * tx
          out[o + c] = Math.round(top * (1 - ty) + bot * ty)
        }
        out[o + 3] = 255
      }
    }
  }
  return { w: dw, h: dh, ch: 4, data: out }
}

/**
 * Mean absolute high-frequency energy per pixel (|I(x)-I(x+step)| over a grid).
 *
 * This is the cheap mechanical check that "upscaled" really is "interpolated": pure interpolation
 * makes an image SMOOTHER per pixel, so the ratio up/scaled should be < 1. It is evidence about the
 * operation, and it is deliberately not a claim about whether upscaling helps the model.
 */
export function highFrequencyEnergy(img, step = 5) {
  let sum = 0, n = 0
  for (let y = 0; y + step < img.h; y += step) {
    for (let x = 0; x + step < img.w; x += step) {
      sum += Math.abs(lumaAt(img, x, y) - lumaAt(img, x + step, y))
      n++
    }
  }
  return n ? sum / n : 0
}
