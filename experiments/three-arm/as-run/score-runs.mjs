/**
 * 运行级评分器（三臂实验的权威版本）
 *
 * 为什么重写：run-three-arm.mjs 只认 out/<臂>.txt，而那是"先到先得"的早期提取结果。
 * 20:13 前后又有三个会话交卷，且各臂自身有多次运行 —— 单次运行无法支撑任何结论。
 *
 * 身份判定不靠文件名（三臂文件名完全一样），靠会话里 read_image 的真实路径。
 * 由 audit-runs.mjs 实测得到下表的 臂 归属；readsReal/readsFake 也来自同一实测。
 *
 * 两条独立的轴，必须分开算：
 *   where —— 报出的位置离真值多近（位置覆盖 / 落点误差）
 *   what  —— 站在正确位置上，字符读对没有（命中率）
 * 只看命中率会把"定位准但读错"和"根本没找到"混成一件事。
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
const OUTDIR = 'D:/deepseek/.tmp/threearm/'
const truth = JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json', 'utf8').replace(/^\uFEFF/, ''))
const T = truth.labels
const byCode = new Map(T.map(l => [l.code, l]))
const RECT = new Map(truth.tiles.filter(t => t.level === 5).map(t => [t.file, { x: t.gx, y: t.gy, w: t.gw, h: t.gh }]))

/** 运行登记表：臂归属由 read_image 路径实测得出，不靠文件名猜；存在/不存在由文件系统实测
 *  （verify-reads.mjs）。此前按"路径形状像编造名"推断过一版，与事实不符：63036c9a 的 23 次
 *  读图**全部命中真文件**（16 张读全，7 次重复），而它的那一版被误记为"7 次编造"。 */
const RUNS = [
  { s: '7ced3634', arm: 'naive', delivered: '960x540', info: 1.000, reads: 16, exist: 16, fake: 0, cov: 16, note: '16/16 真图' },
  { s: '0ebbb2b2', arm: 'down-only', delivered: '392x221', info: 0.408, reads: 16, exist: 16, fake: 0, cov: 16, note: '16/16 真图' },
  { s: '9a322102', arm: 'down-only', delivered: '392x221', info: 0.408, reads: 16, exist: 16, fake: 0, cov: 16, note: '16/16 真图' },
  { s: '63036c9a', arm: 'down-then-up', delivered: '1568x884', info: 0.408, reads: 23, exist: 23, fake: 0, cov: 16, note: '16/16 真图（7 次重复读，无编造）' },
  { s: 'e134da0e', arm: 'down-then-up', delivered: '1568x884', info: 0.408, reads: 16, exist: 16, fake: 0, cov: 16, note: '16/16 真图' },
  { s: '5d09771c', arm: 'down-then-up', delivered: '1568x884', info: 0.408, reads: 40, exist: 17, fake: 23, cov: 16, note: '16/16 真图，另有 23 次打在不存在路径' },
]
/** 无交付的失控运行：单独记录，不进入任何臂的统计。终值取它交卷（TOTAL_OBSERVED: 0）之后 */
const RUNAWAY = { s: 'a9cdcf16', arm: '(naive 方向)', reads: 590, exist: 1, fake: 589, cov: 0, delivered: null }

function zm(buf) {
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const st = []; let i = 0
  while (i >= 0 && i < buf.length) { const at = buf.indexOf(M, i); if (at < 0) break; st.push(at); i = at + 4 }
  const o = []
  for (let k = 0; k < st.length; k++) { const e = k + 1 < st.length ? st[k + 1] : buf.length; try { o.push(zstdDecompressSync(buf.subarray(st[k], e))) } catch {} }
  return Buffer.concat(o).toString('utf8')
}
function load(id) {
  const dir = readdirSync(DSH).find(d => d.startsWith(id))
  if (!dir) return null
  const p = DSH + dir + '\\session.v3.jsonl.zstd'
  if (!existsSync(p)) return null
  return zm(readFileSync(p)).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const pos = (file, u, v) => { const r = RECT.get(file); return r ? { x: r.x + u * r.w, y: r.y + v * r.h } : null }
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const nearestTruth = p => { let best = null, bd = Infinity; for (const t of T) { const d = d2(p, t); if (d < bd) { bd = d; best = t } } return { t: best, d: bd } }

function answerOf(evs) {
  let answer = null
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const c = e.data?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool-call' && b.name === 'send_message') {
        try { const a = JSON.parse(b.arguments); if (/OBSERVED:/.test(a.message || '')) answer = a.message } catch {}
      }
      if (b?.type === 'text' && /OBSERVED:/.test(b.text || '')) answer = b.text
    }
  }
  return answer
}
function tokensOf(evs) {
  // 逐步取"字段集最大"的那个 usage，再求和 —— 与 run-three-arm.mjs 一致，可对照
  let sum = 0
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const us = []
    const walk = n => { if (!n || typeof n !== 'object') return; if (typeof n.inputTokens === 'number') { us.push(n); return } for (const k of Object.keys(n)) walk(n[k]) }
    walk(e.data)
    if (!us.length) continue
    us.sort((a, b) => Object.keys(b).length - Object.keys(a).length)
    sum += us[0].inputTokens
  }
  return sum
}

