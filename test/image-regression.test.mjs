import test from 'node:test'
import assert from 'node:assert/strict'
import { encodePng, decodePng, pngSize } from '../lib/png.js'
import { resample } from '../lib/resample.js'
import { createExecutor, makeCompoundEyeTool, makeProbeTool, renderTiles } from '../lib/eye.js'

// Portable fixtures: no host packages, local screenshot archive, or live desktop required.
function image(w, h, pixel) {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    data.set([...pixel(x, y), 255], (y * w + x) * 4)
  }
  return { w, h, ch: 4, data }
}

function executor(cfg = {}) {
  const saved = []
  const ctx = { get: () => ({ async saveImage({ data, name }) {
    saved.push({ data, name })
    return { image: { attachmentId: `test_${saved.length}` } }
  } }) }
  return { saved, exec: createExecutor({ ctx, cfg }) }
}

const input = img => ({ base64: encodePng(img).toString('base64'), name: 'fixture.png' })

test('four clipped edges bind image pixels, filenames, captions and coordinates to the effective crop', async () => {
  const src = image(100, 100, (x, y) => [x, y, 0])
  const cases = [
    [{ x: 50, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 50, h: 100 }],
    [{ x: -50, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 50, h: 100 }],
    [{ x: 0, y: 50, w: 100, h: 100 }, { x: 0, y: 50, w: 100, h: 50 }],
    [{ x: 0, y: -50, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 50 }],
  ]
  for (const [requested, effective] of cases) {
    const { exec, saved } = executor()
    const args = { image: input(src), tiles: [requested] }
    const result = await exec.run(args)
    const preview = await exec.probe(args)
    const tile = result.tiles[0]
    assert.deepEqual(tile.source, effective)
    assert.deepEqual(preview.tiles[0].source, effective)
    assert.deepEqual(preview.tiles[0].delivered, tile.delivered)
    assert.equal(result.report.clipped.length, 1)
    assert.deepEqual(result.report.clipped[0], { index: 0, ...requested })
    assert.equal(tile.delivered.w, effective.w)
    assert.equal(tile.delivered.h, effective.h)
    assert.equal(tile.delivered.scale, 1)
    assert.ok(tile.name.includes(`_x${effective.x}_y${effective.y}_w${effective.w}_h${effective.h}`))
    assert.ok(tile.caption.includes(`source x=${effective.x} y=${effective.y} w=${effective.w} h=${effective.h}`))
    const actual = decodePng(saved[0].data)
    for (let y = 0; y < actual.h; y++) for (let x = 0; x < actual.w; x++) {
      const at = (y * actual.w + x) * 4
      assert.equal(actual.data[at], effective.x + x)
      assert.equal(actual.data[at + 1], effective.y + y)
    }
    // A returned point uses the same source coordinate system as the encoded gradient.
    const x = Math.floor(actual.w / 2), y = Math.floor(actual.h / 2)
    const at = (y * actual.w + x) * 4
    assert.equal(tile.source.x + x / actual.w * tile.source.w, actual.data[at])
    assert.equal(tile.source.y + y / actual.h * tile.source.h, actual.data[at + 1])
    assert.equal(renderTiles(args, result).filter(b => b.type === 'image').length, 1)
    assert.equal(saved.length, 1, 'probe must not persist images')
  }
})

test('numeric and max upscale respect the ceiling and match the probe', async () => {
  const src = image(100, 75, () => [20, 40, 60])
  for (const upscale of ['2', '1e100', 'max', '0.5', 'native']) {
    const { exec, saved } = executor({ deliveryMaxEdge: 128 })
    const args = { image: input(src), depth: 0, upscale }
    const preview = await exec.probe(args)
    const result = await exec.run(args)
    assert.deepEqual(result.tiles[0].delivered, preview.tiles[0].delivered)
    const size = pngSize(saved[0].data)
    assert.ok(Math.max(size.w, size.h) <= 128)
    assert.equal(size.w, result.tiles[0].delivered.w)
    assert.equal(size.h, result.tiles[0].delivered.h)
    if (['2', '1e100', 'max'].includes(upscale)) assert.equal(size.w, 128)
    if (upscale === 'native') assert.equal(size.w, 100)
    if (upscale === '0.5') {
      assert.equal(size.w, 50)
      assert.match(result.tiles[0].caption, /requested scale/)
    }
  }
})

test('fractional and nonfinite config ceilings cannot produce invalid output dimensions', async () => {
  const src = image(10, 10, () => [100, 100, 100])
  for (const [edge, expected] of [[10.9, 10], [0.5, 1], [Infinity, 20]]) {
    const { exec, saved } = executor({ deliveryMaxEdge: edge })
    const out = await exec.run({ image: input(src), depth: 0, upscale: '2' })
    assert.equal(out.tiles[0].delivered.w, expected)
    assert.equal(pngSize(saved[0].data).w, expected)
  }
})

test('noninteger shrink weights source pixels by the covered area on both axes', () => {
  const row = image(3, 1, x => Array(3).fill([0, 255, 0][x]))
  const col = image(1, 3, (_, y) => [[0, 255, 0][y], 0, 0])
  const rowOut = resample(row, 0, 0, 3, 1, 2, 1)
  const colOut = resample(col, 0, 0, 1, 3, 1, 2)
  assert.deepEqual([rowOut.data[0], rowOut.data[4]], [85, 85])
  assert.deepEqual([colOut.data[0], colOut.data[4]], [85, 85])
  const square = image(3, 3, (x, y) => [x === 1 && y === 1 ? 252 : 0, 0, 0])
  const out = resample(square, 0, 0, 3, 3, 2, 2)
  assert.deepEqual([out.data[0], out.data[4], out.data[8], out.data[12]], [28, 28, 28, 28])
})

test('enlarging a one-pixel crop never samples neighbours outside that crop', () => {
  const src = image(3, 3, (x, y) => x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0])
  const out = resample(src, 1, 1, 1, 1, 8, 8)
  assert.ok(out.data.every(v => v === 255))
})

test('probe exposes every delivery layout control and requires a full source PNG', () => {
  assert.deepEqual(makeProbeTool().parameters, makeCompoundEyeTool().parameters)
  assert.doesNotMatch(makeProbeTool().parameters.image.description, /Only the header/)
})

test('invalid layouts are reported by probe and rejected before any image is persisted', async () => {
  const { exec, saved } = executor()
  const args = { image: input(image(10, 10, () => [0, 0, 0])), tiles: [
    { x: 0, y: 0, w: 5, h: 5 }, { x: 20, y: 0, w: 5, h: 5 },
  ] }
  const preview = await exec.probe(args)
  assert.equal(preview.report.ok, false)
  assert.ok(preview.tiles.every(t => t.delivered === null))
  await assert.rejects(exec.run(args), /Nothing was delivered/)
  assert.equal(saved.length, 0)
})
