/**
 * The image step (TID-071, ADR 0019): for queued entries that still have no image, read the start of
 * the article page and store its preview image. One bounded run per invocation, outside the refresh.
 * Every page goes through `safeFetch` (SSRF rules, redirects re-checked, timeout), only the first
 * 128 KB is read, and each entry is tried once: the queue row is deleted whatever the outcome.
 * Nothing here throws to the caller for a bad page; every statement is parameterised.
 */
import { Db, sql, type Meta, type Statement } from '../db';
import { safeFetch, type FetchFn } from '../fetch';
import { extractPreview, MAX_PAGE_BYTES, primaryOutboundLink, type PreviewImage } from './extract';
import { judgeImage, upgradeToHttps } from './weak';

/**
 * Page fetches per run, counting both the article page and the outbound-link page of an entry (TID-072).
 * With {@link MAX_REDIRECTS} that is at most 36 subrequests, plus about 4 D1 calls: under 50.
 */
export const PAGES_PER_RUN = 12;
export const MAX_REDIRECTS = 2;
/** Pages from one host per run (politeness). The rest stay queued for the next run. */
export const PAGES_PER_HOST = 3;
/** Queue rows looked at per run, so one busy host cannot hide the others. */
export const WINDOW = 60;
/** Entries worked on at once. */
const WORKERS = 6;
/** Characters of `content_html` read per queue row, for the outbound link. */
const CONTENT_CHARS = 8_000;
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
  /** Pages fetched (article pages and outbound-link pages). */
  fetched: number;
  /** Of those, pages fetched by following the entry's outbound link. */
  fallbackFetched: number;
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
  content: string | null;
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

async function previewOf(deps: EnrichDeps, url: string): Promise<PreviewImage | null> {
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
    return extractPreview(html, res.url, deps.appOrigin, deps.allowHosts ?? []);
  } catch {
    return null;
  }
}

type Claim = 'ok' | 'budget' | 'host';

/** What to do with one entry's image. `defer` keeps the queue row for the next run. */
type Outcome =
  { kind: 'set'; image: string } | { kind: 'clear' } | { kind: 'none' } | { kind: 'defer' };

export async function runEnrichImages(deps: EnrichDeps): Promise<EnrichSummary> {
  const { db } = deps;
  const now = Math.floor(deps.clock() / 1000);
  const out: EnrichSummary = {
    fetched: 0,
    fallbackFetched: 0,
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
      `SELECT q.entry_id, e.url, e.image_url, e.fetched_at, substr(e.content_html, 1, ?) AS content,
              EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0) AS unread
         FROM image_queue q JOIN entries e ON e.id = q.entry_id
        ORDER BY q.entry_id DESC LIMIT ?`,
      CONTENT_CHARS,
      WINDOW,
    ),
  );
  if (rows.length === 0) return { ...out, stopped: 'idle' };

  // Rows that need no fetch are dropped even when the daily cap is reached (they cost no subrequest).
  // A queue row means "weak or missing image": an image already stored is replaced only by a better one.
  const drop: number[] = [];
  const work: Row[] = [];
  for (const r of rows) {
    if (!r.url || !hostOf(r.url) || r.unread === 0 || r.fetched_at < now - MAX_AGE_SECONDS) {
      drop.push(r.entry_id);
    } else work.push(r);
  }
  out.skipped = drop.length;
  const budget = Math.max(0, Math.min(PAGES_PER_RUN, room));
  if (work.length > 0 && room <= 0) out.stopped = 'daily_cap';

  // The fetch budget is shared by both fetches of an entry (article page, then outbound page) and
  // by the per-host cap; claims are synchronous, so concurrent workers cannot overspend.
  let claimed = 0;
  const perHost = new Map<string, number>();
  const claim = (url: string): Claim => {
    const host = hostOf(url);
    if (!host) return 'host';
    if (claimed >= budget) return 'budget';
    if ((perHost.get(host) ?? 0) >= PAGES_PER_HOST) return 'host';
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    claimed++;
    return 'ok';
  };

  const existingRank = (r: Row): number =>
    r.image_url !== null && judgeImage(r.image_url) !== 'junk' ? 1 : 0;

  const enrichOne = async (r: Row, url: string): Promise<Outcome> => {
    // Best small-but-real picture seen so far, used only when nothing good turns up.
    let fallback: string | null = null;
    const consider = (p: PreviewImage | null): string | null => {
      if (!p) return null;
      const image = upgradeToHttps(p.url, url);
      const verdict = judgeImage(image, p);
      if (verdict === 'good') return image;
      if (verdict === 'small') fallback ??= image;
      return null;
    };

    out.fetched++;
    const good = consider(await previewOf(deps, url));
    if (good) return { kind: 'set', image: good };

    const link = primaryOutboundLink(r.content, url, deps.appOrigin, deps.allowHosts ?? []);
    if (link) {
      const c = claim(link);
      if (c === 'budget') return { kind: 'defer' };
      if (c === 'ok') {
        out.fetched++;
        out.fallbackFetched++;
        const viaLink = consider(await previewOf(deps, link));
        if (viaLink) return { kind: 'set', image: viaLink };
      }
    }
    // Replace only with something better than what is stored.
    if (fallback !== null && existingRank(r) < 1) return { kind: 'set', image: fallback };
    if (r.image_url !== null && existingRank(r) === 0) return { kind: 'clear' };
    return { kind: 'none' };
  };

  const statements: Statement[] = [];
  const done: number[] = [...drop];
  const todo = [...work];
  const worker = async (): Promise<void> => {
    for (let r = todo.shift(); r !== undefined; r = todo.shift()) {
      const url = r.url as string;
      const c = claim(url);
      if (c !== 'ok') {
        out.deferred++;
        continue;
      }
      const o = await enrichOne(r, url);
      if (o.kind === 'defer') {
        out.deferred++;
        continue;
      }
      done.push(r.entry_id);
      if (o.kind === 'set') {
        out.found++;
        // One UPDATE per entry; never overwrites an image that arrived since the read.
        statements.push(
          sql(
            'UPDATE entries SET image_url = ? WHERE id = ? AND image_url IS ?',
            o.image,
            r.entry_id,
            r.image_url,
          ),
        );
      } else if (o.kind === 'clear') {
        out.missed++;
        // The stored image is junk (an icon or site default) and nothing better exists.
        statements.push(
          sql(
            'UPDATE entries SET image_url = NULL WHERE id = ? AND image_url = ?',
            r.entry_id,
            r.image_url,
          ),
        );
      } else out.missed++;
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));

  if (done.length === 0 && claimed === 0) return out;
  if (done.length > 0)
    statements.push(
      sql(
        'DELETE FROM image_queue WHERE entry_id IN (SELECT value FROM json_each(?))',
        JSON.stringify(done),
      ),
    );
  if (claimed > 0) {
    statements.push(
      sql(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start
                        THEN rate_limits.count + excluded.count ELSE excluded.count END,
           window_start = excluded.window_start`,
        USAGE_KEY,
        dayStart(now),
        claimed,
      ),
    );
  }
  const results = await db.batch(statements);
  out.rowsWritten = results.reduce((n, r) => n + written(r.meta), 0);
  return out;
}