const rows = []
for (const R of RUNS) {
  const evs = load(R.s)
  if (!evs) { console.log(`${R.s}: 会话读不到`); continue }
  const txt = answerOf(evs)
  if (!txt) { console.log(`${R.s}: 无答卷`); continue }
  const obs = [], unc = []
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    let m = t.match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
    if (m) { obs.push({ file: m[1].trim().split(/[\\/]/).pop(), code: m[2].toUpperCase(), u: +m[3], v: +m[4] }); continue }
    m = t.match(/^UNCERTAIN:\s*([^|]*)\|\s*u=([0-9.]+)\s+v=([0-9.]+)\s*\|\s*([A-Za-z0-9]{3})?/i)
    if (m) unc.push({ file: m[1].trim().split(/[\\/]/).pop(), u: +m[2], v: +m[3], code: (m[4] || '').toUpperCase() })
  }
  const P = obs.map(o => ({ ...o, p: pos(o.file, o.u, o.v) })).filter(o => o.p)
  const hitCodes = new Set(), hitErrs = [], stray = [], pairs = []
  for (const o of P) {
    if (byCode.has(o.code) && !hitCodes.has(o.code)) { hitCodes.add(o.code); hitErrs.push(d2(o.p, byCode.get(o.code))) }
    const n = nearestTruth(o.p)
    if (n.d > 60) stray.push({ code: o.code, d: n.d, near: n.t.code })
    else if (o.code !== n.t.code) pairs.push({ got: o.code, truth: n.t.code, d: n.d })
  }
  const hitAny = new Set(hitCodes)
  for (const u of unc) { const p = pos(u.file, u.u, u.v); if (!p || !u.code) continue; const n = nearestTruth(p); if (n.d <= 60 && byCode.has(u.code)) hitAny.add(u.code) }
  // where 轴：每个真值标签到最近一次报出的距离
  const near = T.map(t => { let bd = Infinity; for (const o of P) { const d = d2(o.p, t); if (d < bd) bd = d } return bd })
  rows.push({
    ...R, reported: P.length, abstain: unc.length, obsHits: hitCodes.size, anyHits: hitAny.size,
    precision: P.length ? hitCodes.size / P.length : 0, recall: hitCodes.size / T.length, recallAny: hitAny.size / T.length,
    medHitErr: MED(hitErrs), stray: stray.length, strayList: stray,
    inPos: P.length - stray.length, posCov60: near.filter(d => d <= 60).length, posCov40: near.filter(d => d <= 40).length,
    medNear: MED(near), pairs, tokens: tokensOf(evs),
  })
}

const pct = x => (x * 100).toFixed(1) + '%'
console.log('运行级结果（臂归属由 read_image 路径实测；存在/不存在由文件系统实测）\n')
console.log('臂            运行      交付尺寸      信息   读图/存在/不存在/覆盖  报出  弃权  命中  召回    精确    where:覆盖60/40  最近中位   命中中位  越界  累计input')
for (const r of rows) {
  console.log(
    r.arm.padEnd(14) + r.s.padEnd(9) + r.delivered.padEnd(14) + r.info.toFixed(3).padEnd(7) +
    (`${r.reads}/${r.exist}/${r.fake}/${r.cov}`).padEnd(23) +
    String(r.reported).padStart(4) + String(r.abstain).padStart(6) + String(r.obsHits).padStart(6) +
    pct(r.recall).padStart(8) + pct(r.precision).padStart(8) +
    (`   ${r.posCov60}/36,${r.posCov40}/36`).padEnd(18) +
    (r.medNear === null ? '-' : r.medNear.toFixed(1) + 'px').padStart(9) +
    (r.medHitErr === null ? '-' : r.medHitErr.toFixed(1) + 'px').padStart(10) +
    String(r.stray).padStart(6) + r.tokens.toLocaleString().padStart(13))
}

