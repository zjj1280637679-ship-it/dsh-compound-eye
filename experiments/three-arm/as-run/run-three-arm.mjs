/**
 * 三臂实验运行器
 *
 *   node run-three-arm.mjs check     查看三臂子代理进度（从会话文件读，不依赖通知）
 *   node run-three-arm.mjs extract   把答卷从会话里提取到 out/<臂>.txt
 *   node run-three-arm.mjs score     评分并输出判定表
 *
 * 需要先手动启动 3 个子代理（各读一个目录），因为子代理只能由 Agent 启动。
 * 启动后把它们的 session id 填进 RUNS。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'D:/deepseek/.tmp/threearm/'
const OUT = ROOT + 'out/'
const ATT = 'D:/deepseek/.tmp/attn-exp/'
const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'

/** 三臂 ↔ 子代理会话 id（启动后填写） */
const RUNS = {
  // 第一次 naive/down-then-up 作废：提示词没给文件名又禁止 glob，子代理只能编造名字
  // （85 次 / 32 次 read_image 全是 00.png、tile_00.png 这类不存在的路径）。
  // 第二次 naive 成功；down-then-up/down-only 读完 16 张就停了没交卷 —— 提示词缺"读完后立刻输出"。
  // 第三次：显式文件清单 + "读完立刻写最终消息、不要再调工具"。
  'naive': '7ced3634-8803-42c0-93f7-c2a48ea4c299',   // 第二次，已交卷 36 条
  'down-then-up': '63036c9a-ba2d-4411-932a-01e2cef38543', // 第二次的会话，延迟交卷 32 条
  'down-only': '0ebbb2b2-3752-4568-857e-54d78fa548b5',    // 第一次的会话，已交卷 34 条（它自行 glob 拿到真名）
}

const ARMS = ['naive', 'down-then-up', 'down-only']
const MODE = process.argv[2] || 'check'
const K = 1_000_000

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

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
function findUsages(node, acc) {
  if (!node || typeof node !== 'object') return acc
  if (typeof node.inputTokens === 'number') { acc.push(node); return acc }
  for (const k of Object.keys(node)) findUsages(node[k], acc)
  return acc
}

function sessions(arm) {
  const id = RUNS[arm]
  if (!id) return null
  const p = DSH + id + '\\session.v3.jsonl.zstd'
  if (!existsSync(p)) return null
  const text = zstdMulti(readFileSync(p))
  const evs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { evs, size: statSync(p).size, mtime: statSync(p).mtimeMs }
}

// ---------------- check ----------------
if (MODE === 'check') {
  console.log('臂            会话  事件  read_image  越界  答卷  文件尾写')
  for (const arm of ARMS) {
    const s = sessions(arm)
    if (!s) { console.log(`${arm.padEnd(13)}  (未配置或会话不存在)`); continue }
    const calls = s.evs.filter(e => e.type === 'tool/call').map(e => e.data)
    const reads = calls.filter(c => c?.name === 'read_image')
    let outside = 0
    for (const c of reads) {
      try {
        // Compare on a normalised separator: the arm names contain hyphens, and a regex built from a raw
        // Windows path would treat the backslashes as escapes. (The first version of this check reported
        // a false "outside" for the two hyphenated arms for exactly that reason.)
        const f = JSON.parse(c.arguments).file_path.replace(/\//g, '\\').toLowerCase()
        if (!f.includes(`\\runs\\${arm}\\`.toLowerCase())) outside++
      } catch { outside++ }
    }
    let answer = null
    for (const e of s.evs) {
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
    const idle = Math.round((Date.now() - s.mtime) / 1000)
    console.log(`${arm.padEnd(13)} ${String(RUNS[arm]).slice(0, 6)}  ${String(s.evs.length).padStart(4)}  ${String(reads.length).padStart(10)}  ${String(outside).padStart(4)}  ${answer ? '有 ' + (answer.match(/^OBSERVED:/gim) || []).length : '无'}     空闲 ${idle}s`)
  }
  process.exit(0)
}

// ---------------- extract ----------------
if (MODE === 'extract') {
  for (const arm of ARMS) {
    const s = sessions(arm)
    if (!s) { console.log(`${arm}: 无会话`); continue }
    let answer = null, src = null
    for (const e of s.evs) {
      if (e.type !== 'assistant/message') continue
      const c = e.data?.message?.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b?.type === 'tool-call' && b.name === 'send_message') {
          try { const a = JSON.parse(b.arguments); if (/OBSERVED:/.test(a.message || '')) { answer = a.message; src = 'send_message' } } catch {}
        }
        if (b?.type === 'text' && /OBSERVED:|UNCERTAIN:/.test(b.text || '')) { if (!answer) { answer = b.text; src = 'text' } }
      }
    }
    if (!answer) { console.log(`${arm}: 还没有答卷`); continue }
    writeFileSync(OUT + arm + '.txt', answer, 'utf8')
    const n = (answer.match(/^OBSERVED:/gim) || []).length
    console.log(`${arm}: -> out/${arm}.txt  (${answer.length} 字符, ${n} 条 OBSERVED, 来源 ${src})`)
  }
  process.exit(0)
}

