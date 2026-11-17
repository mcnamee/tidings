/**
 * Read queries behind `GET /api/entries` and `GET /api/counts` (spec 8.5, 8.6, ADR 0008). Every
 * query puts `user_id = ?` in its SQL, so an ID that came from a request can only resolve to the
 * caller's own rows (spec 10.8).
 */
import type { Counts } from '@tidings/shared';
import { Db, sql, type Meta } from './client';

export interface FeedLabel {
  subscriptionId: string;
  title: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The feed behind the caller's subscription, or null when it is not theirs (or does not exist). */
export async function feedIdForSubscription(
  db: Db,
  userId: string,
  subscriptionId: string,
): Promise<number | null> {
  const row = await db.first<{ feed_id: number }>(
    sql('SELECT feed_id FROM subscriptions WHERE id = ? AND user_id = ?', subscriptionId, userId),
  );
  return row?.feed_id ?? null;
}

/**
 * Subscription ID and display title for the feeds on one page (at most `limit` of them), so a page
 * reads about 2 rows per distinct feed rather than the user's whole subscription list. The title
 * follows the same rule as `Subscription.title`: custom title, else feed title, else host.
 */
export async function labelsForFeeds(
  db: Db,
  userId: string,
  feedIds: readonly number[],
): Promise<Map<number, FeedLabel>> {
  const out = new Map<number, FeedLabel>();
  const distinct = [...new Set(feedIds)];
  if (distinct.length === 0) return out;
  const marks = distinct.map(() => '?').join(', ');
  const { rows } = await db.all<{
    id: string;
    feed_id: number;
    title_override: string | null;
    title: string | null;
    url: string;
  }>(
    sql(
      'SELECT s.id, s.feed_id, s.title_override, f.title, f.url FROM subscriptions s ' +
        'JOIN feeds f ON f.id = s.feed_id WHERE s.user_id = ? AND s.feed_id IN (' +
        marks +
        ')',
      userId,
      ...distinct,
    ),
  );
  for (const r of rows) {
    out.set(r.feed_id, {
      subscriptionId: r.id,
      title: r.title_override ?? (r.title || hostOf(r.url)),
    });
  }
  return out;
}

export interface CountsResult {
  counts: Counts;
  /** Rows read by the two queries together (NFR-7: unread rows + subscriptions + a few). */
  rowsRead: number;
}

/**
 * Unread totals per subscription, per folder and overall. One covering scan of the partial unread
 * index grouped by feed, plus the user's subscriptions to map feeds to subscriptions and folders.
 * Unread rows whose feed has no subscription still count towards `total`, so `total` always equals
 * the unread rows the "All" list shows.
 */
export async function unreadCounts(db: Db, userId: string): Promise<CountsResult> {
  const [unread, subs] = await Promise.all([
    db.all<{ feed_id: number; n: number }>(
      sql(
        'SELECT feed_id, COUNT(*) AS n FROM user_entries INDEXED BY ue_unread_feed ' +
          'WHERE user_id = ? AND is_read = 0 GROUP BY feed_id',
        userId,
      ),
    ),
    db.all<{ id: string; feed_id: number; folder_id: string | null }>(
      sql('SELECT id, feed_id, folder_id FROM subscriptions WHERE user_id = ?', userId),
    ),
  ]);
  const byFeed = new Map(unread.rows.map((r) => [r.feed_id, r.n]));
  let total = 0;
  for (const n of byFeed.values()) total += n;
  const counts: Counts = { total, folders: {}, subscriptions: {} };
  for (const s of subs.rows) {
    const n = byFeed.get(s.feed_id) ?? 0;
    counts.subscriptions[s.id] = n;
    if (s.folder_id !== null) counts.folders[s.folder_id] = (counts.folders[s.folder_id] ?? 0) + n;
  }
  return { counts, rowsRead: rowsRead(unread.meta) + rowsRead(subs.meta) };
}

function rowsRead(meta: Meta): number {
  return Number(meta.rows_read ?? 0);
}
