import fs from 'fs';
const topics = JSON.parse(fs.readFileSync('topics.json')).map(t=>t[0]);
const S = JSON.parse(fs.readFileSync('sample.json'));
const scored = new Map(JSON.parse(fs.readFileSync('scored-p.json')).map(r=>[r.id,r]));
const {mean, sd} = JSON.parse(fs.readFileSync('z.json'));
const gold = fs.readFileSync('gold.txt','utf8').trim().split('\n').map(l=>{const [k,...r]=l.split(' ');const s=r.join(' ').trim();return s?s.split(';'):[];});
for (const g of gold) for (const t of g) if(!topics.includes(t)) throw t;
function run(name, tag){ let tp=0,fp=0,fn=0,top1=0,clean=0,none=0,n=0;
  S.forEach((r,k)=>{ const p=tag(scored.get(r.id).s); const g=gold[k]; if(!g.length) return; n++;
    const P=p.map(i=>topics[i]); tp+=P.filter(t=>g.includes(t)).length; fp+=P.filter(t=>!g.includes(t)).length; fn+=g.filter(t=>!P.includes(t)).length;
    if(P.length && g.includes(P[0])) top1++; if(P.length && P.every(t=>g.includes(t))) clean++; if(!P.length) none++; });
  console.log(name.padEnd(28), `precision ${(100*tp/(tp+fp)).toFixed(0)}%  recall ${(100*tp/(tp+fn)).toFixed(0)}%  first-tag right ${(100*top1/n).toFixed(0)}%  all-tags right ${(100*clean/n).toFixed(0)}%  untagged ${(100*none/n).toFixed(0)}%`); }
const zs = s => s.map(([i,x])=>[i,(x-mean[i])/sd[i]]).sort((a,b)=>b[1]-a[1]);
run('raw top-1', s=>[s[0][0]]);
run('raw top-3', s=>s.slice(0,3).map(x=>x[0]));
for (const m of [0.02,0.04]) run(`raw top1 + within ${m}`, s=>s.filter(([i,x],k)=>k===0||x>=s[0][1]-m).slice(0,3).map(x=>x[0]));
run('z top-1', s=>[zs(s)[0][0]]);
for (const [a,b] of [[0,1.5],[0,2],[0,2.5],[1,2],[1,2.5],[1.5,2.5]]) run(`z first>=${a} more>=${b}`, s=>zs(s).filter(([i,z],k)=>k===0?z>=a:z>=b).slice(0,3).map(x=>x[0]));
