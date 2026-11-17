/**
 * Pure analysis for the AC13 gate: the GraphQL query, response parsing, the pass/fail rules and the
 * results table. No I/O, so it is unit-tested with canned responses. The CLI in `analyze.ts` does
 * the HTTP.
 *
 * CPU comes from Cloudflare GraphQL Analytics (`workersInvocationsAdaptive`, CPU in microseconds),
 * never from `performance.now()`.
 */
import type { Scenario } from './scenarios';

/** One measured window: calls made to one scenario between `from` and `to` (RFC 3339, UTC). */
export interface Window {
  id: string;
  /** `first` and `cold` windows are recorded, not gated. */
  role: 'measure' | 'first' | 'cold';
  from: string;
  to: string;
  calls: number;
}

export interface RunRecord {
  script: string;
  startedAt: string;
  origin: string;
  newItems: number;
  scenarios: Scenario[];
  windows: Window[];
}

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** Quantile fields the dataset may expose, in the order we report them. P95 may not exist. */
export const QUANTILE_CANDIDATES = [
  'cpuTimeP50',
  'cpuTimeP75',
  'cpuTimeP90',
  'cpuTimeP95',
  'cpuTimeP99',
  'cpuTimeP999',
] as const;
export type QuantileField = (typeof QUANTILE_CANDIDATES)[number];

export const THRESHOLD_FILTER = 'cpuTimeUs_gt';

/**
 * `quantileFields` come from schema introspection (or the default list). `thresholdUs` adds a
 * filter that counts only invocations above that CPU time, when the schema offers one.
 */
export function buildQuery(
  quantileFields: readonly string[],
  opts: { thresholdUs?: number } = {},
): string {
  const threshold =
    opts.thresholdUs === undefined ? '' : `, ${THRESHOLD_FILTER}: ${opts.thresholdUs}`;
  return `query Bench($accountTag: String!, $script: String!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 50
        filter: { scriptName: $script, datetime_geq: $from, datetime_lt: $to${threshold} }
      ) {
        dimensions { status }
        sum { requests errors subrequests }
        quantiles { ${quantileFields.join(' ')} }
      }
    }
  }
}`;
}

export const INTROSPECT_QUERY = `query Introspect {
  group: __type(name: "AccountWorkersInvocationsAdaptiveGroup") {
    fields { name type { name ofType { name } } }
  }
  filter: __type(name: "AccountWorkersInvocationsAdaptiveFilter_InputObject") {
    inputFields { name }
  }
}`;

export interface Schema {
  quantileFields: string[];
  hasThresholdFilter: boolean;
  /** Name of the quantiles object type, when found. */
  quantilesType: string | null;
}

interface TypeRef {
  name: string | null;
  ofType?: { name: string | null } | null;
}

/** Reads the introspection result; the quantile field names come from a second query. */
export function parseSchema(data: {
  group?: { fields?: { name: string; type: TypeRef }[] } | null;
  filter?: { inputFields?: { name: string }[] } | null;
}): Pick<Schema, 'hasThresholdFilter' | 'quantilesType'> {
  const q = data.group?.fields?.find((f) => f.name === 'quantiles');
  const quantilesType = q?.type.name ?? q?.type.ofType?.name ?? null;
  const hasThresholdFilter = !!data.filter?.inputFields?.some((f) => f.name === THRESHOLD_FILTER);
  return { quantilesType, hasThresholdFilter };
}

export function quantileTypeQuery(typeName: string): string {
  return `query Q { t: __type(name: ${JSON.stringify(typeName)}) { fields { name } } }`;
}

export function pickQuantileFields(available: readonly string[] | null): string[] {
  if (!available) return ['cpuTimeP50', 'cpuTimeP75', 'cpuTimeP90', 'cpuTimeP99', 'cpuTimeP999'];
  return QUANTILE_CANDIDATES.filter((f) => available.includes(f));
}

export interface WindowStats {
  requests: number;
  byStatus: Record<string, number>;
  exceededCpu: number;
  /** CPU quantiles in milliseconds, by field name. */
  quantilesMs: Partial<Record<QuantileField, number>>;
}

interface GraphqlGroup {
  dimensions?: { status?: string };
  sum?: { requests?: number };
  quantiles?: Record<string, number | null>;
}

export interface GraphqlResponse {
  data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: GraphqlGroup[] }[] } };
  errors?: { message: string }[];
}

/**
 * Folds the per-status groups of one window into one record. Quantiles are taken from the
 * `success` group (an `exceededCpu` group has its own and is counted separately); with a single
 * group that is the one used.
 */
