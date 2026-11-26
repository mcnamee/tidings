import fs from 'fs';
const topics = JSON.parse(fs.readFileSync('topics.json'));
const tv = JSON.parse(fs.readFileSync('topicvec.json')).result.data;
const variant = process.argv[2] === 'q' ? topics.length : 0;
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const T = topics.map((t, i) => norm(tv[variant + i]));
const rows = ['rows0.json','rows500.json','rows1000.json'].flatMap(f => JSON.parse(fs.readFileSync(f)).result[0].results);
const dec = s => { const b = Buffer.from(s, 'base64'); const sc = b.readFloatLE(0); const out=[]; for (let i=0;i<384;i++) out.push(b.readInt8(4+i)*sc/127); return norm(out); };
const seen = new Set(); const R = [];
for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); const v = dec(r.vec);
  const s = T.map((t,i)=>[i, t.reduce((a,x,j)=>a+x*v[j],0)]).sort((a,b)=>b[1]-a[1]);
  R.push({...r, vec:undefined, s}); }
fs.writeFileSync(`scored-${process.argv[2]||'p'}.json`, JSON.stringify(R));
const tops = R.map(r=>r.s[0][1]).sort((a,b)=>a-b); const q=p=>tops[Math.floor(p*(tops.length-1))].toFixed(3);
const gaps = R.map(r=>r.s[0][1]-r.s[1][1]).sort((a,b)=>a-b); const g=p=>gaps[Math.floor(p*(gaps.length-1))].toFixed(3);
console.log(process.argv[2]||'plain', 'n', R.length, 'top1 p10/50/90', q(.1), q(.5), q(.9), 'gap p50', g(.5));
