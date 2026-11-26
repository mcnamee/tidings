// AC3 of TID-077: the production tagging prompt (batches of 20, numeric answers, the 28-topic list)
// run against the real model over the gold set. The prompt and parser are the Worker's own code
// (apps/worker/src/recommend/topics.ts), bundled with esbuild, so this tests what ships.
//
//   START=<first batch index, default 0> node llm-batch20.mjs [batches=6] [batchSize=20] [model]
//
// Calls the Workers AI REST API through curl (the agent proxy swaps the placeholder token for the real
// one; Node's fetch bypasses the proxy). It stops after `batches` calls, because each costs about
// 70 to 100 neurons. Prints one line per batch and a summary; writes batch20-results.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const maxBatches = Number(process.argv[2] ?? 6);
const size = Number(process.argv[3] ?? 20);
const model = process.argv[4] ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const ACCOUNT = '72f8c2f186ccd349773a913a4e07e8e5';

// Bundle the Worker's prompt builder and parser, and the shared topic list, into one module.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-prompt-'));
const bundle = path.join(tmp, 'prompt.mjs');
fs.writeFileSync(
  path.join(tmp, 'entry.ts'),
  `export { buildTagPrompt, parseTagAnswer } from ${JSON.stringify(path.join(repo, 'apps/worker/src/recommend/topics.ts'))};\n` +
    `export { TOPICS } from ${JSON.stringify(path.join(repo, 'packages/shared/src/topics.ts'))};\n`,
);
execFileSync(
  'npx',
  ['esbuild', path.join(tmp, 'entry.ts'), '--bundle', '--format=esm', `--outfile=${bundle}`, '--log-level=error'],
  { cwd: repo, stdio: 'inherit' },
);
const { buildTagPrompt, parseTagAnswer, TOPICS } = await import(pathToFileURL(bundle).href);

const sample = JSON.parse(fs.readFileSync(path.join(here, 'sample.json'), 'utf8'));
const idByName = new Map(TOPICS.map((t) => [t.name, t.id]));
const gold = fs
  .readFileSync(path.join(here, 'gold.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    const [, ...r] = l.split(' ');
    const s = r.join(' ').trim();
    return s ? s.split(';').map((n) => idByName.get(n)) : [];
  });
if (gold.some((g) => g.includes(undefined))) throw new Error('gold names not in the topic list');
const nameOf = (id) => TOPICS.find((t) => t.id === id)?.name ?? `#${id}`;

