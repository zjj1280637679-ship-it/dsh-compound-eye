/**
 * 读图真实性核验：每一次 read_image 的路径，在磁盘上是否存在？
 *
 * 为什么必须做：报告里"真文件读/编造名读"这一列原先是我按路径形状**推断**的
 * （"形状像编造名"），不是测出来的。这类推断在本项目里已经出过错，必须换成文件系统事实。
 * 同时它顺带回答一个关键问题：这一臂到底把 16 张真图读全了没有。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
const ROOT = 'D:/deepseek/.tmp/threearm/'
const ARMS = ['naive', 'down-only', 'down-then-up']
const ARM_FILES = {}
for (const a of ARMS) ARM_FILES[a] = new Set(readdirSync(ROOT + 'runs/' + a + '/').filter(f => f.endsWith('.png')))

const RUNS = [
  ['7ced3634', 'naive'], ['0ebbb2b2', 'down-only'], ['9a322102', 'down-only'],
  ['63036c9a', 'down-then-up'], ['e134da0e', 'down-then-up'], ['5d09771c', 'down-then-up'],
  ['a9cdcf16', '(失控)'],
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

console.log('会话      臂            读图  存在  不存在  真图覆盖   编造名样例')
console.log('                                                (16 张里读到几张)')
const rows = []
for (const [id, arm] of RUNS) {
  const evs = load(id)
  if (!evs) { console.log(`${id}  会话不可读`); continue }
  const reads = []
  for (const e of evs) {
    if (e.type !== 'tool/call' || e.data?.name !== 'read_image') continue
    try { reads.push(JSON.parse(e.data.arguments).file_path) } catch {}
  }
  let exist = 0, missing = 0
  const realHit = new Set(), fakes = []
  for (const f of reads) {
    if (existsSync(f)) {
      exist++
      const b = String(f).split(/[\\/]/).pop()
      if (ARM_FILES[arm]?.has(b)) realHit.add(b)
    } else { missing++; if (fakes.length < 3) fakes.push(String(f).split(/[\\/]/).pop()) }
  }
  rows.push({ id, arm, reads: reads.length, exist, missing, cov: realHit.size, fakes })
}

for (const r of rows) {
  const cov = r.arm === '(失控)' ? 'n/a' : `${r.cov}/16`
  console.log(`${r.id}  ${r.arm.padEnd(13)}${String(r.reads).padStart(4)}${String(r.exist).padStart(6)}${String(r.missing).padStart(8)}   ${cov.padEnd(10)} ${r.fakes.join(' ')}`)
}

console.log('\n要点：')
for (const r of rows) {
  if (r.missing === 0) continue
  console.log(`  ${r.id} (${r.arm}) 有 ${r.missing} 次读图打在**不存在**的路径上；其中真实文件命中 ${r.exist}/${r.reads} 次。`)
}
const allReal = rows.filter(r => r.arm !== '(失控)')
console.log('\n有效运行的"真图覆盖"分布：' + allReal.map(r => `${r.id}=${r.cov}/16`).join('  '))
const bad = allReal.filter(r => r.cov < 16)
console.log(bad.length ? `⚠️ 未读全 16 张的运行：${bad.map(r => r.id).join(', ')}` : '✅ 6 次有效运行全部读全了 16 张真图')

const runaway = rows.find(r => r.arm === '(失控)')
if (runaway) {
  console.log(`\n失控运行 ${runaway.id}：读图 ${runaway.reads} 次，存在 ${runaway.exist} 次，不存在 ${runaway.missing} 次。`)
  console.log('  这组数字会写进报告与论文附录 H，替换此前按形状推断的 341。')
}
