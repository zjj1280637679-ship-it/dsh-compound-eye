import { readFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const DSH = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek--\\'
function zm(buf){const M=Buffer.from([0x28,0xb5,0x2f,0xfd]);const st=[];let i=0
while(i>=0&&i<buf.length){const at=buf.indexOf(M,i);if(at<0)break;st.push(at);i=at+4}
const o=[];for(let k=0;k<st.length;k++){const e=k+1<st.length?st[k+1]:buf.length
try{o.push(zstdDecompressSync(buf.subarray(st[k],e)))}catch{}}
return Buffer.concat(o).toString('utf8')}
function usages(node,acc){if(!node||typeof node!=='object')return acc
 if(typeof node.inputTokens==='number'){acc.push(node);return acc}
 for(const k of Object.keys(node))usages(node[k],acc);return acc}

// 实验二 doubao 五臂
const RUNS={r1:'2d1bce6e-954a-4e36-ac3f-895f225f9d18',r2:'f31b9e32-f6f4-42a4-a61d-95639d1df7f6',
 r3:'c24de97e-5195-4925-9801-78c0e00edbf1',r4:'74fdae42-41ab-49fc-a241-00f7e5490f02',
 r5:'fc3cf1dd-40be-4f10-97eb-3753060abd39'}
console.log('臂   步数  逐步 inputTokens                        累计输入   其中 cacheRead')
for(const [r,id] of Object.entries(RUNS)){
  const p=DSH+id+'\\session.v3.jsonl.zstd'
  if(!existsSync(p)){console.log(r,'缺');continue}
  const evs=zm(readFileSync(p)).split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
  const steps=[]
  for(const e of evs){ if(e.type!=='assistant/message')continue
    const u=usages(e.data,[]); if(!u.length)continue
    const seen=new Set(), uniq=[]; for(const x of u){const k=JSON.stringify(x); if(!seen.has(k)){seen.add(k);uniq.push(x)}}
    uniq.sort((a,b)=>Object.keys(b).length-Object.keys(a).length); steps.push(uniq[0]) }
  const inp=steps.reduce((a,s)=>a+s.inputTokens,0)
  const cache=steps.reduce((a,s)=>a+(s.cacheReadTokens||0),0)
  console.log(`${r}   ${String(steps.length).padStart(2)}   [${steps.map(s=>s.inputTokens).join(', ')}]`)
  console.log(`      累计 input ${inp.toLocaleString()}   cacheRead ${cache.toLocaleString()}`)
}