const results = [];
let inTok = 0;
let outTok = 0;
const startBatch = Number(process.env.START ?? 0);
const batches = Math.min(startBatch + maxBatches, Math.ceil(sample.length / size));
for (let b = startBatch; b < batches; b++) {
  const items = sample.slice(b * size, b * size + size);
  const p = buildTagPrompt(items);
  const body = path.join(tmp, 'body.json');
  fs.writeFileSync(
    body,
    JSON.stringify({
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      max_tokens: p.maxTokens,
      temperature: 0,
    }),
  );
  const out = JSON.parse(
    execFileSync(
      'curl',
      [
        '-s',
        '-X',
        'POST',
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`,
        '-H',
        'Authorization: Bearer placeholder',
        '-H',
        'Content-Type: application/json',
        '--data',
        `@${body}`,
      ],
      { encoding: 'utf8' },
    ),
  );
  if (!out.success) {
    console.error(JSON.stringify(out.errors));
    process.exit(1);
  }
  const text = out.result.response;
  const usage = out.result.usage ?? {};
  inTok += usage.prompt_tokens ?? 0;
  outTok += usage.completion_tokens ?? 0;
  const answers = parseTagAnswer(text, items.length);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const neurons = ((usage.prompt_tokens ?? 0) * 26668 + (usage.completion_tokens ?? 0) * 204805) / 1e6;
  console.log(
    `batch ${b + 1}: ${items.length} articles, ${lines.length} answer lines, ${answers.size} parsed, ` +
      `${usage.prompt_tokens} in + ${usage.completion_tokens} out tokens = ${neurons.toFixed(1)} neurons`,
  );
  items.forEach((it, i) =>
    results.push({
      index: b * size + i,
      batch: b + 1,
      position: i + 1,
      predicted: answers.has(i + 1) ? answers.get(i + 1) : null,
    }),
  );
  results.at(-1).rawLines = lines; // last item only; keeps the file small
  fs.writeFileSync(path.join(here, `batch20-raw-${b + 1}.txt`), text.trim() + '\n');
}

// Scoring over the labelled articles that were run.
let n = 0;
let first = 0;
let tp = 0;
let fp = 0;
let fn = 0;
let noLine = 0;
let none = 0;
const suspects = [];
const misses = [];
for (const r of results) {
  const g = gold[r.index];
  if (!g.length) continue;
  n++;
  if (r.predicted === null) {
    noLine++;
    continue;
  }
  if (r.predicted.length === 0) {
    none++;
    continue;
  }
  const ok = g.includes(r.predicted[0]);
  if (ok) first++;
  else {
    misses.push(r);
    // Misaligned = misses its own gold but its first tag is the first gold tag of another article
    // in the same batch, i.e. the answer line looks like it belongs to someone else.
    const other = results.find(
      (o) => o.batch === r.batch && o.index !== r.index && (gold[o.index] ?? []).includes(r.predicted[0]) && !g.some((t) => (gold[o.index] ?? []).includes(t)),
    );
    if (other && Math.abs(other.position - r.position) === 1) suspects.push({ at: r.index, from: other.index });
  }
  tp += r.predicted.filter((t) => g.includes(t)).length;
  fp += r.predicted.filter((t) => !g.includes(t)).length;
  fn += g.filter((t) => !r.predicted.includes(t)).length;
}
// Shift test per batch: alignment holds if predicting article i's gold from line i beats line i+1 and i-1.
const shift = {};
for (const r of results) {
  const g = gold[r.index];
  if (!g.length || !r.predicted?.length) continue;
  for (const d of [-1, 0, 1]) {
    const o = results.find((x) => x.batch === r.batch && x.position === r.position + d);
    const og = o ? gold[o.index] : null;
    if (!og || !og.length) continue;
    shift[d] ??= { hit: 0, n: 0 };
    shift[d].n++;
    if (og.includes(r.predicted[0])) shift[d].hit++;
  }
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
console.log(`\nmodel ${model}; ${results.length} articles in ${batches} batches of ${size}; ${n} labelled`);
console.log(`first tag right ${first}/${n} = ${pct(first, n)}; precision ${pct(tp, tp + fp)}; recall ${pct(tp, tp + fn)}`);
console.log(`articles with no parsed line (fallback in production): ${noLine}; answered 0 (no topic): ${none}`);
console.log(`alignment: first tag matches own gold ${pct(shift[0]?.hit ?? 0, shift[0]?.n ?? 0)}, previous article's gold ${pct(shift[-1]?.hit ?? 0, shift[-1]?.n ?? 0)}, next article's gold ${pct(shift[1]?.hit ?? 0, shift[1]?.n ?? 0)}`);
console.log(`misaligned suspects (miss own gold, hit a neighbour's only): ${suspects.length}`);
console.log(`tokens ${inTok} in + ${outTok} out = ${((inTok * 26668 + outTok * 204805) / 1e6).toFixed(1)} neurons, ${((inTok * 26668 + outTok * 204805) / 1e6 / results.length).toFixed(2)} per article`);
console.log('\nmisses (own gold -> predicted):');
for (const r of misses) {
  console.log(
    `  [${r.index}] ${sample[r.index].title.slice(0, 70)} | gold: ${gold[r.index].map(nameOf).join('; ')} | model: ${r.predicted.map(nameOf).join('; ')}`,
  );
}
fs.writeFileSync(
  path.join(here, 'batch20-results.json'),
  JSON.stringify({ model, size, batches, tokens: { in: inTok, out: outTok }, results: results.map(({ rawLines, ...r }) => r) }, null, 1),
);
