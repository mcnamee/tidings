import { execFileSync } from 'child_process';
import fs from 'fs';
const model = process.argv[2] || '@cf/meta/llama-3.1-8b-instruct';
const topics = JSON.parse(fs.readFileSync('topics.json'));
const S = JSON.parse(fs.readFileSync('sample.json'));
const sys = `You tag news articles with topics. Topics:\n${topics.map(t=>`- ${t[0]}: ${t[1]}`).join('\n')}\n\nFor each numbered article, give 1 to 3 topics from the list, most relevant first. Only add a second or third topic if the article is clearly about it too. Use the exact topic names. Answer with one line per article in the form "N: Topic; Topic" and nothing else.`;
const out = {};
for (let b = 0; b < S.length; b += 10) {
  const batch = S.slice(b, b+10);
  const user = batch.map((r,j)=>`${b+j}. [${r.feed}] ${r.title}. ${(r.summary||'').replace(/\s+/g,' ').slice(0,200)}`).join('\n');
  fs.writeFileSync('body.json', JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:user}], max_tokens: 400, temperature: 0}));
  const j = JSON.parse(execFileSync('curl', ['-s','-X','POST',`https://api.cloudflare.com/client/v4/accounts/72f8c2f186ccd349773a913a4e07e8e5/ai/run/${model}`,'-H','Authorization: Bearer placeholder','-H','Content-Type: application/json','--data','@body.json'], {encoding:'utf8'})); if (!j.success) { console.error(JSON.stringify(j.errors)); process.exit(1); }
  const text = j.result.response;  if (b===0) console.error('usage', JSON.stringify(j.result.usage));
  for (const line of text.split('\n')) { const m = /^\s*(?:\d+[:.]\s*)?(\d+)[:.]\s*(.*)$/.exec(line); if (m) out[m[1]] = m[2].split(/;|,/).map(s=>s.trim()).filter(s=>topics.some(t=>t[0]===s)).slice(0,3); }
}
fs.writeFileSync(`llm-${model.split('/').pop()}.json`, JSON.stringify(out));
const gold = fs.readFileSync('gold.txt','utf8').trim().split('\n').map(l=>{const [k,...r]=l.split(' ');const s=r.join(' ').trim();return s?s.split(';'):[];});
let tp=0,fp=0,fn=0,top1=0,clean=0,none=0,n=0;
S.forEach((r,k)=>{ const g=gold[k]; if(!g.length) return; n++; const P=out[k]||[];
  tp+=P.filter(t=>g.includes(t)).length; fp+=P.filter(t=>!g.includes(t)).length; fn+=g.filter(t=>!P.includes(t)).length;
  if(P.length&&g.includes(P[0])) top1++; if(P.length&&P.every(t=>g.includes(t))) clean++; if(!P.length) none++; });
console.log(model.padEnd(28), `precision ${(100*tp/(tp+fp)).toFixed(0)}%  recall ${(100*tp/(tp+fn)).toFixed(0)}%  first-tag right ${(100*top1/n).toFixed(0)}%  all-tags right ${(100*clean/n).toFixed(0)}%  untagged ${(100*none/n).toFixed(0)}%`);
