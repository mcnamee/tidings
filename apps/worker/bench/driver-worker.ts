/**
 * Benchmark driver for AC13 (deployed as `tidings-bench-driver`, deleted afterwards). It owns no
 * measurement: it only sets up the throwaway D1 and calls the real `FeedRefresher.refresh` of the
 * `tidings-bench` Worker through a service binding, one call after another. CPU is read from
 * Cloudflare GraphQL Analytics for the `tidings-bench` script, never from the driver.
 *
 * Endpoints (all need `X-Bench-Token`):
 *   POST /setup  { origin, scenarios: [{ id, path }] }  reset the data, one feed + subscriber per scenario
 *   POST /run    { feedId, n }                           n (<= 20) sequential refreshes, returns a summary
 *   GET  /state                                          row counts, for the operator's sanity check
 *
 * n is capped at 20 per request: each call is a service-binding subrequest and a D1 read, and the
 * Free plan allows 50 of each per invocation.
 */
import { Db, sql } from '../src/db';
import type { RefreshJob, RefreshOutcome } from '../src/refresh/types';

export const MAX_CALLS_PER_REQUEST = 20;

export interface DriverEnv {
  DB: D1Database;
  REFRESHER: { refresh(job: RefreshJob): Promise<RefreshOutcome> };
  BENCH_TOKEN: string;
}

export interface RunSummary {
  feedId: number;
  calls: number;
  results: Record<string, number>;
  errorCodes: Record<string, number>;
  newEntries: number;
  /** Per call, from D1 `meta`: min and max rows read and written inside the refresh. */
  rowsRead: { min: number; max: number };
  rowsWritten: { min: number; max: number };
  rejected: number;
}

interface FeedRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
  body_hash: string | null;
  error_count: number;
  state: RefreshJob['state'];
  fetch_interval_s: number;
  last_success_at: number | null;
  recent_keys: string | null;
  new_entries_day: number | null;
  new_entries_count: number;
  warning_code: string | null;
}

async function jobFor(db: Db, feedId: number): Promise<RefreshJob> {
  const { rows } = await db.all<FeedRow>(
    sql(
      `SELECT id, url, etag, last_modified, body_hash, error_count, state, fetch_interval_s,
              last_success_at, recent_keys, new_entries_day, new_entries_count,
              warning_code FROM feeds WHERE id = ?`,
      feedId,
    ),
  );
  const r = rows[0];
  if (!r) throw new Error(`no feed ${feedId}`);
  return {
    feedId: r.id,
    url: r.url,
    etag: r.etag,
    lastModified: r.last_modified,
    bodyHash: r.body_hash,
    errorCount: r.error_count,
    state: r.state,
    fetchIntervalS: r.fetch_interval_s,
    lastSuccessAt: r.last_success_at,
    recentKeys: r.recent_keys,
    newEntriesDay: r.new_entries_day,
    newEntriesCount: r.new_entries_count,
    warningCode: r.warning_code,
  };
}

export async function runBatch(env: DriverEnv, feedId: number, n: number): Promise<RunSummary> {
  const db = new Db(env.DB);
  const calls = Math.max(1, Math.min(Math.trunc(n), MAX_CALLS_PER_REQUEST));
  const summary: RunSummary = {
    feedId,
    calls,
    results: {},
    errorCodes: {},
    newEntries: 0,
    rowsRead: { min: Infinity, max: 0 },
    rowsWritten: { min: Infinity, max: 0 },
    rejected: 0,
  };
  for (let i = 0; i < calls; i++) {
    const job = await jobFor(db, feedId);
    let out: RefreshOutcome;
    try {
      out = await env.REFRESHER.refresh(job);
    } catch {
      summary.rejected += 1;
      continue;
    }
    summary.results[out.result] = (summary.results[out.result] ?? 0) + 1;
    if (out.errorCode)
      summary.errorCodes[out.errorCode] = (summary.errorCodes[out.errorCode] ?? 0) + 1;
    summary.newEntries += out.newEntries;
    summary.rowsRead.min = Math.min(summary.rowsRead.min, out.usage.rowsRead);
    summary.rowsRead.max = Math.max(summary.rowsRead.max, out.usage.rowsRead);
    summary.rowsWritten.min = Math.min(summary.rowsWritten.min, out.usage.rowsWritten);
    summary.rowsWritten.max = Math.max(summary.rowsWritten.max, out.usage.rowsWritten);
  }
  if (summary.rowsRead.min === Infinity) summary.rowsRead.min = 0;
  if (summary.rowsWritten.min === Infinity) summary.rowsWritten.min = 0;
  return summary;
}

export interface SetupBody {
  origin: string;
  scenarios: { id: string; path: string }[];
}

/** Resets the throwaway data and creates one feed (id 1, 2, ...) with one subscriber per scenario. */
export async function setup(
  env: DriverEnv,
  body: SetupBody,
): Promise<{ feeds: Record<string, number> }> {
  const origin = new URL(body.origin);
  if (origin.protocol !== 'https:') throw new Error('origin must be https');
  const db = new Db(env.DB);
  for (const t of ['user_entries', 'entries', 'subscriptions', 'feeds', 'users']) {
    // Fixed table names, no input; `Db` takes statements, so build them from the list above.
    await db.run(sql(`DELETE FROM ${t}`));
  }
  await db.run(
    sql(
      "INSERT INTO users (id, display_name, role, created_at) VALUES ('bench', 'Bench', 'owner', 0)",
    ),
  );
  const feeds: Record<string, number> = {};
  let id = 0;
  for (const s of body.scenarios) {
    id += 1;
    feeds[s.id] = id;
    await db.run(
      sql(
        `INSERT INTO feeds (id, url, next_fetch_at, state, created_at)
         VALUES (?, ?, 0, 'pending', 0)`,
        id,
        new URL(s.path, origin).toString(),
      ),
    );
    await db.run(
      sql(
        "INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES (?, 'bench', ?, 0)",
        `sub-${id}`,
        id,
      ),
    );
  }
  return { feeds };
}

async function state(env: DriverEnv): Promise<Record<string, number>> {
  const db = new Db(env.DB);
  const out: Record<string, number> = {};
  for (const [key, query] of [
    ['feeds', 'SELECT COUNT(*) AS n FROM feeds'],
    ['entries', 'SELECT COUNT(*) AS n FROM entries'],
    ['user_entries', 'SELECT COUNT(*) AS n FROM user_entries'],
  ] as const) {
    out[key] = (await db.all<{ n: number }>(sql(query))).rows[0]?.n ?? 0;
  }
  return out;
}

export default {
  async fetch(request: Request, env: DriverEnv): Promise<Response> {
    const token = request.headers.get('X-Bench-Token') ?? '';
    if (!env.BENCH_TOKEN || token !== env.BENCH_TOKEN)
      return new Response('forbidden', { status: 403 });
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'POST' && pathname === '/setup') {
        return Response.json(await setup(env, (await request.json()) as SetupBody));
      }
      if (request.method === 'POST' && pathname === '/run') {
        const { feedId, n } = (await request.json()) as { feedId: number; n: number };
        return Response.json(await runBatch(env, feedId, n));
      }
      if (request.method === 'GET' && pathname === '/state') return Response.json(await state(env));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'failed' },
        { status: 500 },
      );
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<DriverEnv>;
