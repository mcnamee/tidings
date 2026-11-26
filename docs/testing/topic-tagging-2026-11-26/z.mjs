import fs from 'fs';
const topics = JSON.parse(fs.readFileSync('topics.json')).map(t=>t[0]);
const R = JSON.parse(fs.readFileSync('scored-p.json'));
const K = topics.length, mean = Array(K).fill(0), sd = Array(K).fill(0);
for (const r of R) for (const [i,x] of r.s) mean[i]+=x/R.length;
for (const r of R) for (const [i,x] of r.s) sd[i]+=(x-mean[i])**2/R.length;
for (let i=0;i<K;i++) sd[i]=Math.sqrt(sd[i]);
const Z1 = +process.argv[2]||2.0, Z2 = +process.argv[3]||2.5;
for (const r of R) { r.z = r.s.map(([i,x])=>[i,(x-mean[i])/sd[i]]).sort((a,b)=>b[1]-a[1]);
  r.tags = r.z.filter(([i,z],k)=> k===0 ? z>=Z1 : z>=Z2).slice(0,3).map(([i])=>topics[i]); }
fs.writeFileSync('z.json', JSON.stringify({mean,sd}));
fs.writeFileSync('tagged.json', JSON.stringify(R.map(({id,feed,folder,title,summary,tags,z})=>({id,feed,folder,title,summary,tags,z:z.slice(0,4).map(([i,v])=>[topics[i],+v.toFixed(2)])}))));
const n = R.length, none = R.filter(r=>!r.tags.length).length, cnt = R.map(r=>r.tags.length);
console.log(`Z1=${Z1} Z2=${Z2} untagged ${(100*none/n).toFixed(1)}% avg tags ${(cnt.reduce((a,b)=>a+b)/n).toFixed(2)}`);
const per = {}; for (const r of R) for (const t of r.tags) per[t]=(per[t]||0)+1;
console.log(Object.entries(per).sort((a,b)=>b[1]-a[1]).map(([t,c])=>`${t} ${c}`).join(' · '));
