import { readFileSync, readdirSync, existsSync } from 'node:fs'
const TR = JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json','utf8').replace(/^\uFEFF/,''))
const ALL = TR.labels.map(l=>l.code)
const SRC = []
for (const a of ['A','B','C','D','E','F']) {
  const p = `D:/deepseek/.tmp/attn-exp/arm-${a}.txt`
  if (existsSync(p)) SRC.push({id:`ds-${a}`, file:p})
}
for (const r of ['r1','r2','r3','r4','r5']) {
  const p = `D:/deepseek/.tmp/xmodel/out/${r}.txt`
  if (existsSync(p)) SRC.push({id:`db-${r}`, file:p})
}
const read = new Map(ALL.map(c=>[c,[]]))
for (const {id,file} of SRC) {
  const t = readFileSync(file,'utf8')
  const seen = new Set()
  for (const line of t.split(/\r?\n/)) {
    const m = line.trim().match(/^OBSERVED:\s*[^|]*\|\s*([A-Za-z0-9]{3})\s*\|/i)
    if (m) seen.add(m[1].toUpperCase())
  }
  for (const c of ALL) if (seen.has(c)) read.get(c).push(id)
}
const cols = SRC.map(s=>s.id)
console.log('| 真值 | ' + cols.join(' | ') + ' | 读出臂数 |')
console.log('|' + '---|'.repeat(cols.length+2))
for (const c of ALL) {
  const cells = cols.map(k => read.get(c).includes(k) ? '✓' : '·')
  console.log(`| ${c} | ${cells.join(' | ')} | ${read.get(c).length}/${cols.length} |`)
}
// 汇总
console.log('\n一臂都没读出的:', ALL.filter(c=>read.get(c).length===0).join(' ')||'(无)')
console.log('全部读出的  :', ALL.filter(c=>read.get(c).length===cols.length).join(' ')||'(无)')
const partial = ALL.filter(c=>read.get(c).length>0 && read.get(c).length<cols.length)
console.log('部分读出    :')
for (const c of partial) console.log(`  ${c}: ${read.get(c).length}/${cols.length}  -> ${read.get(c).join(' ')}`)
