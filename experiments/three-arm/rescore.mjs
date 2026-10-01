/**
 * Reproduce the published three-arm numbers from the material in this directory.
 *
 *   node rescore.mjs            print the table
 *   node rescore.mjs --check    print it and FAIL if it no longer matches the published figures
 *
 * Inputs (all in this repository, nothing else):
 *   ../truth.json            the 36 ground-truth labels and the 16 source rectangles
 *   answers/registry.json    which session is which arm  (identity derived from read_image paths,
 *                            NOT from filenames -- all three arms use identical filenames)
 *   answers/*.txt            the final answer of each run, extracted verbatim from its session
 *
 * The sessions themselves are not shipped (they are large and contain the full prompts), so this file
 * is the in-repo reproduction path. `as-run/score-runs.mjs` is the script that produced the published
 * numbers directly from the sessions; the two agree on every per-run figure.
 *
 * Two axes are reported separately on purpose: WHERE (did a report land near a true label) and WHAT
 * (was the code read correctly there). Collapsing them hides the finding.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const truth = JSON.parse(readFileSync(join(HERE, '..', 'truth.json'), 'utf8').replace(/^\uFEFF/, ''))
const registry = JSON.parse(readFileSync(join(HERE, 'answers', 'registry.json'), 'utf8'))
const T = truth.labels
const byCode = new Map(T.map(l => [l.code, l]))
const RECT = new Map(truth.tiles.filter(t => t.level === 5).map(t => [t.file, { x: t.gx, y: t.gy, w: t.gw, h: t.gh }]))

const IN_RANGE = 60          // px; the closest two true labels are 203.8px apart, so one report gates at most one label
const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const posOf = (file, u, v) => { const r = RECT.get(file); return r ? { x: r.x + u * r.w, y: r.y + v * r.h } : null }
const nearest = p => { let best = null, bd = Infinity; for (const t of T) { const d = dist(p, t); if (d < bd) { bd = d; best = t } } return { t: best, d: bd } }

function parse(text) {
  const obs = [], unc = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    let m = t.match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
    if (m) { obs.push({ file: m[1].trim().split(/[\\/]/).pop(), code: m[2].toUpperCase(), u: +m[3], v: +m[4] }); continue }
    m = t.match(/^UNCERTAIN:\s*([^|]*)\|\s*u=([0-9.]+)\s+v=([0-9.]+)\s*\|\s*([A-Za-z0-9]{3})?/i)
    if (m) unc.push({ file: m[1].trim().split(/[\\/]/).pop(), u: +m[2], v: +m[3], code: (m[4] || '').toUpperCase() })
  }
  return { obs, unc }
}

const rows = []
for (const R of registry.runs) {
  if (!R.observed) {
    rows.push({ ...R, reported: 0, abstain: 0, hits: 0, recall: 0, precision: 0, inPos: 0, rightInPos: 0, posCov60: 0, posCov40: 0, medNear: null, medHitErr: null, strays: 0, misreadMedian: null })
    continue
  }
  const text = readFileSync(join(HERE, 'answers', R.s + '.txt'), 'utf8')
  const { obs, unc } = parse(text)
  const P = obs.map(o => ({ ...o, p: posOf(o.file, o.u, o.v) })).filter(o => o.p)

  const hitCodes = new Set(), hitErrs = [], misreadDists = []
  let inPos = 0, rightInPos = 0, strays = 0
  for (const o of P) {
    const n = nearest(o.p)
    if (n.d <= IN_RANGE) {
      inPos++
      if (o.code === n.t.code) rightInPos++
      else misreadDists.push(n.d)
    } else strays++
    if (byCode.has(o.code) && !hitCodes.has(o.code)) { hitCodes.add(o.code); hitErrs.push(dist(o.p, byCode.get(o.code))) }
  }
  const near = T.map(t => { let bd = Infinity; for (const o of P) { const d = dist(o.p, t); if (d < bd) bd = d } return bd })
  rows.push({
    ...R, reported: P.length, abstain: unc.length, hits: hitCodes.size,
    recall: hitCodes.size / T.length, precision: P.length ? hitCodes.size / P.length : 0,
    inPos, rightInPos, posCov60: near.filter(d => d <= IN_RANGE).length, posCov40: near.filter(d => d <= 40).length,
    medNear: MED(near), medHitErr: MED(hitErrs), strays, misreadMedian: MED(misreadDists),
  })
}

const pct = x => (x * 100).toFixed(1) + '%'
console.log('Per run (arm identity from read_image paths, never from filenames)\n')
console.log('arm           run       delivered    note                                              reported abstain hits recall  precision  inPos  cond.read  posCov60  medNear  medHitErr strays')
for (const r of rows) {
  console.log(
    String(r.arm).padEnd(14) + r.s.padEnd(10) + String(r.delivered ?? '-').padEnd(13) +
    String(r.note).slice(0, 48).padEnd(50) +
    String(r.reported).padStart(6) + String(r.abstain).padStart(8) + String(r.hits).padStart(5) +
    pct(r.recall).padStart(7) + pct(r.precision).padStart(11) +
    String(r.inPos).padStart(7) + (r.inPos ? pct(r.rightInPos / r.inPos) : '-').padStart(11) +
    `${r.posCov60}/36`.padStart(10) +
    (r.medNear === null ? '-' : r.medNear.toFixed(1) + 'px').padStart(9) +
    (r.medHitErr === null ? '-' : r.medHitErr.toFixed(1) + 'px').padStart(11) +
    String(r.strays).padStart(7))
}

// ---- the three framings, because the same comparison answers differently under each ----
const erf = x => { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const t = 1 / (1 + p * x); return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)) }
const twoSided = z => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))
function twoProp(h1, n1, h2, n2) {
  const p1 = h1 / n1, p2 = h2 / n2, p = (h1 + h2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  const z = se ? (p1 - p2) / se : 0
  return { p1, p2, diff: p1 - p2, se, z, p: twoSided(z) }
}
const pool = g => ({ h: g.reduce((s, r) => s + r.hits, 0), n: g.length * 36 })
const of = (list, a) => list.filter(r => r.arm === a)
const withDelivered = rows.filter(r => r.observed)
const cleanOnly = withDelivered.filter(r => !/non-existent/.test(r.note))

for (const [title, list, note] of [
  ['A: every run pooled', withDelivered, 'each run counts as one reading; arms have 1 / 2 / 3 runs, so the arm with more runs weighs more'],
  ['B: only runs that never read a non-existent path', cleanOnly, 'stricter, not more correct: a failed read wastes a step but injects no wrong content'],
]) {
  console.log(`\n${title}\n  (${note})`)
  console.log('  comparison                  hits/sample        recall                delta     SE      z       p(two-sided)')
  for (const [a, b] of [['naive', 'down-then-up'], ['naive', 'down-only'], ['down-only', 'down-then-up']]) {
    const A = of(list, a), B = of(list, b)
    if (!A.length || !B.length) { console.log(`  ${a} vs ${b}: no runs in this framing`); continue }
    const x = pool(A), y = pool(B), t = twoProp(x.h, x.n, y.h, y.n)
    console.log(`  ${(a + ' vs ' + b).padEnd(28)}${(x.h + '/' + x.n + ' vs ' + y.h + '/' + y.n).padEnd(19)}` +
      `${(pct(t.p1) + ' vs ' + pct(t.p2)).padEnd(22)}${((t.diff * 100).toFixed(1) + ' pts').padStart(7)}` +
      `${(t.se * 100).toFixed(1).padStart(9)}${t.z.toFixed(2).padStart(8)}${(t.p < 0.0001 ? '<0.0001' : t.p.toFixed(4)).padStart(14)}`)
  }
}

console.log('\nC: paired within a round (completion order)')
const doR = of(withDelivered, 'down-only'), dtuR = of(withDelivered, 'down-then-up')
console.log(`  round 1: down-only ${pct(doR[0].recall)} vs down-then-up ${pct(dtuR[0].recall)}  ->  +${((doR[0].recall - dtuR[0].recall) * 100).toFixed(1)} pts`)
console.log(`  round 2: down-only ${pct(doR[1].recall)} vs down-then-up ${pct(dtuR[1].recall)}  ->  +${((doR[1].recall - dtuR[1].recall) * 100).toFixed(1)} pts`)
console.log('  NOTE: pairing by completion order is not the only defensible pairing. Pairing by PROMPT')
console.log('        GENERATION gives +2.8 and +16.7 instead (5d09771c belongs to the earlier, no-file-list')
console.log('        prompt), so the paired framing is not independent evidence. Sign test n=2 -> p=0.50.')

console.log('\nWARNING: every p above is ANTI-CONSERVATIVE. The 36 labels are treated as independent')
console.log('    samples but come from 1-3 runs each, and the naive arm has a single run (pseudoreplication).')
console.log('    At run level this design has almost no power (a 2 vs 3 permutation floor is ~0.20).')
console.log('    Use the run-by-run separation as the evidence: naive 97.2% against every downsampled')
console.log('    run at 22.2-50.0%. That is 47-75 points, versus a within-arm drift of at most 13.9.')

// ---- --check: lock the PUBLISHED figures to this material, so the reproduction path cannot rot ----
// Without this, the shipped answers or truth.json could drift and the archive would keep printing
// something plausible that no longer matches the paper. CI runs this.
if (process.argv.includes('--check')) {
  const EXPECT = {
    '7ced3634': { reported: 36, abstain: 2, hits: 35, inPos: 36, rightInPos: 35, posCov60: 36, strays: 0, medHitErr: 6.5 },
    '0ebbb2b2': { reported: 34, abstain: 2, hits: 14, inPos: 31, rightInPos: 13, posCov60: 31, strays: 3, medHitErr: 3.3 },
    '9a322102': { reported: 34, abstain: 2, hits: 18, inPos: 34, rightInPos: 18, posCov60: 34, strays: 0, medHitErr: 3.3 },
    '63036c9a': { reported: 32, abstain: 5, hits: 8, inPos: 32, rightInPos: 8, posCov60: 32, strays: 0, medHitErr: 3.9 },
    'e134da0e': { reported: 24, abstain: 14, hits: 12, inPos: 24, rightInPos: 12, posCov60: 24, strays: 0, medHitErr: 4.6 },
    '5d09771c': { reported: 34, abstain: 2, hits: 13, inPos: 34, rightInPos: 13, posCov60: 34, strays: 0, medHitErr: 2.4 },
    'a9cdcf16': { reported: 0, abstain: 0, hits: 0 },
  }
  const EXPECTED_Z = {
    'A:naive|down-then-up': 6.94, 'A:naive|down-only': 5.33, 'A:down-only|down-then-up': 1.90,
    'B:naive|down-then-up': 6.81, 'B:naive|down-only': 5.33, 'B:down-only|down-then-up': 2.08,
  }
  const bad = []
  for (const r of rows) {
    const e = EXPECT[r.s]
    if (!e) { bad.push(`${r.s}: not in the expected set`); continue }
    for (const [k, v] of Object.entries(e)) {
      const got = r[k]
      const isFractional = typeof v === 'number' && v % 1 !== 0
      if (!(isFractional ? Math.abs(got - v) < 0.05 : got === v)) bad.push(`${r.s} ${k}: expected ${v}, got ${got}`)
    }
  }
  for (const [tag, list] of [['A', withDelivered], ['B', cleanOnly]]) {
    for (const [a, b] of [['naive', 'down-then-up'], ['naive', 'down-only'], ['down-only', 'down-then-up']]) {
      const A = of(list, a), B = of(list, b)
      if (!A.length || !B.length) continue
      const x = pool(A), y = pool(B)
      const want = EXPECTED_Z[`${tag}:${a}|${b}`]
      const got = +twoProp(x.h, x.n, y.h, y.n).z.toFixed(2)
      if (want !== undefined && Math.abs(got - want) > 0.005) bad.push(`${tag} ${a} vs ${b}: expected z=${want}, got z=${got}`)
    }
  }
  if (bad.length) {
    console.log(`\nFAILED --check: this material no longer reproduces the published figures (${bad.length} mismatch(es)):`)
    for (const b of bad) console.log('   ' + b)
    process.exit(1)
  }
  console.log(`\nOK --check passed: all ${Object.keys(EXPECT).length} runs and ${Object.keys(EXPECTED_Z).length} pooled z-values match the published table.`)
}
