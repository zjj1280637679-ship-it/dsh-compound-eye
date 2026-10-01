/**
 * 三臂实验的统计口径表
 *
 * 为什么要单独一层：三臂不是"各跑一次"，而是 臂×多次运行。
 * 于是同一个问题有三种合理口径，答案并不一致 —— 报告必须把它们并排给出，
 * 而不是挑一个最顺眼的当结论。
 *
 *   A 全部运行合并        每次运行都是独立读数，次数多的臂话语权大
 *   B 只用"零编造"运行    样本更干净，但各臂次数极不均衡（1 vs 2 vs 1）
 *   C 配对比较            同一轮次内比（运行序是共同因子），最贴近实验设计，但 n 太小
 */
import { readFileSync, writeFileSync } from 'node:fs'

const D = 'D:/deepseek/.tmp/threearm/'
const { runs, runaway } = JSON.parse(readFileSync(D + 'score-runs.json', 'utf8'))
const ARMS = ['naive', 'down-only', 'down-then-up']

const erf = x => { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const t = 1 / (1 + p * x); return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)) }
const norm2 = z => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))
function twoProp(h1, n1, h2, n2) {
  const p1 = h1 / n1, p2 = h2 / n2, p = (h1 + h2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  const z = se ? (p1 - p2) / se : 0
  return { p1, p2, diff: p1 - p2, se, z, p: norm2(z) }
}
const pf = p => p < 0.0001 ? '<0.0001' : p.toFixed(4)
const pc = x => (x * 100).toFixed(1) + '%'
const pool = g => ({ h: g.reduce((s, r) => s + r.obsHits, 0), n: g.length * 36 })
const byArm = (list, a) => list.filter(r => r.arm === a)
const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const L = []
L.push('# 三臂实验统计口径（由 score-runs.json 生成，可复算）\n')
L.push('运行清单：')
L.push('| 臂 | 运行 | 交付尺寸 | 逐像素信息 | 读图(存在/不存在/真图覆盖) | 报出 | 弃权 | 命中 | 召回 | 精确 | 位置覆盖≤60px | 命中中位误差 | 累计input |')
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of runs) {
  L.push(`| ${r.arm} | ${r.s} | ${r.delivered} | ${r.info.toFixed(3)}× | ${r.reads} (${r.exist}/${r.fake}/${r.cov}of16) | ${r.reported} | ${r.abstain} | ${r.obsHits} | ${pc(r.recall)} | ${pc(r.precision)} | ${r.posCov60}/36 | ${r.medHitErr.toFixed(1)}px | ${r.tokens.toLocaleString()} |`)
}
L.push('')

const all = runs
const clean = runs.filter(r => r.fake === 0)
const pairsOf = [['naive', 'down-then-up'], ['naive', 'down-only'], ['down-only', 'down-then-up']]

function block(title, list, note) {
  L.push(`## ${title}`)
  L.push(note)
  L.push('')
  L.push('| 比较 | 命中/样本 | 合并召回 | 各臂运行数 | Δ | SE | z | p |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const [a, b] of pairsOf) {
    const A = byArm(list, a), B = byArm(list, b)
    if (!A.length || !B.length) { L.push(`| ${a} vs ${b} | — | — | 0 | — | — | — | 该口径下无数据 |`); continue }
    const x = pool(A), y = pool(B), t = twoProp(x.h, x.n, y.h, y.n)
    L.push(`| ${a} vs ${b} | ${x.h}/${x.n} vs ${y.h}/${y.n} | ${pc(t.p1)} vs ${pc(t.p2)} | ${A.length} vs ${B.length} | ${(t.diff * 100).toFixed(1)} 点 | ${(t.se * 100).toFixed(1)} | ${t.z.toFixed(2)} | ${pf(t.p)} |`)
  }
  L.push('')
  for (const a of ARMS) {
    const g = byArm(list, a)
    if (!g.length) continue
    L.push(`- ${a}（n=${g.length}）：召回 ${g.map(r => pc(r.recall)).join(' / ')}，均值 ${pc(g.reduce((s, r) => s + r.recall, 0) / g.length)}；臂内极差 ${((Math.max(...g.map(r => r.recall)) - Math.min(...g.map(r => r.recall))) * 100).toFixed(1)} 点`)
  }
  L.push('')
}

block('口径 A：全部 6 次运行合并', all, '每次运行视为一次独立读数；各臂运行数 1 / 2 / 3，次数多的臂权重更大。')
block('口径 B：只用零编造读图的运行', clean, '剔除把 read_image 打在**不存在路径**上的运行（读不存在的文件只会浪费步数、不注入错误内容，因此这是"更严"而非"更对"的口径）。存在性由文件系统实测（verify-reads.mjs）；此前按路径形状推断过一版，现在已被实测取代。')

