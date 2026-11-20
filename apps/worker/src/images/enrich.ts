/**
 * The image step (TID-071, ADR 0019): for queued entries that still have no image, read the start of
 * the article page and store its preview image. One bounded run per invocation, outside the refresh.
 * Every page goes through `safeFetch` (SSRF rules, redirects re-checked, timeout), only the first
 * 128 KB is read, and each entry is tried once: the queue row is deleted whatever the outcome.
 * Nothing here throws to the caller for a bad page; every statement is parameterised.
 */
import { Db, sql, type Meta, type Statement } from '../db';
import { safeFetch, type FetchFn } from '../fetch';
import { extractPreviewImage, MAX_PAGE_BYTES } from './extract';

/** Pages fetched per run. With {@link MAX_REDIRECTS} that is at most 36 fetches, plus about 4 D1 calls: under 50. */
export const PAGES_PER_RUN = 12;
export const MAX_REDIRECTS = 2;
/** Pages from one host per run (politeness). The rest stay queued for the next run. */
export const PAGES_PER_HOST = 3;
/** Queue rows looked at per run, so one busy host cannot hide the others. */
export const WINDOW = 60;
/** Pages per UTC day: bounds D1 writes (at most 3 rows each) and outbound traffic. */
export const DAILY_PAGE_CAP = 600;
/** Entries fetched longer ago than this are dropped from the queue unfetched. */
export const MAX_AGE_SECONDS = 3 * 86_400;
export const PAGE_TIMEOUT_MS = 6_000;
const DAY = 86_400;
const USAGE_KEY = 'img:pages';
const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1';

export interface EnrichDeps {
  db: Db;
  fetch: FetchFn;
  appOrigin: string;
  allowHosts?: readonly string[];
  /** Milliseconds, like `Date.now`. */
  clock: () => number;
}

export interface EnrichSummary {
  /** Pages fetched. */
  fetched: number;
  /** Entries given an image. */
  found: number;
  /** Pages fetched that had no usable image or failed. */
  missed: number;
  /** Queue rows dropped without a fetch (no url, already has an image, read, too old). */
  skipped: number;
  /** Rows left queued (per-host limit or per-run limit). */
  deferred: number;
  stopped: 'idle' | 'daily_cap' | null;
  rowsWritten: number;
}

const written = (m: Meta): number => Number(m.rows_written ?? 0);
const dayStart = (now: number): number => now - (now % DAY);

interface Row {
  entry_id: number;
  url: string | null;
  image_url: string | null;
  fetched_at: number;
  unread: number;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

async function previewOf(deps: EnrichDeps, url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      fetch: deps.fetch,
      appOrigin: deps.appOrigin,
      allowHosts: deps.allowHosts,
      maxBodyBytes: MAX_PAGE_BYTES,
      truncate: true,
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: PAGE_TIMEOUT_MS,
      accept: HTML_ACCEPT,
    });
    if (res.kind !== 'ok') return null;
    const type = res.headers.get('Content-Type');
    if (type && !/html/i.test(type)) return null;
    const html = new TextDecoder('utf-8').decode(res.body);
    return extractPreviewImage(html, res.url, deps.appOrigin, deps.allowHosts ?? []);
  } catch {
    return null;
  }
}

export async function runEnrichImages(deps: EnrichDeps): Promise<EnrichSummary> {
  const { db } = deps;
  const now = Math.floor(deps.clock() / 1000);
  const out: EnrichSummary = {
    fetched: 0,
    found: 0,
    missed: 0,
    skipped: 0,
    deferred: 0,
    stopped: null,
    rowsWritten: 0,
  };

  const used = await db.first<{ count: number }>(
    sql(
      'SELECT count FROM rate_limits WHERE key = ? AND window_start = ?',
      USAGE_KEY,
      dayStart(now),
    ),
  );
  const room = DAILY_PAGE_CAP - (used?.count ?? 0);

  const { rows } = await db.all<Row>(
    sql(
      `SELECT q.entry_id, e.url, e.image_url, e.fetched_at,
              EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0) AS unread
         FROM image_queue q JOIN entries e ON e.id = q.entry_id
        ORDER BY q.entry_id DESC LIMIT ?`,
      WINDOW,
    ),
  );
  if (rows.length === 0) return { ...out, stopped: 'idle' };

  // Rows that need no fetch are dropped even when the daily cap is reached (they cost no subrequest).
  const drop: number[] = [];
  const work: { id: number; url: string }[] = [];
  const perHost = new Map<string, number>();
  const budget = Math.max(0, Math.min(PAGES_PER_RUN, room));
  for (const r of rows) {
    const host = r.url ? hostOf(r.url) : null;
    if (
      !r.url ||
      !host ||
      r.image_url !== null ||
      r.unread === 0 ||
      r.fetched_at < now - MAX_AGE_SECONDS
    ) {
      drop.push(r.entry_id);
    } else if (work.length < budget && (perHost.get(host) ?? 0) < PAGES_PER_HOST) {
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      work.push({ id: r.entry_id, url: r.url });
    } else {
      out.deferred++;
    }
  }
  out.skipped = drop.length;
  if (work.length === 0 && room <= 0) out.stopped = 'daily_cap';

  const previews = await Promise.all(work.map((w) => previewOf(deps, w.url)));
  out.fetched = work.length;

  const statements: Statement[] = [];
  work.forEach((w, i) => {
    const image = previews[i];
    if (image) {
      out.found++;
      // One UPDATE per entry; never overwrites an image that arrived since the read.
      statements.push(
        sql('UPDATE entries SET image_url = ? WHERE id = ? AND image_url IS NULL', image, w.id),
      );
    } else {
      out.missed++;
    }
  });
  const done = [...drop, ...work.map((w) => w.id)];
  if (done.length === 0) return out;
  statements.push(
    sql(
      'DELETE FROM image_queue WHERE entry_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(done),
    ),
  );
  if (work.length > 0) {
    statements.push(
      sql(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start
                        THEN rate_limits.count + excluded.count ELSE excluded.count END,
           window_start = excluded.window_start`,
        USAGE_KEY,
        dayStart(now),
        work.length,
      ),
    );
  }
  const results = await db.batch(statements);
  out.rowsWritten = results.reduce((n, r) => n + written(r.meta), 0);
  return out;
}
