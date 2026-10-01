/**
 * 运行级审计：不问"哪一臂赢"，先问"每一次运行到底看了什么、答得怎样"
 *
 * 起因：out/*.txt 是早期提取的答卷，而在 20:13 前后又有三个会话交了卷。
 * 靠文本猜是哪一臂不可靠 —— 三臂的文件名完全相同（都带源坐标），
 * 唯一可信的身份来源是会话里的 read_image 路径。
 *
 * 输出：每条运行的 目录 / 读图数 / 是否读完 16 张 / 有无交付 / 命中 / 位置误差
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'D:/deepseek/.tmp/threearm/'
const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
const truth = JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json', 'utf8').replace(/^\uFEFF/, ''))
const byCode = new Map(truth.labels.map(l => [l.code, l]))
const ALL = [...byCode.keys()]
const RECT = new Map(truth.tiles.filter(t => t.level === 5).map(t => [t.file, { x: t.gx, y: t.gy, w: t.gw, h: t.gh }]))
const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function zm(buf) {
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const st = []; let i = 0
  while (i >= 0 && i < buf.length) { const at = buf.indexOf(M, i); if (at < 0) break; st.push(at); i = at + 4 }
  const o = []
  for (let k = 0; k < st.length; k++) { const e = k + 1 < st.length ? st[k + 1] : buf.length; try { o.push(zstdDecompressSync(buf.subarray(st[k], e))) } catch {} }
  return Buffer.concat(o).toString('utf8')
}
function pngSize(p) { const b = readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }

console.log('=== 目录实测：每一臂交付的像素尺寸 ===')
const ARMS = ['naive', 'down-then-up', 'down-only']
for (const arm of ARMS) {
  const dir = ROOT + 'runs/' + arm + '/'
  const fs = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
  const sizes = new Set(fs.map(f => { const s = pngSize(dir + f); return s.w + 'x' + s.h }))
  console.log(`${arm.padEnd(13)} ${String(fs.length).padStart(2)} 张   ${[...sizes].join(', ')}   (${fs[0]})`)
}

console.log('\n=== 会话扫描：谁读了哪个目录、读了几张、答成什么样 ===')
const dirs = readdirSync(DSH).filter(d => existsSync(DSH + d + '\\session.v3.jsonl.zstd'))
const rows = []
for (const d of dirs) {
  const p = DSH + d + '\\session.v3.jsonl.zstd'
  const sz = statSync(p).size
  if (sz > 4_000_000) continue                      // 主会话等大文件跳过
  let text = ''
  try { text = zm(readFileSync(p)) } catch { continue }
  if (!text.includes('threearm')) continue

  const evs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const calls = []
  for (const e of evs) if (e.type === 'tool/call') calls.push(e.data)
  const reads = []
  for (const c of calls) {
    if (c?.name !== 'read_image') continue
    try { reads.push(JSON.parse(c.arguments).file_path) } catch {}
  }
  if (!reads.length) continue
  const armCount = {}
  for (const f of reads) {
    const m = String(f).replace(/\//g, '\\').match(/runs\\([^\\]+)\\/i)
    const a = m ? m[1] : '(其他)'
    armCount[a] = (armCount[a] || 0) + 1
  }
  const arm = Object.entries(armCount).sort((a, b) => b[1] - a[1])[0][0]
  const filesRead = new Set(reads.map(f => String(f).split(/[\\/]/).pop()))

  // 答卷：send_message 参数 与 最终文本 两条路都要看（早期版本只看了其中一条）
  let answer = null, src = null
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const c = e.data?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool-call' && b.name === 'send_message') {
        try { const a = JSON.parse(b.arguments); if (/OBSERVED:/.test(a.message || '')) { answer = a.message; src = 'send_message' } } catch {}
      }
      if (b?.type === 'text' && /OBSERVED:/.test(b.text || '')) { answer = b.text; src = 'text(final)' }
    }
  }
  let hit = 0, reported = 0, bad = [], dists = [], unc = 0
  if (answer) {
    const seen = new Set()
    for (const line of answer.split(/\r?\n/)) {
      const t = line.trim()
      if (/^UNCERTAIN:/i.test(t)) unc++
      const m = t.match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
      if (!m) continue
      reported++
      const code = m[2].toUpperCase(), file = m[1].trim().split(/[\\/]/).pop()
      const tr = byCode.get(code)
      if (!tr) { bad.push(code); continue }
      if (seen.has(code)) continue
      seen.add(code); hit++
      const r = RECT.get(file)
      if (r) dists.push(Math.hypot(r.x + +m[3] * r.w - tr.x, r.y + +m[4] * r.h - tr.y))
    }
  }
  const mtime = statSync(p).mtime
  rows.push({ id: d.slice(0, 8), arm, reads: reads.length, uniq: filesRead.size, armCount, reported, hit, unc, bad,
    recall: hit / ALL.length, precision: reported ? hit / reported : 0, med: MED(dists), src, mtime })
}

rows.sort((a, b) => a.mtime - b.mtime)
console.log('会话      臂            读图 唯一  报出 命中  召回    精确率  误差中位  不确定 交付来源        时刻')
for (const r of rows) {
  console.log(
    r.id + '  ' + r.arm.padEnd(13) + String(r.reads).padStart(3) + String(r.uniq).padStart(5) +
    String(r.reported).padStart(6) + String(r.hit).padStart(5) +
    ((r.recall * 100).toFixed(1) + '%').padStart(8) + ((r.precision * 100).toFixed(1) + '%').padStart(8) +
    (r.med === null ? '-' : r.med.toFixed(1) + 'px').padStart(9) + String(r.unc).padStart(7) + '  ' +
    String(r.src).padEnd(15) + r.mtime.toTimeString().slice(0, 8))
}

console.log('\n=== 按臂汇总（同臂多次运行 → 运行间方差）===')
for (const arm of ARMS) {
  const g = rows.filter(r => r.arm === arm)
  if (!g.length) { console.log(`${arm}: 无运行`); continue }
  console.log(`${arm}:`)
  for (const r of g) {
    console.log(`   ${r.id}  读完 ${r.uniq}/16 张  报出 ${String(r.reported).padStart(2)}  命中 ${String(r.hit).padStart(2)}` +
      `  召回 ${(r.recall * 100).toFixed(1)}%  精确 ${(r.precision * 100).toFixed(1)}%  ` +
      `中位 ${r.med === null ? '-' : r.med.toFixed(1) + 'px'}  不确定 ${r.unc}  错码 ${r.bad.length}${r.bad.length ? ' [' + r.bad.join(' ') + ']' : ''}`)
  }
  const m = r => r.med === null ? null : r.med
  console.log(`   → 召回区间 ${(Math.min(...g.map(x => x.recall)) * 100).toFixed(1)}% ~ ${(Math.max(...g.map(x => x.recall)) * 100).toFixed(1)}%` +
    `   中位误差区间 ${Math.min(...g.map(m).filter(x => x !== null)).toFixed(1)} ~ ${Math.max(...g.map(m).filter(x => x !== null)).toFixed(1)}px`)
}

console.log('\n=== 未交付/可疑运行（有读图但无答卷，或读图数不足 16）===')
for (const d of dirs) {
  const p = DSH + d + '\\session.v3.jsonl.zstd'
  if (statSync(p).size > 4_000_000) continue
  if (rows.some(r => r.id === d.slice(0, 8))) continue
  let text = ''
  try { text = zm(readFileSync(p)) } catch { continue }
  if (!text.includes('threearm')) continue
  const evs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const reads = evs.filter(e => e.type === 'tool/call' && e.data?.name === 'read_image').length
  const has = /OBSERVED:/.test(text)
  console.log(`   ${d.slice(0, 8)}  读图 ${String(reads).padStart(3)}  有 OBSERVED 字样: ${has}  更新 ${statSync(p).mtime.toTimeString().slice(0, 8)}`)
}
