/**
 * Refreshes one feed (spec §7.3): conditional GET, body hash, streaming parse, dedup, one batch.
 * Everything with a side effect is injected (`fetch`, clock, random, logger) so it is testable.
 *
 * Nothing from the origin is ever stored except the validators (`etag`, `last_modified`), the body
 * hash, the parsed feed content, and the numeric HTTP status (spec §10.6 rule 8). Errors are
 * recorded as fixed codes; `safeFetch`'s `message`, headers and bodies are dropped here.
 */
import { httpErrorCode, type FeedErrorCode } from '@tidings/shared';
import { dedupKeys } from '@tidings/shared/dedup-keys';
import { itemGuidHash, parseFeed, type ParsedItem } from '@tidings/feed-parser';
import { planImages } from '../images/plan';
import {
  Db,
  nowSeconds,
  READ_AFTER_SECONDS,
  sql,
  tryCanonicalizeUrl,
  type Clock,
  type Statement,
} from '../db';
import { notDuplicateOf } from '../db/dedup';
import { safeFetch, type FetchFn, type SafeFetchResult } from '../fetch';
import { parseRetryAfter } from './backoff';
import {
  MAX_RECENT_KEYS,
  capWarningExpired,
  parseRecentKeys,
  planDailyCap,
  secondaryKey,
  uniqueKeys,
} from './churn';
import {
  hasSubscribers,
  markGone,
  Meter,
  parkFeed,
  recordFailure,
  urlUpdate,
  type Failure,
} from './store';
import type { RefreshJob, RefreshOutcome, RefreshResult } from './types';

/** `entries` has 12 bound columns per row; 8 rows keep a statement within D1's 100 parameters. */
const ENTRY_ROWS_PER_STATEMENT = 8;
/** FR-SU-3: the first fetch of a feed links only the newest items to its subscribers. */
export const FIRST_FETCH_LINK_LIMIT = 10;

export type RefreshLog = (event: string, data: Record<string, unknown>) => void;

export interface RefreshDeps {
  db: Db;
  fetch: FetchFn;
  clock: Clock;
  /** Returns a value in [0, 1). Used for backoff jitter. */
  random: () => number;
  appOrigin: string;
  /** From `resolveFetchPolicy`; empty in production. */
  allowHosts: readonly string[];
  /** Body cap override. Production leaves it unset (1 MiB); only the AC13 benchmark raises it. */
  maxBodyBytes?: number;
  /** Structured warnings (for example `feed_parse_too_deep`). */
  log: RefreshLog;
}