export function parseWindow(res: GraphqlResponse): WindowStats {
  if (res.errors?.length)
    throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join('; ')}`);
  const groups = res.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const byStatus: Record<string, number> = {};
  for (const g of groups) {
    const status = g.dimensions?.status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + (g.sum?.requests ?? 0);
  }
  const main = groups.find((g) => g.dimensions?.status === 'success') ?? groups[0];
  const quantilesMs: WindowStats['quantilesMs'] = {};
  for (const f of QUANTILE_CANDIDATES) {
    const us = main?.quantiles?.[f];
    if (typeof us === 'number') quantilesMs[f] = us / 1000;
  }
  const requests = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { requests, byStatus, exceededCpu: byStatus['exceededCpu'] ?? 0, quantilesMs };
}

export type Verdict = 'PASS' | 'FAIL' | 'PROVISIONAL' | 'INFO' | 'NO DATA';

export interface Row {
  window: Window;
  scenario: Scenario | undefined;
  stats: WindowStats;
  /** Invocations above the p95 ceiling, when the threshold query ran. */
  aboveCeiling: number | null;
  verdict: Verdict;
  note: string;
}

/**
 * The gate (ADR 0006 item 6): zero `exceededCpu` and p95 <= the scenario's ceiling. Analytics does
 * not necessarily expose p95, so in order: an exact `cpuTimeP95`; else the share of invocations above
 * the ceiling (<= 5% is p95 <= ceiling); else a provisional read from p90 that the PM must judge.
 */
export function evaluate(
  window: Window,
  scenario: Scenario | undefined,
  stats: WindowStats,
  aboveCeiling: number | null,
): Row {
  const base = { window, scenario, stats, aboveCeiling };
  if (stats.requests === 0)
    return { ...base, verdict: 'NO DATA', note: 'no invocations found yet' };
  const ceiling = scenario?.p95Ms;
  const gated = window.role === 'measure' && ceiling !== undefined;
  const notes: string[] = [];
  if (stats.requests < window.calls * 0.98) {
    notes.push(
      `analytics saw ${stats.requests} of ${window.calls} calls (adaptive sampling or delay)`,
    );
  }
  if (!gated) return { ...base, verdict: 'INFO', note: notes.join('; ') };
  if (stats.exceededCpu > 0) {
    return {
      ...base,
      verdict: 'FAIL',
      note: [`${stats.exceededCpu} exceededCpu`, ...notes].join('; '),
    };
  }
  const q = stats.quantilesMs;
  let verdict: Verdict;
  if (q.cpuTimeP95 !== undefined) {
    verdict = q.cpuTimeP95 <= ceiling ? 'PASS' : 'FAIL';
    notes.push('p95 exact');
  } else if (aboveCeiling !== null) {
    const share = aboveCeiling / stats.requests;
    verdict = share <= 0.05 ? 'PASS' : 'FAIL';
    notes.push(
      `${aboveCeiling}/${stats.requests} above ${ceiling} ms (${(share * 100).toFixed(1)}%)`,
    );
  } else if (q.cpuTimeP90 !== undefined && q.cpuTimeP90 > ceiling) {
    verdict = 'FAIL';
    notes.push('p90 already above the ceiling, so p95 is too');
  } else {
    verdict = 'PROVISIONAL';
    notes.push('p95 not exposed by Analytics; PM to judge from p90 and p99');
  }
  return { ...base, verdict, note: notes.join('; ') };
}

const fmt = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(2));

/** The table that goes into ADR 0006 under "Results (TID-012)". CPU in ms. */
export function toMarkdown(rows: readonly Row[]): string {
  const head =
    '| Scenario | Role | Calls | Seen | exceededCpu | p50 | p75 | p90 | p95 | p99 | p99.9 | Ceiling | Verdict | Note |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((r) => {
    const q = r.stats.quantilesMs;
    return (
      `| ${r.window.id} | ${r.window.role} | ${r.window.calls} | ${r.stats.requests} | ${r.stats.exceededCpu} ` +
      `| ${fmt(q.cpuTimeP50)} | ${fmt(q.cpuTimeP75)} | ${fmt(q.cpuTimeP90)} | ${fmt(q.cpuTimeP95)} ` +
      `| ${fmt(q.cpuTimeP99)} | ${fmt(q.cpuTimeP999)} | ${r.scenario?.p95Ms ?? '-'} | ${r.verdict} | ${r.note || ''} |`
    );
  });
  return [head, ...lines].join('\n');
}

/** True only when every gated row passed (provisional rows need the PM). */
export function overall(rows: readonly Row[]): 'PASS' | 'FAIL' | 'NEEDS PM' {
  const gated = rows.filter((r) => r.window.role === 'measure' && r.scenario?.p95Ms !== undefined);
  if (gated.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (gated.every((r) => r.verdict === 'PASS')) return 'PASS';
  return 'NEEDS PM';
}