// ---------------- score ----------------
if (MODE === 'score') {
  const truth = JSON.parse(readFileSync(ATT + 'truth.json', 'utf8').replace(/^\uFEFF/, ''))
  const byCode = new Map(truth.labels.map(l => [l.code, l]))
  const ALL = [...byCode.keys()]
  const t5 = truth.tiles.filter(t => t.level === 5).sort((a, b) => a.file.localeCompare(b.file))
  const RECT = new Map(t5.map(t => [t.file, { x: t.gx, y: t.gy, w: t.gw, h: t.gh }]))
  const MED = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

  const rows = []
  for (const arm of ARMS) {
    const f = OUT + arm + '.txt'
    if (!existsSync(f)) { console.log(`${arm}: 无 out 文件`); continue }
    const txt = readFileSync(f, 'utf8')
    const obs = []
    for (const line of txt.split(/\r?\n/)) {
      const m = line.trim().match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
      if (m) obs.push({ file: m[1].trim().split(/[\\/]/).pop(), code: m[2].toUpperCase(), u: +m[3], v: +m[4] })
    }
    const seen = new Set(), dists = [], badCode = []
    for (const o of obs) {
      const t = byCode.get(o.code)
      if (!t) { badCode.push(o.code); continue }
      if (seen.has(o.code)) continue
      seen.add(o.code)
      const r = RECT.get(o.file)
      if (!r) { badCode.push(o.code + '@' + o.file); continue }
      dists.push(Math.hypot(r.x + o.u * r.w - t.x, r.y + o.v * r.h - t.y))
    }
    // token 实测
    const s = sessions(arm)
    let tokIn = 0, calls = 0
    if (s) for (const e of s.evs) {
      if (e.type !== 'assistant/message') continue
      const us = findUsages(e.data, [])
      const uniq = []; const k = new Set()
      for (const u of us) { const kk = JSON.stringify(u); if (!k.has(kk)) { k.add(kk); uniq.push(u) } }
      if (uniq.length) { uniq.sort((a, b) => Object.keys(b).length - Object.keys(a).length); tokIn += uniq[0].inputTokens; calls++ }
    }
    rows.push({
      arm, reported: obs.length, hit: seen.size, bad: badCode.length,
      precision: obs.length ? seen.size / obs.length : 0,
      recall: seen.size / ALL.length,
      median: MED(dists), max: dists.length ? Math.max(...dists) : null,
      misses: ALL.filter(c => !seen.has(c)), tokIn, calls,
    })
  }

  const pad = (s, n) => String(s).padEnd(n)
  console.log('臂            报出  命中  错码  精确率   召回    误差中位  最大误差  漏检  inputTokens  调用')
  for (const r of rows) {
    console.log(
      pad(r.arm, 14) + pad(r.reported, 6) + pad(r.hit, 6) + pad(r.bad, 6) +
      pad((r.precision * 100).toFixed(1) + '%', 9) + pad((r.recall * 100).toFixed(1) + '%', 8) +
      pad(r.median === null ? '-' : r.median.toFixed(1) + 'px', 10) +
      pad(r.max === null ? '-' : r.max.toFixed(1) + 'px', 10) +
      pad(r.misses.length, 6) + pad(r.tokIn.toLocaleString(), 13) + r.calls
    )
  }
  console.log('\n各臂漏检：')
  for (const r of rows) console.log(`  ${r.arm}: ${r.misses.join(' ') || '(无)'}`)

  // ---- 判定 ----
  const g = a => rows.find(r => r.arm === a)
  const A = g('naive'), B = g('down-then-up'), C = g('down-only')
  console.log('\n===== 判定 =====')
  if (A && B && C) {
    const rec = r => (r.recall * 100).toFixed(1) + '%'
    console.log(`naive        ${rec(A)}   (原生 1:1 交付)`)
    console.log(`down-then-up ${rec(B)}   (整屏降采样后裁 + 插值回上限)`)
    console.log(`down-only    ${rec(C)}   (整屏降采样后裁，不放大)`)
    const dAB = A.recall - B.recall, dBC = B.recall - C.recall
    console.log(`\nΔ(naive − down-then-up) = ${(dAB * 100).toFixed(1)} 点`)
    console.log(`Δ(down-then-up − down-only) = ${(dBC * 100).toFixed(1)} 点`)
    console.log('\n读法：')
    console.log('  naive ≈ down-then-up > down-only  -> 收益全在交付尺寸，插值只是补偿降采样')
    console.log('  naive > down-then-up              -> 有一截只有原生像素能给，抓取通道必须改')
    console.log('  三者相同                          -> 交付尺度理论被否，回到像素信息决定论')
  }
}
