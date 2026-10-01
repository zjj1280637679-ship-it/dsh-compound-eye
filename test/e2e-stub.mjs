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
  // The two scales must be told apart in words as well as in numbers: "0.408x of native" used to be
  // ambiguous between "of the source file's pixels" and "of the pixels the screen once had". The measured
  // gap between those two readings is 97.2% vs 44.4%, so a caption that blurs them misleads the reader.
  ok(a.tiles.every(t => t.enlarged === false), 'default never marks a tile as enlarged')
  ok(a.tiles.every(t => /source px 1:1/.test(t.caption)), 'native captions say "source px 1:1", not "of native"')
  ok(b.tiles.every(t => t.enlarged === true), '"max" marks every tile as enlarged')
  ok(b.tiles.every(t => /ENLARGED from \d+x\d+ source px/.test(t.caption)),
    'enlarged captions name the source size they were enlarged from',
    b.tiles[0].caption)
  ok(!/of native/.test(b.tiles[0].caption), 'the ambiguous phrase "of native" is gone')
  ok(/ENLARGED by interpolation/.test(b.result), 'the result warns that enlargement is interpolation')
  ok(!/ENLARGED by interpolation/.test(a.result), 'the native path carries no such warning (no false alarm)')
}

console.log('\n3) Nothing is pruned in advance: the request is delivered, the size is reported')
{
  // The plugin used to reduce an over-cap depth and to REFUSE an over-cap manual layout. Both decide for
  // the caller, and the caller is a model in conditions the plugin cannot see -- a bigger budget, a
  // different consumer for the images, a reason that only exists at call time. A refusal also costs
  // another STEP, and a step resends the whole context. So `maxTiles` is now advisory: ask for 64 and
  // you get 64, with a note about the size; the only ceiling left is a physical one (hardMaxTiles).
  const store = stubAttachments()
  const exec = createExecutor({ ctx: ctxFor(store), cfg: { deliveryMaxEdge: 1568, maxTiles: 4 } })
  const r = await exec.run({ image: { path: SRC }, depth: 6 })
  ok(r.tiles.length === 64, `depth 6 delivers the 64 tiles that were asked for, above the advisory 4 (got ${r.tiles.length})`)
  ok(r.report.depth === 6 && r.report.cappedFrom === null,
    'and the report says depth 6 was delivered, with no cap reduction',
    `depth=${r.report.depth} cappedFrom=${r.report.cappedFrom}`)
  ok(store.saved.length === 64, 'one call, 64 images persisted -- the size of the request is the caller\'s call')
  ok(/NOTE ON SIZE/.test(r.result) && /advisory threshold is 4/.test(r.result),
    'and the result explains the size instead of quietly trimming it')
  ok(/Nothing was trimmed/.test(r.result) && /compound_eye_probe/.test(r.result),
    'and points at the zero-image way to plan the same layout if 64 was not the intent')

  // A manual layout above the advisory threshold is delivered too: the caller NAMED those rectangles, so
  // dropping any of them would change what was asked for, and there is no principled way to choose which.
  const store2 = stubAttachments()
  const exec2 = createExecutor({ ctx: ctxFor(store2), cfg: { deliveryMaxEdge: 1568, maxTiles: 2 } })
  const r2 = await exec2.run({
    image: { path: SRC },
    tiles: [{ x: 0, y: 0, w: 480, h: 540 }, { x: 480, y: 0, w: 480, h: 540 },
            { x: 0, y: 270, w: 480, h: 270 }, { x: 480, y: 270, w: 480, h: 270 }],
  })
  ok(r2.tiles.length === 4, 'an over-threshold manual layout is delivered, not refused')
  ok(store2.saved.length === 4, 'and all four of its images are persisted')
  ok(/NOTE ON SIZE/.test(r2.result), 'with the same size note')

  // The ONE ceiling left is physical, and it is the operator's (hardMaxTiles), not a taste about layouts.
  const store5 = stubAttachments()
  const exec5 = createExecutor({ ctx: ctxFor(store5), cfg: { deliveryMaxEdge: 1568, maxTiles: 4, hardMaxTiles: 8 } })
  let msg5 = ''
  try { await exec5.run({ image: { path: SRC }, depth: 6 }) } catch (e) { msg5 = e.message }
  ok(/exceeds what one call can return/.test(msg5) && /physical\/context bound/.test(msg5),
    'the physical bound still refuses, and says it is a resource bound rather than a rule about your layout', msg5)
  ok(store5.saved.length === 0, 'and nothing is persisted when that bound is hit')

  // A PARTIAL manual layout is the opposite case: the caller is deliberately delivering only the regions
  // it cares about, so it must be DELIVERED (refusing would cost a step and force the caller to pad the
  // layout with tiles it does not want) -- but the result has to name what was left out, because a layout
  // that silently drops a region is the one failure mode that actually matters.
  const store3 = stubAttachments()
  const exec3 = createExecutor({ ctx: ctxFor(store3), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const partial = await exec3.run({
    image: { path: SRC },
    tiles: [{ x: 0, y: 0, w: 480, h: 270 }, { x: 480, y: 0, w: 480, h: 270 }],
  })
  ok(partial.tiles.length === 2, 'a partial manual layout is delivered, not refused')
  ok(store3.saved.length === 2, 'and its two images are persisted')
  ok(/PARTIAL delivery/.test(partial.result) && /NOT delivered/.test(partial.result),
    'and the result says plainly that part of the frame is not delivered', partial.result.split('\n').find(l => /PARTIAL/.test(l)))
  ok(/x=\d+ y=\d+ w=\d+ h=\d+/.test(partial.result), 'naming the uncovered rectangles rather than only a percentage')
  ok(/add tiles for them/.test(partial.result), 'and telling the caller what to do about it')

  // An overlapping layout is the third case, and it is how you keep a target whole across a seam.
  const store4 = stubAttachments()
  const exec4 = createExecutor({ ctx: ctxFor(store4), cfg: { deliveryMaxEdge: 1568, maxTiles: 64 } })
  const over = await exec4.run({
    image: { path: SRC },
    tiles: [{ x: 0, y: 0, w: 540, h: 540 }, { x: 420, y: 0, w: 540, h: 540 }],
  })
  ok(over.tiles.length === 2 && /overlap/.test(over.result),
    'an overlapping layout is delivered and its overlap is described', over.result.split('\n')[0])

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
