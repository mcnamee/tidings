/**
 * Runs the AC13 benchmark against the deployed throwaway Workers. Run with Node 22.18+:
 *
 *   node apps/worker/bench/run-benchmark.ts --driver https://tidings-bench-driver.<sub>.workers.dev \
 *        --origin https://tidings-bench-origin.<sub>.workers.dev --token "$BENCH_TOKEN"
 *
 * It only drives load and records time windows (from the driver's own `Date` headers, so local clock
 * skew doesn't matter) into `apps/worker/bench/results/run-<time>.json`. It reads no Cloudflare
 * credentials. CPU is read afterwards by `analyze.ts`.
 *
 * Options: --runs 200 (measured calls per scenario), --new-items 3, --only <ids,comma,separated>,
 * --script tidings-bench, --gap 10 (seconds between windows).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { RunRecord, Window } from './analysis.ts';
import { COLD_ID, DEFAULT_NEW_ITEMS, FIRST_SUFFIX, scenarios, type Scenario } from './scenarios.ts';
import type { RunSummary } from './driver-worker.ts';

const BATCH = 20;

const { values } = parseArgs({
  options: {
    driver: { type: 'string' },
    origin: { type: 'string' },
    token: { type: 'string' },
    runs: { type: 'string', default: '200' },
    'new-items': { type: 'string', default: String(DEFAULT_NEW_ITEMS) },
    only: { type: 'string' },
    script: { type: 'string', default: 'tidings-bench' },
    gap: { type: 'string', default: '10' },
  },
});

function need(name: 'driver' | 'origin' | 'token'): string {
  const v = values[name];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

const driver = need('driver').replace(/\/$/, '');
const origin = need('origin').replace(/\/$/, '');
const token = need('token');
const runs = Number(values.runs);
const newItems = Number(values['new-items']);
const gapMs = Number(values.gap) * 1000;
const only = values.only?.split(',');

const all = scenarios(newItems).filter((s) => !only || only.includes(s.id));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, body?: unknown): Promise<{ data: T; serverTime: number }> {
  const res = await fetch(driver + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Bench-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  const serverTime = Date.parse(res.headers.get('date') ?? '') || Date.now();
  return { data: (await res.json()) as T, serverTime };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const warnings: string[] = [];

function check(s: Scenario, sum: RunSummary, newItemsPerCall: number | null): void {
  const got = sum.results[s.expect.result] ?? 0;
  if (got !== sum.calls || sum.rejected > 0) {
    warnings.push(
      `${s.id}: expected ${sum.calls} x ${s.expect.result}, got ${JSON.stringify(sum.results)} (rejected ${sum.rejected})`,
    );
  }
  if (s.expect.errorCode && (sum.errorCodes[s.expect.errorCode] ?? 0) !== sum.calls) {
    warnings.push(
      `${s.id}: expected error ${s.expect.errorCode}, got ${JSON.stringify(sum.errorCodes)}`,
    );
  }
  if (newItemsPerCall !== null && sum.newEntries !== sum.calls * newItemsPerCall) {
    warnings.push(
      `${s.id}: expected ${sum.calls * newItemsPerCall} new entries, got ${sum.newEntries}`,
    );
  }
}

async function window(
  id: string,
  role: Window['role'],
  feedId: number,
  calls: number,
  s: Scenario,
): Promise<Window> {
  const before = await call<unknown>('/state');
  const from = Math.floor(before.serverTime / 1000) * 1000;
  let last = before.serverTime;
  for (let left = calls; left > 0; left -= BATCH) {
    const n = Math.min(BATCH, left);
    const r = await call<RunSummary>('/run', { feedId, n });
    last = r.serverTime;
    check(s, r.data, s.kind === 'changed' && role === 'measure' ? newItems : null);
  }
  const to = Math.ceil(last / 1000) * 1000 + 1000;
  console.log(`${id} (${role}): ${calls} calls, ${iso(from)} to ${iso(to)}`);
  return { id, role, from: iso(from), to: iso(to), calls };
}

async function main(): Promise<void> {
  console.log(
    `setup: ${all.length} scenarios, ${runs} measured calls each, ${newItems} new items per changed call`,
  );
  const { data } = await call<{ feeds: Record<string, number> }>('/setup', {
    origin,
    scenarios: all.map((s) => ({ id: s.id, path: s.path })),
  });

  // Build the origin's cached documents first so its own CPU never skews a refresh.
  for (const s of all)
    await fetch(origin + s.path)
      .then((r) => r.arrayBuffer())
      .catch(() => undefined);

  const windows: Window[] = [];
  const first = all.find((s) => s.id === 'changed:rss-typical') ?? all[0];
  if (!first) throw new Error('no scenarios selected');

  // Cold: the very first refresh after the deploy (a fresh isolate), on a typical feed.
  windows.push(await window(COLD_ID, 'cold', data.feeds[first.id] as number, 1, first));
  await sleep(gapMs);

  for (const s of all) {
    const feedId = data.feeds[s.id] as number;
    if (s.id !== first.id) {
      // The first refresh of a feed inserts its whole document; measured on its own, not gated.
      windows.push(await window(s.id + FIRST_SUFFIX, 'first', feedId, 1, s));
      await sleep(gapMs);
    }
    windows.push(await window(s.id, 'measure', feedId, runs, s));
    await sleep(gapMs);
  }

  const record: RunRecord = {
    script: values.script as string,
    startedAt: new Date().toISOString(),
    origin,
    newItems,
    scenarios: all,
    windows,
  };
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${record.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(`\nwrote ${file}`);
  console.log(`state: ${JSON.stringify((await call('/state')).data)}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} WARNING(S): the run did not behave as the scenarios expect`);
    for (const w of warnings) console.log(`  ${w}`);
    process.exitCode = 1;
  }
  console.log('\nWait at least 5 minutes for Analytics, then run analyze.ts with this file.');
}

await main();
