const V=[3840,2160]
console.log('若每轴切 n 次（n 列 n 行，共 n^2 块）：')
console.log(' 轴向精度 ≈ 帧尺寸 / (2n)   [目标落在块内 ±半块]')
for(const n of [2,4,8,16]){
  console.log(`  n=${String(n).padStart(2)}  ${String(n*n).padStart(3)} 块   x±${(V[0]/(2*n)).toFixed(0)}px  y±${(V[1]/(2*n)).toFixed(0)}px`)
}
console.log('')
console.log('对照实测定位误差：中位 2.0–12.7px（模型自报归一化坐标）')
console.log('⇒ 要达到实测水平只需 n≈150 以上；也就是说定位精度早已不是由块数决定，')
console.log('  而是由模型读出 u,v 的精度决定（约 0.2%–1.3% 相对误差）。')
