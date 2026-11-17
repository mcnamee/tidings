/**
 * OPML import (spec 8.7, TID-016). Set-based statements only: a 100-feed request is about ten D1
 * queries, not hundreds, so it stays far below the 50-subrequest limit of a free-plan invocation.
 * Every query that touches user data is scoped by `user_id` (spec 10.8).
 */
import { FOLDER_LIMIT, type FeedState } from '@tidings/shared';
import { PARKED_AT } from '../refresh/backoff';
import { Db, sql, type Statement } from './client';
import { listFolders } from './subscriptions';

/** D1 allows 100 bound parameters per statement. */
const URL_CHUNK = 50;
const FEED_ROWS_PER_INSERT = 33; // 3 parameters each
const SUB_ROWS_PER_INSERT = 20; // 4 parameters each, plus 3 shared

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Folder names are unique per user, case-insensitively (the column is `COLLATE NOCASE`). */
export const folderKey = (name: string) => name.toLowerCase();

/**
 * Finds the user's folders by name and creates the missing ones in one batch (FR-OP-4). Names
 * that cannot be created (the 200-folder limit) are absent from the result.
 */
export async function ensureFolders(
  db: Db,
  userId: string,
  names: readonly string[],
  now: number,
  newId: () => string,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  const existing = await listFolders(db, userId);
  for (const f of existing) byKey.set(folderKey(f.name), f.id);
  const missing = new Map<string, string>();
  for (const name of names) {
    const key = folderKey(name);
    if (!byKey.has(key) && !missing.has(key)) missing.set(key, name); // the first spelling wins
  }
  if (missing.size === 0) return byKey;
  await db.batch(
    [...missing.values()].map((name) =>
      sql(
        `INSERT INTO folders (id, user_id, name, created_at)
         SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM folders WHERE user_id = ?) < ?
         ON CONFLICT DO NOTHING`,
        newId(),
        userId,
        name,
        now,
        userId,
        FOLDER_LIMIT,
      ),
    ),
  );
  byKey.clear();
  for (const f of await listFolders(db, userId)) byKey.set(folderKey(f.name), f.id);
  return byKey;
}

/** Which of these canonical feed URLs the user already follows. */
export async function subscribedUrls(
  db: Db,
  userId: string,
  urls: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks(urls, URL_CHUNK)) {
    const { rows } = await db.all<{ url: string }>(
      sql(
        `SELECT f.url FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
          WHERE s.user_id = ? AND f.url IN (${marks(part.length)})`,
        userId,
        ...part,
      ),
    );
    for (const r of rows) found.add(r.url);
  }
  return found;
}

export interface KnownFeed {
  state: FeedState;
  nextFetchAt: number;
}

/** Shared feed rows by canonical URL (no user data). */
export async function knownFeeds(db: Db, urls: readonly string[]): Promise<Map<string, KnownFeed>> {
  const found = new Map<string, KnownFeed>();
  for (const part of chunks(urls, URL_CHUNK)) {
    const { rows } = await db.all<{ url: string; state: FeedState; next_fetch_at: number }>(
      sql(
        `SELECT url, state, next_fetch_at FROM feeds WHERE url IN (${marks(part.length)})`,
        ...part,
      ),
    );
    for (const r of rows) found.set(r.url, { state: r.state, nextFetchAt: r.next_fetch_at });
  }
  return found;
}

/**
 * How many first fetches the user already has scheduled for each UTC day from `todayStart` on
 * (ADR 0013 decision 5), as `day number -> count`. A first fetch is a subscription whose feed is
 * still `pending` and due that day, or one created today. Derived from existing rows, so no
 * counter has to be kept in step. At most 1,000 rows (the subscription limit).
 */
export async function scheduledFirstFetches(
  db: Db,
  userId: string,
  todayStart: number,
): Promise<Map<number, number>> {
  const { rows } = await db.all<{ created_at: number; state: FeedState; next_fetch_at: number }>(
    sql(
      `SELECT s.created_at, f.state, f.next_fetch_at
         FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
        WHERE s.user_id = ?
          AND (s.created_at >= ?
               OR (f.state = 'pending' AND f.next_fetch_at >= ? AND f.next_fetch_at < ?))`,
      userId,
      todayStart,
      todayStart,
      PARKED_AT,
    ),
  );
  const counts = new Map<number, number>();
  const today = Math.floor(todayStart / 86400);
  for (const r of rows) {
    const pendingDue = r.state === 'pending' && r.next_fetch_at >= todayStart;
    const day = pendingDue ? Math.floor(r.next_fetch_at / 86400) : today;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

export interface ImportRow {
  subscriptionId: string;
  url: string;
  folderId: string | null;
  titleOverride: string | null;
  /** Set for a feed that is new, parked or dead: the first fetch time. Null: leave the feed alone. */
  nextFetchAt: number | null;
  /** The feed row does not exist yet. */
  isNewFeed: boolean;
}

/**
 * One batch (one transaction): insert the missing feeds, the subscriptions, and reset parked or
 * dead feeds so the dispatcher picks them up (spec 7.1). No fetch happens here (FR-OP-3), and no
 * entries are linked: the first fetch does that. Returns the number of subscriptions created.
 */
export async function insertImported(
  db: Db,
  p: { userId: string; now: number; limit: number; rows: readonly ImportRow[] },
): Promise<number> {
  if (p.rows.length === 0) return 0;
  const statements: Statement[] = [];
  for (const part of chunks(
    p.rows.filter((r) => r.isNewFeed),
    FEED_ROWS_PER_INSERT,
  )) {
    statements.push(
      sql(
        `INSERT INTO feeds (url, next_fetch_at, state, created_at)
         VALUES ${part.map(() => "(?, ?, 'pending', ?)").join(', ')}
         ON CONFLICT (url) DO NOTHING`,
        ...part.flatMap((r) => [r.url, r.nextFetchAt ?? p.now, p.now]),
      ),
    );
  }
  const subsStart = statements.length;
  for (const part of chunks(p.rows, SUB_ROWS_PER_INSERT)) {
    statements.push(
      sql(
        `WITH v (id, url, folder_id, title) AS (VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')})
         INSERT INTO subscriptions (id, user_id, feed_id, folder_id, title_override, created_at)
         SELECT v.id, ?, f.id, v.folder_id, v.title, ? FROM v JOIN feeds f ON f.url = v.url
          WHERE (SELECT COUNT(*) FROM subscriptions WHERE user_id = ?) < ?
         ON CONFLICT (user_id, feed_id) DO NOTHING`,
        ...part.flatMap((r) => [r.subscriptionId, r.url, r.folderId, r.titleOverride]),
        p.userId,
        p.now,
        p.userId,
        p.limit,
      ),
    );
  }
  const subsEnd = statements.length;
  // Parked, dead or gone feeds that exist already: back to `pending`, due at the slot we chose.
  for (const r of p.rows) {
    if (r.isNewFeed || r.nextFetchAt === null) continue;
    statements.push(
      sql(
        `UPDATE feeds
            SET state = 'pending', error_count = 0, next_fetch_at = ?
          WHERE url = ? AND (next_fetch_at = ? OR state IN ('dead', 'gone'))
            AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?)`,
        r.nextFetchAt,
        r.url,
        PARKED_AT,
        r.subscriptionId,
        p.userId,
      ),
    );
  }
  const results = await db.batch(statements);
  let created = 0;
  for (let i = subsStart; i < subsEnd; i += 1) created += Number(results[i]?.meta.changes ?? 0);
  return created;
}
