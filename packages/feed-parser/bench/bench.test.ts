// Informational parse benchmark (ADR 0006 decision 9): run with `npm run bench -w @tidings/feed-parser`.
// Node timings do NOT predict Workers CPU; the CPU gate is measured on the deployed Free plan in
// TID-012. This is hosted by vitest only so it can import the TypeScript sources without a build.
import { it } from 'vitest';
import {
  GENERATED_FEEDS,
  generatedFeed,
  type GeneratedFeedName,
} from '../../../e2e/fixtures/generate-feeds';
import { parseFeed } from '../src/parse';
import { MAX_ITEMS_PER_FETCH } from '../src/limits';

const RUNS = Number(process.env['BENCH_RUNS'] ?? 200);
const WARMUP = 30;
const FETCHED_AT = Date.UTC(2026, 10, 10, 12) / 1000;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

it('prints p50/p95 parse time per generated fixture', { timeout: 120_000 }, () => {
  const rows: string[] = [];
  for (const name of Object.keys(GENERATED_FEEDS) as GeneratedFeedName[]) {
    const xml = generatedFeed(name);
    let items = 0;
    for (let i = 0; i < WARMUP; i++) parseFeed(xml, { fetchedAt: FETCHED_AT });
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const r = parseFeed(xml, { fetchedAt: FETCHED_AT });
      times.push(performance.now() - t0);
      if (r.ok) items = r.feed.items.length;
    }
    times.sort((a, b) => a - b);
    rows.push(
      `${name.padEnd(13)} ${String(xml.length).padStart(9)} ${String(items).padStart(6)} ` +
        `${percentile(times, 50).toFixed(3).padStart(9)} ${percentile(times, 95).toFixed(3).padStart(9)} ` +
        `${(times[times.length - 1] ?? 0).toFixed(3).padStart(9)}`,
    );
  }
  const header = `${'fixture'.padEnd(13)} ${'bytes'.padStart(9)} ${'items'.padStart(6)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)} ${'max ms'.padStart(9)}`;
  console.log(
    [
      '',
      `Feed parse benchmark (Node ${process.version}, ${RUNS} runs after ${WARMUP} warm-ups, cap ${MAX_ITEMS_PER_FETCH} items).`,
      'Informational only: Node timings do not predict Workers CPU. rss-huge is rejected as too_large in production.',
      header,
      ...rows,
      '',
    ].join('\n'),
  );
});
