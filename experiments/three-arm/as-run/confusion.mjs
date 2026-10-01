import { readFileSync, existsSync } from 'node:fs'
const T=JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json','utf8').replace(/^\uFEFF/,''))
const by=new Map(T.labels.map(l=>[l.code,l]))
const ALL=[...by.keys()]
const t5=T.tiles.filter(t=>t.level===5).sort((a,b)=>a.file.localeCompare(b.file))
const RECT=new Map(t5.map(t=>[t.file,{x:t.gx,y:t.gy,w:t.gw,h:t.gh}]))
function obs(f){
  const out=[]
  for(const line of readFileSync(f,'utf8').split(/\r?\n/)){
    const m=line.trim().match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
    if(!m) continue
    const r=RECT.get(m[1].trim().split(/[\\/]/).pop()); if(!r) continue
    out.push({code:m[2].toUpperCase(), gx:r.x+ +m[3]*r.w, gy:r.y+ +m[4]*r.h})
  }
  return out
}
for(const arm of ['naive','down-then-up','down-only']){
  const f=`D:/deepseek/.tmp/threearm/out/${arm}.txt`
  if(!existsSync(f)){console.log(arm,'缺');continue}
  const o=obs(f)
  console.log(`\n=== ${arm}：错码 -> 它其实读到了哪个真值（按最近位置配对，<60px 才算"读的是同一个标签"）===`)
  const wrong=o.filter(x=>!by.has(x.code))
  let paired=0, stray=0
  for(const w of wrong){
    let near=null,nd=Infinity
    for(const c of ALL){const t=by.get(c);const d=Math.hypot(w.gx-t.x,w.gy-t.y);if(d<nd){nd=d;near=c}}
    if(nd<60){ paired++; console.log(`  ${w.code}  <- 真值 ${near}   (位置偏差 ${nd.toFixed(0)}px)`) }
    else { stray++; console.log(`  ${w.code}  <- 邻近无真值（最近 ${near} 距 ${nd.toFixed(0)}px）`) }
  }
  console.log(`  小结：${wrong.length} 个错码，其中 ${paired} 个落在某真值 60px 内（= 同一标签读错），${stray} 个落在空白处`)
}
