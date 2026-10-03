import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const root = new URL('./', import.meta.url)
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const truth = read('truth.json')
const median = values => {
  const s = values.slice().sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2 : null
}
const summaries = [], points = []
for (const arm of ['native', 'downscaled', 'tiled']) {
  const manifest = read(`${arm}/manifest.json`)
  const images = new Map(manifest.images.map(t => [basename(t.path), t]))
  const items = read(`${arm}/answers.json`).items
  if (items.length !== truth.targets.length || new Set(items.map(a => a.code)).size !== items.length) {
    throw new Error(`${arm}: missing or duplicate answers`)
  }
  const answers = new Map(items.map(a => [a.code, a]))
  const rows = truth.targets.map(t => {
    const a = answers.get(t.code)
    if (!a) throw new Error(`${arm}: missing ${t.code}`)
    const row = { arm, code: t.code, kind: t.kind, errorPx: null, strictHit: false }
    if (a.image == null) return row
    if (!images.has(a.image) || ![a.u, a.v].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new Error(`${arm}: invalid coordinate or image for ${t.code}`)
    }
    const s = images.get(a.image).source
    const x = s.x + a.u * s.w, y = s.y + a.v * s.h
    const [tx, ty, tw, th] = t.rect
    row.predicted = [x, y]
    row.clickedInteger = [Math.round(x), Math.round(y)]
    row.errorPx = Math.hypot(x-t.center[0], y-t.center[1])
    row.strictHit = row.clickedInteger[0] >= tx && row.clickedInteger[0] < tx+tw
      && row.clickedInteger[1] >= ty && row.clickedInteger[1] < ty+th
    return row
  })
  points.push(...rows)
  for (const kind of ['button', 'tiny_edge']) {
    const subset = rows.filter(r => r.kind === kind)
    const errors = subset.map(r => r.errorPx).filter(e => e !== null)
    const summary = { arm, kind, n: subset.length, reported: errors.length,
      hits: subset.filter(r => r.strictHit).length, medianErrorPx: median(errors) }
    summaries.push(summary)
    if (!process.argv.includes('--json')) {
      console.log(`${arm.padEnd(10)} ${kind.padEnd(10)} hits ${summary.hits}/${summary.n}, median ${summary.medianErrorPx?.toFixed(3)} px`)
    }
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ summaries, points }, null, 2))

if (process.argv.includes('--check')) {
  const expected = { native: [8, 7], downscaled: [8, 0], tiled: [8, 7] }
  for (const s of summaries) {
    if (s.hits !== expected[s.arm][s.kind === 'button' ? 0 : 1]) throw new Error(`Archived result changed: ${s.arm} ${s.kind}`)
  }
  console.log('OK: all six archived Luna hit counts reproduce.')
}
