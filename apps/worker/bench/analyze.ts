/**
 * Reads CPU time for an AC13 run from Cloudflare GraphQL Analytics and prints the gate table. Run
 * with Node 22.18+, after waiting at least 5 minutes for Analytics to catch up:
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     node apps/worker/bench/analyze.ts apps/worker/bench/results/run-<time>.json
 *
 * The token needs only "Account Analytics: Read". It is read from the environment here, by the
 * person running the benchmark, and is never written anywhere. Add `--introspect` to print the
 * dataset's quantile and filter fields (Analytics may not expose p95).
 *
 * The query it sends, for one window:
 *
 *   workersInvocationsAdaptive(filter: { scriptName, datetime_geq, datetime_lt })
 *     { dimensions { status } sum { requests errors subrequests } quantiles { cpuTimeP50 ... } }
 *
 * and, only if the schema has a `cpuTimeUs_gt` filter, the same with `cpuTimeUs_gt: <ceiling>` to
 * count invocations above the p95 ceiling.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  buildQuery,
  evaluate,
  GRAPHQL_URL,
  INTROSPECT_QUERY,
  overall,
  parseSchema,
  parseWindow,
  pickQuantileFields,
  quantileTypeQuery,
  toMarkdown,
  type GraphqlResponse,
  type Row,
  type RunRecord,
} from './analysis.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { introspect: { type: 'boolean', default: false } },
});

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountTag) {
  console.error('set CLOUDFLARE_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID');
  process.exit(2);
}
const runFile = positionals[0];
if (!runFile && !values.introspect) {
  console.error('usage: analyze.ts <run-file.json> [--introspect]');
  process.exit(2);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function discoverSchema(): Promise<{ fields: string[]; threshold: boolean }> {
  try {
    const intro = await gql<{ data?: Parameters<typeof parseSchema>[0] }>(INTROSPECT_QUERY);
    const { quantilesType, hasThresholdFilter } = parseSchema(intro.data ?? {});
    let available: string[] | null = null;
    if (quantilesType) {
      const t = await gql<{ data?: { t?: { fields?: { name: string }[] } } }>(
        quantileTypeQuery(quantilesType),
      );
      available = t.data?.t?.fields?.map((f) => f.name) ?? null;
    }
    if (values.introspect) {
      console.log('quantile fields:', available ?? '(introspection unavailable)');
      console.log('has cpuTimeUs_gt filter:', hasThresholdFilter);
    }
    return { fields: pickQuantileFields(available), threshold: hasThresholdFilter };
  } catch (err) {
    console.error(`introspection failed, using default fields: ${String(err)}`);
    return { fields: pickQuantileFields(null), threshold: false };
  }
}

async function main(): Promise<void> {
  const schema = await discoverSchema();
  if (!runFile) return;
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as RunRecord;
  const rows: Row[] = [];

  for (const w of run.windows) {
    const scenario = run.scenarios.find((s) => w.id === s.id || w.id === `${s.id}:first`);
    const vars = { accountTag, script: run.script, from: w.from, to: w.to };
    const stats = parseWindow(await gql<GraphqlResponse>(buildQuery(schema.fields), vars));

    let above: number | null = null;
    const ceiling = scenario?.p95Ms;
    if (
      schema.threshold &&
      ceiling !== undefined &&
      w.role === 'measure' &&
      stats.quantilesMs.cpuTimeP95 === undefined
    ) {
      const over = parseWindow(
        await gql<GraphqlResponse>(
          buildQuery(schema.fields, { thresholdUs: ceiling * 1000 }),
          vars,
        ),
      );
      above = over.requests;
    }
    rows.push(evaluate(w, scenario, stats, above));
  }

  const table = toMarkdown(rows);
  const verdict = overall(rows);
  const out = `${table}\n\nOverall: ${verdict}\n`;
  console.log(`\n${out}`);
  writeFileSync(runFile.replace(/\.json$/, '.md'), out);
  console.log(`wrote ${runFile.replace(/\.json$/, '.md')}`);
  process.exitCode = verdict === 'FAIL' ? 1 : 0;
}

await main();
