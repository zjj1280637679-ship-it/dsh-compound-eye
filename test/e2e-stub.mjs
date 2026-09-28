/**
 * End-to-end test with a stub attachments service: exercises the real delivery path
 * (plan -> resample -> encode -> save -> image block) without a live host.
 *
 *   node test/e2e-stub.mjs
 *
 * What it CAN prove here: the tool body runs, the declared output schema is satisfied, every tile is a
 * decodable PNG of the announced size, captions carry the source rectangle, and the continuity
 * guarantee holds against the real measured label boxes from the experiment materials.
 *
 * What it CANNOT prove: how the host or a model treats the images. That needs a live session.
 */
import { decodePng, pngSize } from '../lib/png.js'
import { createExecutor } from '../lib/eye.js'
import { readFileSync, existsSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`) }
}

/** Stub attachments service: records what was saved and hands back a plausible ref. */
function stubAttachments() {
  const saved = []
  return {
    saved,
    api: {
      async saveImage({ data, mediaType, name }) {
        saved.push({ data, mediaType, name })
        return { image: { attachmentId: `att_${saved.length}`, mediaType, bytes: data.length, name } }
      },
    },
  }
}
const ctxFor = (store) => ({ get: (k) => (k === 'attachments' ? store.api : undefined) })

const SRC = 'D:/deepseek/.tmp/attn-exp/tiles/L5_00_x0_y0_w960_h540.png'
if (!existsSync(SRC)) {
  console.log('skip: measured sample not present on this machine')
  process.exit(0)
}

/** The real label boxes from the experiment truth, expressed against this 960x540 tile. */
const truth = JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json', 'utf8').replace(/^\uFEFF/, ''))
const tile = truth.tiles.filter(t => t.level === 5).sort((a, b) => a.file.localeCompare(b.file))[0]
const labelBox = l => ({ x: l.x - tile.gx, y: l.y - tile.gy, w: 58, h: 24, label: l.code })
const onTile = truth.labels.filter(l =>
  l.x >= tile.gx && l.x < tile.gx + tile.gw && l.y >= tile.gy && l.y < tile.gy + tile.gh).map(labelBox)
// A box that runs past the tile edge CANNOT be protected inside this tile -- it is split by the
// capture, not by our cut. Only fully-contained boxes are declarable targets; the rest are reported
// so the test does not quietly demand the impossible (an earlier version of this test did).
const labelsOnTile = onTile.filter(l => l.x >= 0 && l.x + l.w <= tile.gw && l.y >= 0 && l.y + l.h <= tile.gh)
const partlyOutside = onTile.filter(l => !labelsOnTile.includes(l)).map(l => l.label)

console.log(`source tile ${tile.file} (${tile.gw}x${tile.gh}); protectable labels: ${labelsOnTile.map(l => l.label).join(' ') || '(none)'}`
  + (partlyOutside.length ? `; cut by the capture itself, not declared: ${partlyOutside.join(' ')}` : ''))

console.log('\n1) Full delivery path with a stub attachments service')
{
  const store = stubAttachments()
  const exec = createExecutor({ ctx: ctxFor(store), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const out = await exec.run({ image: { path: SRC }, depth: 2, targets: labelsOnTile })
  ok(out.tiles.length === 4, `depth 2 delivered 4 tiles (got ${out.tiles.length})`)
  ok(store.saved.length === 4, 'every tile was persisted exactly once')
  ok(out.result.includes('source'), 'the text result names the source and its size')
  let allPng = true, sizeMatch = true
  for (const t of out.tiles) {
    const saved = store.saved[t.index]
    if (!saved) { allPng = false; continue }
    const head = pngSize(saved.data)
    if (head.w !== t.delivered.w || head.h !== t.delivered.h) sizeMatch = false
    try { decodePng(saved.data) } catch { allPng = false }
  }
  ok(allPng, 'every delivered tile is a decodable PNG')
  ok(sizeMatch, 'the announced delivered size equals the real PNG header size')
  ok(out.tiles.every(t => t.attachmentId && t.mediaType === 'image/png' && t.bytes > 0),
    'each tile carries attachmentId / mediaType / bytes (the image block inputs)')
  ok(out.tiles.every(t => /x=\d+ y=\d+ w=\d+ h=\d+/.test(t.caption)),
    'each caption carries the source rectangle (so the coordinate contract needs no legend)')
  ok(out.report.infeasible === false, 'with the real labels declared at depth 2, no target straddles a cut')

  // Continuity checked against the returned tiles, not against the planner's own report.
  const strad = labelsOnTile.filter(l => !out.tiles.some(t =>
    l.x >= t.source.x && l.x + l.w <= t.source.x + t.source.w &&
    l.y >= t.source.y && l.y + l.h <= t.source.y + t.source.h))
  ok(strad.length === 0, 'every real label is whole inside at least one DELIVERED tile',
    strad.map(s => s.label).join(','))
}

console.log('\n2) native default vs upscale:"max" (the delivery-scale knob, observed at the tool boundary)')
{
  const storeA = stubAttachments(), storeB = stubAttachments()
  const execA = createExecutor({ ctx: ctxFor(storeA), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const execB = createExecutor({ ctx: ctxFor(storeB), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const a = await execA.run({ image: { path: SRC }, depth: 2 })
  const b = await execB.run({ image: { path: SRC }, depth: 2, upscale: 'max' })
  // depth 2 on a 960x540 frame -> 480x270 tiles; "max" raises the long edge to 1568.
  ok(a.tiles[0].delivered.scale === 1, 'default leaves the tile at native scale', String(a.tiles[0].delivered.scale))
  ok(b.tiles[0].delivered.w > a.tiles[0].delivered.w, '"max" delivers more pixels than native',
    `${a.tiles[0].delivered.w} -> ${b.tiles[0].delivered.w}`)
  ok(b.tiles[0].bytes > a.tiles[0].bytes, 'and the enlargement is real bytes, not just a label')
}

console.log('\n3) Failures are named, and an over-cap REQUEST is reduced rather than refused')
{
  // An over-cap request must NOT be refused: in an agent loop a refusal costs another STEP, and a step
  // resends the whole context. The planner delivers the deepest split that fits and says so.
  const store = stubAttachments()
  const exec = createExecutor({ ctx: ctxFor(store), cfg: { deliveryMaxEdge: 1568, maxTiles: 4 } })
  const r = await exec.run({ image: { path: SRC }, depth: 6 })
  ok(r.tiles.length === 4, `depth 6 over a cap of 4 delivered 4 tiles, not an error (got ${r.tiles.length})`)
  ok(r.report.cappedFrom === 6 && r.report.depth === 2, 'and the report names the requested depth and the delivered one',
    `cappedFrom=${r.report.cappedFrom} depth=${r.report.depth}`)
  ok(store.saved.length === 4, 'exactly one call, four images persisted -- no retry step needed')

  // An over-cap MANUAL layout is different: it cannot be reduced without breaking the caller's own
  // rectangles, so it is refused BEFORE anything is persisted.
  const store2 = stubAttachments()
  const exec2 = createExecutor({ ctx: ctxFor(store2), cfg: { deliveryMaxEdge: 1568, maxTiles: 2 } })
  let msg = ''
  try {
    await exec2.run({
      image: { path: SRC },
      tiles: [{ x: 0, y: 0, w: 480, h: 540 }, { x: 480, y: 0, w: 480, h: 540 },
              { x: 0, y: 270, w: 480, h: 270 }, { x: 480, y: 270, w: 480, h: 270 }],
    })
  } catch (e) { msg = e.message }
  ok(/above the cap/.test(msg), 'an over-cap manual layout is refused with its reason', msg)
  ok(store2.saved.length === 0, 'and nothing was persisted before the refusal')

  const noAtt = createExecutor({ ctx: { get: () => undefined }, cfg: {} })
  let msg2 = ''
  try { await noAtt.run({ image: { path: SRC }, depth: 1 }) } catch (e) { msg2 = e.message }
  ok(/attachments service unavailable/.test(msg2), 'a missing attachments service is refused, not silently skipped', msg2)

  let msg3 = ''
  try { await exec.run({ image: { path: 'D:/definitely/not/here.png' }, depth: 1 }) } catch (e) { msg3 = e.message }
  ok(msg3.length > 0, 'a missing source file raises rather than returning an empty tile set')
}

console.log('\n4) probe delivers nothing')
{
  const store = stubAttachments()
  const exec = createExecutor({ ctx: ctxFor(store), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const p = await exec.probe({ image: { path: SRC }, depth: 3, targets: labelsOnTile })
  ok(store.saved.length === 0, 'probe persisted zero images')
  ok(p.tiles.length === 8, `probe reported 8 tiles for depth 3 (got ${p.tiles.length})`)
  ok(p.result.includes('Continuity OK') || p.result.includes('INFEASIBLE'), 'probe states the continuity verdict')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
