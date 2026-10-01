import { readFileSync, existsSync } from 'node:fs'
const T=JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json','utf8').replace(/^\uFEFF/,''))
const by=new Map(T.labels.map(l=>[l.code,l]))
const t5=T.tiles.filter(t=>t.level===5).sort((a,b)=>a.file.localeCompare(b.file))
const RECT=new Map(t5.map(t=>[t.file,{x:t.gx,y:t.gy,w:t.gw,h:t.gh}]))
const MED=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2}
const all=[]
for(const r of ['r1','r2','r3','r4','r5']){
  const f=`D:/deepseek/.tmp/xmodel/out/${r}.txt`
  if(!existsSync(f)){console.log(r,'缺文件');continue}
  const txt=readFileSync(f,'utf8')
  const d=[]; let obs=0, noRect=0, noTruth=0
  for(const line of txt.split(/\r?\n/)){
    const raw=line.trim()
    if(!raw.toUpperCase().startsWith('OBSERVED:'))continue
    obs++
    const m=raw.match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
    if(!m){console.log(r,' 正则未匹配:',JSON.stringify(raw));continue}
    const base=m[1].trim()
    const rc=RECT.get(base)
    if(!rc){noRect++; if(noRect<=2)console.log(r,' 无矩形:',JSON.stringify(base));continue}
    const t=by.get(m[2].toUpperCase())
    if(!t){noTruth++;continue}
    d.push(Math.hypot(rc.x+ +m[3]*rc.w-t.x, rc.y+ +m[4]*rc.h-t.y))
  }
  const med=MED(d)
  console.log(`${r}: OBSERVED=${obs} 计入=${d.length} 无矩形=${noRect} 无真值=${noTruth} 中位=${med===null?'-':med.toFixed(1)+'px'} 最大=${d.length?Math.max(...d).toFixed(1)+'px':'-'}`)
  all.push(...d)
}
if(all.length){
  const med=MED(all)
  console.log(`\n合计 n=${all.length} 中位 ${med.toFixed(1)}px 最大 ${Math.max(...all).toFixed(1)}px`)
  console.log(`相对 960px 瓦片：中位 ${(med/960*100).toFixed(2)}%  最大 ${(Math.max(...all)/960*100).toFixed(2)}%`)
}
