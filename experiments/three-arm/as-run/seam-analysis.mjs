import { readFileSync } from 'node:fs'
const T=JSON.parse(readFileSync('D:/deepseek/.tmp/attn-exp/truth.json','utf8').replace(/^\uFEFF/,''))
// 接缝位置：L5 的切缝
const L5=T.tiles.filter(t=>t.level===5)
const cutsX=[...new Set(L5.map(t=>t.gx))].filter(x=>x>0).sort((a,b)=>a-b)
const cutsY=[...new Set(L5.map(t=>t.gy))].filter(y=>y>0).sort((a,b)=>a-b)
console.log('L5 竖直接缝 x =', cutsX.join(', '))
console.log('L5 水平接缝 y =', cutsY.join(', '))
// 真值标签盒（从实测墨迹推：宽约 58px，高约 24px，以锚点为中心偏右）
const W=58,H=24
const ON=[]  // 与接缝相交
const NEAR=[] // 距接缝 < 15px 但不相交
for(const l of T.labels){
  const x0=l.x-W/2, x1=l.x+W/2, y0=l.y-H/2, y1=l.y+H/2
  const cx=cutsX.filter(c=>c>x0&&c<x1)
  const cy=cutsY.filter(c=>c>y0&&c<y1)
  if(cx.length||cy.length) ON.push({code:l.code,x0,x1,y0,y1,cx,cy})
  else {
    const dx=Math.min(...cutsX.map(c=>Math.min(Math.abs(c-x0),Math.abs(c-x1))))
    const dy=Math.min(...cutsY.map(c=>Math.min(Math.abs(c-y0),Math.abs(c-y1))))
    if(Math.min(dx,dy)<15) NEAR.push({code:l.code,dx,dy})
  }
}
console.log(`\n正好被接缝穿过: ${ON.length}/36 = ${(ON.length/36*100).toFixed(1)}%`)
for(const o of ON) console.log(`  ${o.code} 盒 x[${o.x0.toFixed(0)},${o.x1.toFixed(0)}] y[${o.y0.toFixed(0)},${o.y1.toFixed(0)}]  穿过 x=${o.cx.join(',')||'-'} y=${o.cy.join(',')||'-'}`)
console.log(`\n距接缝 <15px（贴近但不穿过）: ${NEAR.length} 个`)
for(const n of NEAR) console.log(`  ${n.code} 距最近接缝 dx=${n.dx.toFixed(0)} dy=${n.dy.toFixed(0)}`)