export async function refreshFeed(job: RefreshJob, deps: RefreshDeps): Promise<RefreshOutcome> {
  const { db } = deps;
  const now = nowSeconds(deps.clock);
  const meter = new Meter();

  const done = (
    result: RefreshResult,
    extra: { newEntries?: number; errorCode?: FeedErrorCode } = {},
  ): RefreshOutcome => ({
    feedId: job.feedId,
    result,
    newEntries: extra.newEntries ?? 0,
    errorCode: extra.errorCode ?? null,
    usage: meter.usage(),
  });

  const fail = async (failure: Failure): Promise<RefreshOutcome> => {
    await recordFailure(db, job, failure, now, deps.random, meter);
    return done('failed', { errorCode: failure.code });
  };

  // Unsubscribed feeds are parked, not fetched (spec §7.1).
  if (!(await hasSubscribers(db, job.feedId, meter))) {
    await parkFeed(db, job.feedId, meter);
    return done('parked');
  }

  const res = await safeFetch(job.url, {
    fetch: deps.fetch,
    appOrigin: deps.appOrigin,
    allowHosts: deps.allowHosts,
    maxBodyBytes: deps.maxBodyBytes,
    etag: job.etag,
    lastModified: job.lastModified,
  });

  switch (res.kind) {
    case 'error':
      // `res.message` is raw (it can carry exception text). Only the fixed code is kept.
      return fail({ code: res.code, status: null, retryAfterS: null });

    case 'http_error': {
      if (res.status === 410) {
        await markGone(db, job, httpErrorCode(410), 410, meter);
        return done('failed', { errorCode: httpErrorCode(410) });
      }
      const retryable = res.status === 429 || res.status === 503;
      return fail({
        code: httpErrorCode(res.status),
        status: res.status,
        retryAfterS: retryable ? parseRetryAfter(res.headers.get('Retry-After'), now) : null,
      });
    }

    case 'not_modified':
      // A 304 answers a conditional request. With no validator sent it means nothing (a broken
      // origin or proxy): never a success, or a pending feed would lose its first-fetch limit.
      if (job.etag === null && job.lastModified === null) {
        return fail({ code: httpErrorCode(304), status: 304, retryAfterS: null });
      }
      return unchanged(res, 304);

    case 'ok':
      break;
  }

  // 200. A byte-identical body is the same as a 304: no parse, no write.
  if (res.sha256 === job.bodyHash) return unchanged(res, 200);

  const parsed = parseFeed(decodeBody(res.body, res.headers.get('Content-Type')), {
    fetchedAt: now,
    baseUrl: res.url, // the final URL after redirects (ADR 0009, AC14)
    log: (event, data) => deps.log(event, { feedId: job.feedId, ...data }),
  });
  if (!parsed.ok) return fail({ code: 'parse_error', status: res.status, retryAfterS: null });
  const feed = parsed.feed;

  // Dedup (spec §6.3): hash every parsed key, ask which already exist, keep the rest.
  const hashed: { hash: string; item: ParsedItem }[] = [];
  const seen = new Set<string>();
  for (const item of feed.items) {
    const hash = await itemGuidHash(job.feedId, item);
    if (seen.has(hash)) continue; // duplicate guid inside one document: first wins
    seen.add(hash);
    hashed.push({ hash, item });
  }

  let candidates = hashed;
  if (hashed.length > 0) {
    const { rows, meta } = await db.all<{ guid_hash: string }>(
      sql(
        `SELECT guid_hash FROM entries WHERE feed_id = ? AND guid_hash IN (${placeholders(hashed.length)})`,
        job.feedId,
        ...hashed.map((h) => h.hash),
      ),
    );
    meter.add(meta);
    const known = new Set(rows.map((r) => r.guid_hash));
    candidates = hashed.filter((h) => !known.has(h.hash));
  }

  // GUID churn guard (spec §6.3). Secondary keys of this fetch are remembered on the feed row; an
  // item that is new by guid but matches the previous fetch's keys is already known. No extra I/O.
  const secondary = uniqueKeys(await Promise.all(hashed.map((h) => secondaryKey(h.item))));
  const secondaryOf = new Map(hashed.map((h, i) => [h.hash, secondary[i] ?? null]));
  const previous = parseRecentKeys(job.recentKeys);
  const novel = candidates.filter((h) => {
    const key = secondaryOf.get(h.hash) ?? null;
    return key === null || !previous.has(key);
  });
  // Daily cap: when over, the newest items are the ones kept.
  const cap = planDailyCap({
    nowSeconds: now,
    newEntriesDay: job.newEntriesDay,
    newEntriesCount: job.newEntriesCount,
    warningCode: job.warningCode,
  });
  const fresh =
    novel.length <= cap.allowed
      ? novel
      : [...novel].sort((a, b) => b.item.publishedAt - a.item.publishedAt).slice(0, cap.allowed);
  const refused = novel.length - fresh.length;
  if (refused > 0) {
    deps.log('new_item_cap', { feedId: job.feedId, refused, stored: fresh.length });
  }
  const recentKeys = JSON.stringify(
    secondary.filter((k): k is string => k !== null).slice(0, MAX_RECENT_KEYS),
  );

  // Link to every subscriber in one statement. A feed that has never succeeded links only its
  // newest items (FR-SU-3); the rest are stored but not shown.
  const firstFetch = job.lastSuccessAt === null;
  const toLink = firstFetch
    ? [...fresh]
        .sort((a, b) => b.item.publishedAt - a.item.publishedAt)
        .slice(0, FIRST_FETCH_LINK_LIMIT)
    : fresh;
  // Cross-feed duplicate keys (spec 6.3, ADR 0017), only for the items that will be linked: an entry
  // nobody links can never be matched against, so it gets no keys and no index rows (first fetches
  // store up to 50 entries and link 10). A key shared by two items of this fetch is dropped, as in
  // the churn guard: such feeds point many items at one page or reuse one headline, and the key
  // would hide real articles.
  const keyed = await Promise.all(toLink.map((h) => dedupKeys(h.item)));
  const urlKeys = uniqueKeys(keyed.map((k) => k.urlKey));
  const headlineKeys = uniqueKeys(keyed.map((k) => k.headlineKey));
  const keysOf = new Map(
    toLink.map((h, i) => [h.hash, { url: urlKeys[i] ?? null, headline: headlineKeys[i] ?? null }]),
  );

  // TID-072: weak images (icons, site defaults) are dropped, small ones kept as a fallback, and
  // entries with a weak or missing image are queued for the image step (ADR 0020).
  const images = await planImages(db, job.feedId, fresh, (m) => meter.add(m));
  const needsImage = fresh.filter((h) => images.get(h.hash)?.needsImage).map((h) => h.hash);

  const statements: Statement[] = [];
  for (let i = 0; i < fresh.length; i += ENTRY_ROWS_PER_STATEMENT) {
    const chunk = fresh.slice(i, i + ENTRY_ROWS_PER_STATEMENT);
    statements.push(
      sql(
        `INSERT INTO entries (feed_id, guid_hash, url, title, author, summary, content_html,
                              image_url, published_at, fetched_at, url_key, headline_key)
         VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (feed_id, guid_hash) DO NOTHING`,
        ...chunk.flatMap(({ hash, item }) => [
          job.feedId,
          hash,
          item.link,
          item.title,
          item.author,
          item.summary,
          item.contentHtml,
          images.get(hash)?.image ?? null,
          item.publishedAt,
          now,
          keysOf.get(hash)?.url ?? null,
          keysOf.get(hash)?.headline ?? null,
        ]),
      ),
    );
  }

  if (toLink.length > 0) {
    // FR-SU-3: on a first fetch, items older than 7 days are linked already read. Later fetches
    // pass a cutoff of 0, which no item is older than.
    const readCutoff = firstFetch ? now - READ_AFTER_SECONDS : 0;
    // A subscriber who already has this story from another feed is not linked (ADR 0017).
    const notDup = notDuplicateOf('e', { column: 's.user_id' }, now);
    statements.push(
      sql(
        `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, read_at)
         SELECT s.user_id, e.id, e.feed_id, e.published_at,
                e.published_at < ?, CASE WHEN e.published_at < ? THEN ? END
           FROM entries e JOIN subscriptions s ON s.feed_id = e.feed_id
          WHERE e.feed_id = ? AND e.guid_hash IN (${placeholders(toLink.length)})
            AND ${notDup.sql}
         ON CONFLICT DO NOTHING`,
        readCutoff,
        readCutoff,
        now,
        job.feedId,
        ...toLink.map((h) => h.hash),
        ...notDup.params,
      ),
      // TID-067: entries that were linked to someone wait for an embedding, outside this refresh
      // (the embed step drains the queue). Entries nobody linked (duplicates) or only linked as already read are not queued.
      sql(
        `INSERT OR IGNORE INTO embed_queue (entry_id)
         SELECT e.id FROM entries e
          WHERE e.feed_id = ? AND e.guid_hash IN (${placeholders(toLink.length)})
            AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0)`,
        job.feedId,
        ...toLink.map((h) => h.hash),
      ),
      // TID-071/072: new entries with a page and a weak or missing image wait for a better one
      // (ADR 0019, 0020). Queued only here, when the entry is first stored, so each is tried once.
      ...(needsImage.length === 0
        ? []
        : [
            sql(
              `INSERT OR IGNORE INTO image_queue (entry_id)
               SELECT e.id FROM entries e
                WHERE e.feed_id = ? AND e.guid_hash IN (${placeholders(needsImage.length)})
                  AND e.url IS NOT NULL
                  AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0)`,
              job.feedId,
              ...needsImage,
            ),
          ]),
    );
  }

  const newUrl = permanentRedirectTarget(job, res);
  const u = urlUpdate(job.feedId, newUrl);
  statements.push(
    sql(
      `UPDATE feeds
          SET etag = ?, last_modified = ?, body_hash = ?,
              title = COALESCE(?, title), site_url = COALESCE(?, site_url),
              last_success_at = ?, last_new_entry_at = COALESCE(?, last_new_entry_at),
              state = 'ok', error_count = 0, last_error_code = NULL, last_status = ?,
              recent_keys = ?, new_entries_day = ?, new_entries_count = ?, warning_code = ?,
              next_fetch_at = ?${u.set}
        WHERE id = ?`,
      res.headers.get('ETag'),
      res.headers.get('Last-Modified'),
      res.sha256,
      feed.title || null,
      feed.siteUrl,
      now,
      fresh.length > 0 ? now : null,
      res.status,
      recentKeys,
      cap.day,
      cap.countAfter(fresh.length),
      cap.warningAfter(refused),
      now + job.fetchIntervalS,
      ...u.params,
      job.feedId,
    ),
  );

  for (const r of await db.batch(statements)) meter.add(r.meta);
  return done('updated', { newEntries: fresh.length });

  /** 304 and identical-body 200: write only if the feed was unhealthy or its URL moved. */
  async function unchanged(r: SafeFetchResult, status: number): Promise<RefreshOutcome> {
    const newUrl = permanentRedirectTarget(job, r);
    // DEF-020: a stored cap warning from an earlier UTC day clears here, in the same UPDATE.
    const clearWarning = capWarningExpired({
      nowSeconds: now,
      newEntriesDay: job.newEntriesDay,
      warningCode: job.warningCode,
    });
    if (job.errorCount > 0 || job.state !== 'ok' || newUrl !== null || clearWarning) {
      const u = urlUpdate(job.feedId, newUrl);
      meter.add(
        await db.run(
          sql(
            `UPDATE feeds
                SET state = 'ok', error_count = 0, last_error_code = NULL, last_status = ?,
                    last_success_at = ?, next_fetch_at = ?${clearWarning ? ', warning_code = NULL' : ''}${u.set}
              WHERE id = ?`,
            status,
            now,
            now + job.fetchIntervalS,
            ...u.params,
            job.feedId,
          ),
        ),
      );
    }
    return done('unchanged');
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * The canonical final URL when every hop was a permanent redirect (301 or 308) and it differs from
 * the stored one, else null (spec §7.4). `safeFetch` has already validated each hop.
 */
function permanentRedirectTarget(job: RefreshJob, res: SafeFetchResult): string | null {
  if (res.kind === 'error' || !res.redirects || res.redirects.length === 0) return null;
  if (!res.redirects.every((h) => h.status === 301 || h.status === 308)) return null;
  const final = tryCanonicalizeUrl(res.url);
  return final !== null && final !== job.url ? final : null;
}

/** Decodes with the declared charset (Content-Type, then the XML declaration); UTF-8 otherwise. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  let label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!label) {
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 120); i++)
      head += String.fromCharCode(bytes[i] ?? 0);
    label = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