console.log('\n两轴分解：定位（where）与识读（what）不能混为一谈')
console.log('臂            运行      位置覆盖(60px)  "站对位置"的报出   其中读对    条件识读率')
for (const r of rows) {
  const inPos = r.inPos, rightInPos = r.obsHits
  console.log(r.arm.padEnd(14) + r.s.padEnd(9) + `${r.posCov60}/36`.padStart(10) + String(inPos).padStart(16) +
    String(rightInPos).padStart(12) + (inPos ? (rightInPos / inPos * 100).toFixed(1) + '%' : '-').padStart(12))
}

console.log('\n按臂汇总')
const ARMS = ['naive', 'down-only', 'down-then-up']
for (const arm of ARMS) {
  const g = rows.filter(r => r.arm === arm)
  if (!g.length) continue
  const rng = k => `${Math.min(...g.map(r => r[k]))} ~ ${Math.max(...g.map(r => r[k]))}`
  console.log(`${arm}  (n=${g.length} 次运行)`)
  console.log(`   召回       ${rng('recall')}   均值 ${(g.reduce((s, r) => s + r.recall, 0) / g.length * 100).toFixed(1)}%`)
  console.log(`   命中中位误差 ${g.map(r => r.medHitErr.toFixed(1)).join(' / ')} px`)
  console.log(`   位置覆盖60   ${g.map(r => r.posCov60).join(' / ')} /36`)
  console.log(`   累计input    ${g.map(r => r.tokens.toLocaleString()).join(' / ')}`)
}

// ---- 配对比较：只用"没有编造读图"的运行 ----
const clean = rows.filter(r => r.fake === 0)
console.log('\n只用干净运行（无编造文件名）的配对')
const naive = clean.filter(r => r.arm === 'naive'), donly = clean.filter(r => r.arm === 'down-only'), dtu = clean.filter(r => r.arm === 'down-then-up')
function twoProp(h1, n1, h2, n2) {
  const p1 = h1 / n1, p2 = h2 / n2, p = (h1 + h2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  const z = se ? (p1 - p2) / se : 0
  const pv = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))
  return { p1, p2, diff: p1 - p2, se, z, p: pv }
}
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const t = 1 / (1 + p * x); const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x); return s * y }
const all = g => ({ h: g.reduce((s, r) => s + r.obsHits, 0), n: g.length * 36 })
for (const [name, A, B] of [['naive vs down-then-up', naive, dtu], ['naive vs down-only', naive, donly], ['down-only vs down-then-up', donly, dtu]]) {
  if (!A.length || !B.length) continue
  const a = all(A), b = all(B)
  const t = twoProp(a.h, a.n, b.h, b.n)
  console.log(`${name.padEnd(24)} ${pct(t.p1)} vs ${pct(t.p2)}   Δ=${(t.diff * 100).toFixed(1)} 点  SE=${(t.se * 100).toFixed(1)}  z=${t.z.toFixed(2)}  p=${t.p < 0.0001 ? '<0.0001' : t.p.toFixed(4)}`)
}

console.log('\n编造读图的代价（读不存在的路径 = 纯浪费的步数）')
for (const r of rows) if (r.fake) console.log(`   ${r.s} (${r.arm})  读图 ${r.reads} 次：存在 ${r.exist}、不存在 ${r.fake}；真图覆盖 ${r.cov}/16`)
console.log(`   ${RUNAWAY.s} ${RUNAWAY.arm}  读图 ${RUNAWAY.reads} 次：存在 ${RUNAWAY.exist}、不存在 ${RUNAWAY.fake}；交付=无`)

console.log('\n错读配对（报出码 ← 就近真值，位置误差≤60px 才算"看对了地方却读错"）')
for (const r of rows) {
  if (!r.pairs.length) { console.log(`  ${r.arm} ${r.s}: 无`); continue }
  console.log(`  ${r.arm} ${r.s} (${r.pairs.length} 处): ${r.pairs.map(p => `${p.got}←${p.truth}(${p.d.toFixed(0)}px)`).join('  ')}`)
}
console.log('\n越界报出（离任何真值 >60px，位置本身就不对）')
for (const r of rows) if (r.strayList.length) console.log(`  ${r.arm} ${r.s}: ${r.strayList.map(s => `${s.code}(离最近${s.near} ${s.d.toFixed(0)}px)`).join('  ')}`)

writeFileSync(OUTDIR + 'score-runs.json', JSON.stringify({ runs: rows, runaway: RUNAWAY }, null, 2), 'utf8')
console.log('\n→ 明细已写入 score-runs.json')
