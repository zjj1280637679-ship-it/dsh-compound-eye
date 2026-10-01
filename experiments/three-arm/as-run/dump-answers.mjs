/**
 * 把 6 次有效运行 + 1 次失控运行的**最终答卷**导出成独立文件。
 *
 * 为什么要这一步：已发布的数字来自会话里的答卷，而会话文件不会进仓库（太大、且含完整提示词）。
 * 不导出答卷，仓库里的评分脚本就成了没有输入的死代码 —— 别人无法复算任何一个数字。
 *
 * 输出：answers/<会话前 8 位>.txt
 *   前 7 行是给机器读的注册表（臂归属由 read_image 路径实测得出，见 audit-runs.mjs）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
const OUT = 'D:/deepseek/.tmp/threearm/answers/'
mkdirSync(OUT, { recursive: true })

const RUNS = [
  { s: '7ced3634', arm: 'naive', delivered: '960x540', info: 1.000, note: '16/16 real reads' },
  { s: '0ebbb2b2', arm: 'down-only', delivered: '392x221', info: 0.408, note: '16/16 real reads' },
  { s: '9a322102', arm: 'down-only', delivered: '392x221', info: 0.408, note: '16/16 real reads' },
  { s: '63036c9a', arm: 'down-then-up', delivered: '1568x884', info: 0.408, note: '23 real reads, 16 unique tiles, no fabricated path' },
  { s: 'e134da0e', arm: 'down-then-up', delivered: '1568x884', info: 0.408, note: '16/16 real reads' },
  { s: '5d09771c', arm: 'down-then-up', delivered: '1568x884', info: 0.408, note: '16/16 real reads + 23 reads of non-existent paths' },
  { s: 'a9cdcf16', arm: '(abandoned)', delivered: null, info: null, note: '590 reads, 589 of non-existent paths, delivered TOTAL_OBSERVED: 0' },
]

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

const registry = []
for (const R of RUNS) {
  const evs = load(R.s)
  if (!evs) { console.log(`${R.s}: 会话不可读`); continue }
  // 答卷可能出现在两处：send_message 的参数、或助手最终文本。取最后出现的那个。
  let answer = null, src = null
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const c = e.data?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool-call' && b.name === 'send_message') {
        try { const a = JSON.parse(b.arguments); if (/OBSERVED:|TOTAL_OBSERVED:/.test(a.message || '')) { answer = a.message; src = 'send_message' } } catch {}
      }
      if (b?.type === 'text' && /OBSERVED:|TOTAL_OBSERVED:/.test(b.text || '')) { answer = b.text; src = 'text' }
    }
  }
  if (!answer) { console.log(`${R.s}: 无答卷`); continue }
  const nObs = (answer.match(/^OBSERVED:/gim) || []).length
  const nUnc = (answer.match(/^UNCERTAIN:/gim) || []).length
  writeFileSync(OUT + R.s + '.txt', answer, 'utf8')
  registry.push({ ...R, source: src, observed: nObs, uncertain: nUnc })
  console.log(`${R.s}  ${R.arm.padEnd(12)} 报出 ${String(nObs).padStart(2)}  弃权 ${String(nUnc).padStart(2)}  来源 ${src}`)
}
writeFileSync(OUT + 'registry.json', JSON.stringify({ note: 'arm identity derived from read_image paths, not from filenames (all three arms use identical filenames)', runs: registry }, null, 2), 'utf8')
console.log(`\n→ ${OUT}`)
