/**
 * 跨模型复现实验：评分器
 *
 * 输入：把各臂的原始输出落盘为 D:\deepseek\.tmp\xmodel\out\<run>.txt
 * 输出：每臂 命中/精确/召回/误差，以及**隔离完整性检查**（有没有越界读到别的目录）
 *
 * 尺度映射只在本文件 + make-runs.ps1 里，绝不进读图者的上下文。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const BASE = 'D:/deepseek/.tmp/xmodel/'
const OUT = BASE + 'out/'
const TRUTH = JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json', 'utf8').replace(/^\uFEFF/, ''))

// 与 make-runs.ps1 完全一致的排序：L5_00 .. L5_15 -> img01 .. img16
const L5 = TRUTH.tiles.filter(t => t.level === 5).sort((a, b) => a.file.localeCompare(b.file))
const RECT = new Map()
L5.forEach((t, i) => RECT.set('img' + String(i + 1).padStart(2, '0') + '.png', { x: t.gx, y: t.gy, w: t.gw, h: t.gh }))

// 每臂的目标交付长边（= 处理变量）；960 为原生
const SCALE = { r1: 960, r2: 1568, r3: 960, r4: 1568, r5: 2880 }

const byCode = new Map(TRUTH.labels.map(l => [l.code, l]))
const ALL = [...byCode.keys()]
const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const files = existsSync(OUT) ? readdirSync(OUT).filter(f => /\.txt$/i.test(f)).sort() : []
if (!files.length) { console.error(`还没有输出文件：${OUT}`); process.exit(1) }

const rows = []
for (const f of files) {
  const run = f.replace(/\.txt$/i, '')
  const txt = readFileSync(OUT + f, 'utf8')
  const obs = []
  const leaks = []
  const sizeClaims = []
  const notMyDir = []
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim()
    const mSize = line.match(/^IMAGE_SIZES?:\s*(.+)$/i)
    if (mSize) sizeClaims.push(...mSize[1].split(';').map(s => s.trim()).filter(Boolean))
    if (!/^OBSERVED:/i.test(line) && !/^UNCERTAIN:/i.test(line)) continue
    const parts = line.replace(/^(OBSERVED|UNCERTAIN):\s*/i, '').split('|').map(s => s.trim())
    if (parts.length < 2) continue
    const file = parts[0]
    const base = file.split(/[\\/]/).pop()
    // 隔离检查：路径里出现别的 run 目录名，就是越界
    for (const other of Object.keys(SCALE)) {
      if (other !== run && new RegExp(`[\\\\/]${other}[\\\\/]`, 'i').test(file)) leaks.push(line)
    }
    if (/^OBSERVED:/i.test(line)) {
      if (!RECT.has(base)) notMyDir.push(base)
      const code = parts[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase()
      const uv = parts.slice(2).join(' ')
      const mu = uv.match(/u\s*=\s*([0-9.]+)/i), mv = uv.match(/v\s*=\s*([0-9.]+)/i)
      obs.push({ base, code, u: mu ? +mu[1] : null, v: mv ? +mv[1] : null })
    }
  }
  let hit = 0, wrong = 0, unmapped = 0
  const dists = [], seen = new Set()
  for (const o of obs) {
    const r = RECT.get(o.base)
    if (!r || o.u === null || o.v === null) { unmapped++; continue }
    const t = byCode.get(o.code)
    if (!t) { wrong++; continue }
    if (seen.has(o.code)) continue
    seen.add(o.code); hit++
    dists.push(Math.hypot(r.x + o.u * r.w - t.x, r.y + o.v * r.h - t.y))
  }
  const target = SCALE[run] ?? null
  const up = target && target !== 960 ? (target / 960) : 1
  rows.push({
    run, target, up, reported: obs.length, hit, wrong, unmapped,
    precision: obs.length ? hit / obs.length : 0,
    recall: hit / ALL.length,
    medianErr: MED(dists),
    maxErr: dists.length ? Math.max(...dists) : null,
    mapped: dists.length,
    leaks: leaks.length, notMyDir: [...new Set(notMyDir)],
    sizeClaims: [...new Set(sizeClaims)],
    misses: ALL.filter(c => !seen.has(c)),
  })
}

const pad = (s, n) => String(s).padEnd(n)
console.log('臂   目标长边  放大   报出  命中  精确率   召回    误差中位  最大误差  映射  越界读取  未知文件名')
for (const r of rows) {
  console.log(
    pad(r.run, 5) + pad(String(r.target ?? '?'), 10) + pad(r.up ? r.up.toFixed(3) + 'x' : '1.000x', 7) +
    pad(String(r.reported), 6) + pad(String(r.hit), 6) +
    pad((r.precision * 100).toFixed(1) + '%', 9) + pad((r.recall * 100).toFixed(1) + '%', 8) +
    pad(r.medianErr === null ? '-' : r.medianErr.toFixed(1) + 'px', 10) +
    pad(r.maxErr === null ? '-' : r.maxErr.toFixed(1) + 'px', 10) +
    pad(String(r.mapped), 6) + pad(String(r.leaks) + (r.leaks ? ' ⚠️' : ''), 10) +
    (r.notMyDir.length ? '⚠️ ' + r.notMyDir.join(',') : 'ok')
  )
}

console.log('\n各臂声明的图片尺寸（子代理自述，用于与真实尺寸对照）:')
for (const r of rows) console.log(`  ${r.run}: ${r.sizeClaims.length ? r.sizeClaims.join(' | ') : '(未声明)'}`)

console.log('\n各臂漏检:')
for (const r of rows) console.log(`  ${r.run}: ${r.misses.length} 个  ${r.misses.join(' ')}`)

// 按放大倍率聚合（重复臂取并集看看）
const grp = {}
for (const r of rows) { const k = r.up.toFixed(3); (grp[k] = grp[k] || []).push(r) }
console.log('\n按放大倍率聚合:')
for (const k of Object.keys(grp).sort()) {
  const g = grp[k]
  const rec = g.map(r => (r.recall * 100).toFixed(1) + '%').join(', ')
  const pre = g.map(r => (r.precision * 100).toFixed(1) + '%').join(', ')
  console.log(`  ${k}x  (n=${g.length}):  召回 [${rec}]   精确 [${pre}]   命中 ${g.map(r => r.hit).join('/')}`)
}
