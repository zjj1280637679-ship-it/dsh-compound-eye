import assert from 'node:assert/strict'
import test from 'node:test'
import { planGrid } from '../lib/grid.js'

test('a whole target in an overlapping manual tile remains protected', () => {
  const target = { x: 35, y: 10, w: 10, h: 10, label: 'button' }
  const { report } = planGrid({ width: 100, height: 100 }, 0, [target], {
    tiles: [{ x: 0, y: 0, w: 60, h: 100 }, { x: 40, y: 0, w: 60, h: 100 }],
  })
  assert.equal(report.feasible, true)
  assert.equal(report.infeasible, false)
  assert.deepEqual(report.unprotected, [])
  assert.deepEqual(report.straddling, [])
})

test('an extra region protects a target split by the requested grid', () => {
  const target = { x: 0, y: 10, w: 100, h: 10, label: 'toolbar' }
  const { report, tiles } = planGrid({ width: 100, height: 100 }, 1, [target], {
    rows: 1, cols: 2, placement: 'even',
    tiles: [{ x: -10, y: 5, w: 120, h: 20 }],
  })
  assert.equal(tiles.length, 3)
  assert.equal(report.gridTiles, 2)
  assert.equal(report.extraTiles, 1)
  assert.equal(report.clipped.length, 1)
  assert.equal(report.feasible, true)
  assert.deepEqual(report.unprotected, [])
  assert.deepEqual(report.straddling, [])
  assert.equal(report.reason, null)
})

test('a depth request can cut the other axis around a full-width banner', () => {
  const target = { x: 0, y: 0, w: 100, h: 10, label: 'banner' }
  const { report, tiles } = planGrid({ width: 100, height: 50 }, 1, [target])
  assert.equal(tiles.length, 2)
  assert.equal(report.feasible, true)
  assert.deepEqual(report.unprotected, [])
  assert.deepEqual(report.straddling, [])
  assert.ok(tiles.every(tile => tile.x === 0 && tile.w === 100))
  assert.equal(tiles.reduce((area, tile) => area + tile.w * tile.h, 0), 5000)
  assert.equal(report.shape, 'cartesian')
  assert.equal(report.cols, 1)
  assert.equal(report.rows, 2)
  assert.equal(report.nominalCols, 2)
  assert.equal(report.nominalRows, 1)
})

test('a non-Cartesian target partition does not claim nominal rows and columns', () => {
  const { report, tiles } = planGrid({ width: 100, height: 50 }, 2,
    [{ x: 5, y: 5, w: 5, h: 5, label: 'small-button' }], { rows: 2, cols: 2 })
  assert.equal(tiles.length, 4)
  assert.equal(report.feasible, true)
  assert.equal(report.shape, 'partition')
  assert.equal(report.cols, null)
  assert.equal(report.rows, null)
  assert.equal(report.nominalCols, 2)
  assert.equal(report.nominalRows, 2)
})

test('no-target fan-out and explicit rows/cols keep their existing geometry', () => {
  const viewport = { width: 100, height: 50 }
  const expected = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 50 }]
  assert.deepEqual(planGrid(viewport, 1).tiles, expected)
  const explicit = planGrid(viewport, 1, [{ x: 0, y: 0, w: 100, h: 10, label: 'banner' }], {
    rows: 1, cols: 2,
  })
  assert.deepEqual(explicit.tiles, expected)
  assert.equal(explicit.report.feasible, false)
  assert.match(explicit.report.reason, /chosen layout/)
  assert.doesNotMatch(explicit.report.reason, /no cut placement/)
})

test('a clipped rectangle cannot protect a target outside the source image', () => {
  const viewport = { width: 100, height: 100 }
  const target = { x: -10, y: 10, w: 20, h: 10, label: 'outside-source' }
  const extra = { x: -20, y: 0, w: 60, h: 100 }
  for (const depth of [0, 1]) {
    const { report } = planGrid(viewport, depth, [target], { tiles: [extra] })
    assert.equal(report.ok, true)
    assert.equal(report.feasible, false)
    assert.equal(report.infeasible, true)
    assert.deepEqual(report.unprotected, ['outside-source'])
  }
})

test('a partial tile edge does not extend through unrelated target regions', () => {
  const target = { x: 35, y: 70, w: 10, h: 10, label: 'unseen' }
  const { report } = planGrid({ width: 100, height: 100 }, 0, [target], {
    tiles: [{ x: 40, y: 0, w: 60, h: 20 }],
  })
  assert.equal(report.feasible, false)
  assert.deepEqual(report.unprotected, ['unseen'])
  assert.deepEqual(report.straddling, [])
})
