/** 从子代理会话提取每一步的 usage —— token 代价的实测来源（不是估算）。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
function zstdMulti(buf) {
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const st = []; let i = 0
  while (i >= 0 && i < buf.length) { const at = buf.indexOf(M, i); if (at < 0) break; st.push(at); i = at + 4 }
  const out = []
  for (let k = 0; k < st.length; k++) {
    const end = k + 1 < st.length ? st[k + 1] : buf.length
    try { out.push(zstdDecompressSync(buf.subarray(st[k], end))) } catch {}
  }
  return Buffer.concat(out).toString('utf8')
}
/** 递归找 {inputTokens, outputTokens, ...} 形状的对象 */
function findUsages(node, acc) {
  if (!node || typeof node !== 'object') return acc
  if (typeof node.inputTokens === 'number' && typeof node.outputTokens === 'number') { acc.push(node); return acc }
  for (const k of Object.keys(node)) findUsages(node[k], acc)
  return acc
}

const RUNS = {
  r1: { id: '2d1bce6e-954a-4e36-ac3f-895f225f9d18', scale: '1.000x (960)' },
  r2: { id: 'f31b9e32-f6f4-42a4-a61d-95639d1df7f6', scale: '1.633x (1568)' },
  r3: { id: 'c24de97e-5195-4925-9801-78c0e00edbf1', scale: '1.000x (960)' },
  r4: { id: '74fdae42-41ab-49fc-a241-00f7e5490f02', scale: '1.633x (1568)' },
  r5: { id: 'fc3cf1dd-40be-4f10-97eb-3753060abd39', scale: '3.000x (2880)' },
}

const rows = []
for (const [run, { id, scale }] of Object.entries(RUNS)) {
  const t = zstdMulti(readFileSync(DSH + id + '\\session.v3.jsonl.zstd'))
  const evs = t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const steps = []
  for (const e of evs) if (e.type === 'assistant/message') {
    const us = findUsages(e.data, [])
    if (!us.length) continue
    // 同一对象在事件里被嵌套记录两次（外层与内层各一次）——去重，否则每一项都翻倍
    const seenKey = new Set()
    const uniq = []
    for (const u of us) {
      const k = JSON.stringify(u)
      if (seenKey.has(k)) continue
      seenKey.add(k); uniq.push(u)
    }
    // 一次 API 调用只取一条：优先取字段最全的那条
    uniq.sort((a, b) => Object.keys(b).length - Object.keys(a).length)
    steps.push({ step: e.data?.step ?? null, ...uniq[0] })
  }
  const sum = k => steps.reduce((a, s) => a + (s[k] || 0), 0)
  rows.push({
    run, scale, calls: steps.length,
    input: sum('inputTokens'), output: sum('outputTokens'),
    reasoning: sum('reasoningTokens'), cacheRead: sum('cacheReadTokens'),
    perStep: steps.map(s => `s${s.step}:in${s.inputTokens}/out${s.outputTokens}`).join(' '),
  })
}

console.log('臂   交付档           调用  inputTokens  outputTokens  reasoning  cacheRead')
for (const r of rows) {
  console.log(
    r.run.padEnd(5) + r.scale.padEnd(18) + String(r.calls).padEnd(6) +
    String(r.input).padEnd(13) + String(r.output).padEnd(14) + String(r.reasoning).padEnd(11) + String(r.cacheRead)
  )
}
console.log('\n逐次调用明细:')
for (const r of rows) console.log(`  ${r.run}: ${r.perStep}`)

// 按倍率归总
const g = {}
for (const r of rows) { const k = r.scale.split(' ')[0]; (g[k] = g[k] || []).push(r) }
console.log('\n按倍率:')
for (const k of Object.keys(g).sort()) {
  const a = g[k]
  const inp = a.reduce((x, r) => x + r.input, 0) / a.length
  const out = a.reduce((x, r) => x + r.output, 0) / a.length
  console.log(`  ${k}x (n=${a.length}): 平均 input ${Math.round(inp)}  output ${Math.round(out)}`)
}
writeFileSync('D:\\deepseek\\.tmp\\xmodel\\token-usage.json', JSON.stringify(rows, null, 2), 'utf8')
console.log('\n已写 D:\\deepseek\\.tmp\\xmodel\\token-usage.json')
