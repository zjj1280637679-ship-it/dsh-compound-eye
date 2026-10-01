import fs from 'node:fs'
const T=JSON.parse(fs.readFileSync('D:/deepseek/.tmp/attn-exp/truth.json','utf8').replace(/^\uFEFF/,''))
const by=new Map(T.labels.map(l=>[l.code,l]))
function rect(f){const b=f.split(/[\\/]/).pop()
 if(/^full\.png$/i.test(b))return{x:0,y:0,w:T.sourceW,h:T.sourceH}
 const m=b.match(/^L\d+_\d+_x(\d+)_y(\d+)_w(\d+)_h(\d+)\.png$/i);return m?{x:+m[1],y:+m[2],w:+m[3],h:+m[4]}:null}
function rectImg(base){const m=base.match(/^img(\d\d)\.png$/);if(!m)return null
 const t=T.tiles.filter(z=>z.level===5).sort((a,b)=>a.file.localeCompare(b.file))[+m[1]-1]
 return t?{x:t.gx,y:t.gy,w:t.gw,h:t.gh}:null}
const MED=a=>{const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2}
function detail(f,useImg,label){
  const t=fs.readFileSync(f,'utf8');const dists=[];const seen=new Set();let obs=0,err=0
  for(const line of t.split(/\r?\n/)){
    const m=line.trim().match(/^OBSERVED:\s*([^|]*)\|\s*([A-Za-z0-9]{3})\s*\|\s*u=([0-9.]+)\s+v=([0-9.]+)/i)
    if(!m)continue;obs++
    const r=useImg?rectImg(m[1].trim()):rect(m[1].trim());if(!r)continue
    const c=m[2].toUpperCase();const tr=by.get(c);if(!tr){err++;continue}
    if(seen.has(c))continue;seen.add(c)
    dists.push(Math.hypot(r.x+ +m[3]*r.w-tr.x, r.y+ +m[4]*r.h-tr.y))
  }
  const s=[...dists].sort((a,b)=>a-b)
  console.log(`${label.padEnd(16)} 报出 ${String(obs).padStart(2)} 命中 ${String(seen.size).padStart(2)} 错码 ${err}  误差中位 ${MED(dists).toFixed(2)}px  最大 ${s[s.length-1].toFixed(1)}px`)
  return MED(dists)
}
console.log('=== 按评分器原口径重算（实验一）===')
for(const a of ['A','B','C','D','E','F']) detail(`D:/deepseek/.tmp/attn-exp/arm-${a}.txt`,false,`ds-${a}`)
console.log('\n=== 实验二 ===')
for(const r of ['r1','r2','r3','r4','r5']) detail(`D:/deepseek/.tmp/xmodel/out/${r}.txt`,true,`db-${r}`)