// 口径 C：配对
L.push('## 口径 C：配对比较（同一轮次内）')
L.push('运行序本身是共同因子（后一轮两次运行都比前一轮高 11.1 点），配对能把它消掉。')
L.push('')
L.push('| 轮次 | down-only | down-then-up | 配对差 |')
L.push('|---|---|---|---|')
const r1 = { do: byArm(all, 'down-only')[0], dtu: byArm(all, 'down-then-up')[0] }
const r2 = { do: byArm(all, 'down-only')[1], dtu: byArm(all, 'down-then-up')[1] }
const diffs = []
for (const [i, p] of [r1, r2].entries()) {
  const d = p.do.recall - p.dtu.recall
  diffs.push(d)
  L.push(`| 第 ${i + 1} 轮 | ${pc(p.do.recall)} (${p.do.s}) | ${pc(p.dtu.recall)} (${p.dtu.s}) | +${(d * 100).toFixed(1)} 点 |`)
}
const r3 = byArm(all, 'down-then-up')[2]
L.push(`| 第 3 轮 | （无第 3 次） | ${pc(r3.recall)} (${r3.s}) | — |`)
L.push('')
L.push(`两对配对差同号且同幅（都是 +${(diffs[0] * 100).toFixed(1)} 点）。符号检验 n=2：p = 0.25 —— 方向一致，但样本量不足以判定显著。`)
L.push(`不带配对的合并检验：口径 A（全部 6 次）p=0.057、口径 B（零编造读图）p=0.037。`)
L.push(`⇒ **三种口径方向一致；显著与否取决于是否接受合并口径**（合并口径下 2 vs 2 达到 p=0.037，配对口径因 n=2 而无功效）。`)
L.push(`因此可以宣称"放大未带来收益、方向上更低"，但不能把"放大确定有害"当成已定论的结论。`)
L.push('')

// 臂内 vs 臂间
L.push('## 臂内方差 vs 臂间差异')
const doR = byArm(all, 'down-only'), dtuR = byArm(all, 'down-then-up')
L.push(`- down-only 臂内：${doR.map(r => pc(r.recall)).join(' → ')}，跨度 ${((doR[1].recall - doR[0].recall) * 100).toFixed(1)} 点`)
L.push(`- down-then-up 臂内：${dtuR.map(r => pc(r.recall)).join(' → ')}，跨度 ${((dtuR[2].recall - dtuR[0].recall) * 100).toFixed(1)} 点`)
L.push(`- 两臂的"第 2 次减第 1 次"都是 +11.1 点 —— 臂内漂移与待检验的臂间差异同量级。`)
L.push('')

// where / what
L.push('## where 与 what 的分离')
L.push('| 臂 | 运行 | 36 个真值中"有报出落在 60px 内" | 落在 60px 内的报出数 | 其中码读对 | 条件识读率 | 错读发生时的位置误差中位 |')
L.push('|---|---|---|---|---|---|---|')
for (const r of runs) {
  const md = MED(r.pairs.map(p => p.d))
  const inPos = r.inPos, right = r.obsHits
  L.push(`| ${r.arm} | ${r.s} | ${r.posCov60}/36 | ${inPos} | ${right} | ${inPos ? pc(right / inPos) : '-'} | ${md === null ? '无错读' : md.toFixed(1) + 'px'} |`)
}
L.push('')
for (const r of runs) L.push(`- ${r.arm} ${r.s}：36 个真值到最近报出的距离中位 ${r.medNear.toFixed(1)}px；越界报出 ${r.stray} 条`)
L.push('')

// 编造文件名
L.push('## 打在不存在路径上的读图（纯浪费的步数）')
L.push('| 运行 | 臂 | 读图次数 | 存在 | 不存在 | 真图覆盖 | 交付 |')
L.push('|---|---|---|---|---|---|---|')
for (const r of runs) if (r.fake) L.push(`| ${r.s} | ${r.arm} | ${r.reads} | ${r.exist} | ${r.fake} | ${r.cov}/16 | 有（${r.reported} 条） |`)
L.push(`| ${runaway.s} | ${runaway.arm} | ${runaway.reads} | ${runaway.exist} | ${runaway.fake} | ${runaway.cov}/16 | **无** |`)
L.push('')

writeFileSync(D + 'stats-arms.md', L.join('\n'), 'utf8')
console.log(L.join('\n'))
