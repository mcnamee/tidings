/**
 * Folders and subscriptions (spec §6.1, §8.4, §10.8). Every function that touches user data takes
 * `userId` first and puts `user_id = ?` in its SQL, so an ID from a request can only ever resolve
 * to the caller's own rows.
 */
import {
  FOLDER_LIMIT,
  feedErrorMessage,
  feedWarningMessage,
  isFeedErrorCode,
  type FeedState,
  type Folder,
  type Subscription,
} from '@tidings/shared';
import { PARKED_AT } from '../refresh/backoff';
import { Db, sql, type SqlValue, type Statement } from './client';
import { notDuplicateOf } from './dedup';
import { toIso } from './ids';

/** FR-SU-3. */
export const NEW_SUBSCRIBER_LINK_LIMIT = 10;
/** FR-SU-3: first-linked items older than this are already read. */
export const READ_AFTER_SECONDS = 7 * 86400;

export async function listFolders(db: Db, userId: string): Promise<Folder[]> {
  const { rows } = await db.all<Folder>(
    sql('SELECT id, name FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE', userId),
  );
  return rows;
}

export async function folderBelongsToUser(
  db: Db,
  userId: string,
  folderId: string,
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    sql('SELECT 1 AS n FROM folders WHERE id = ? AND user_id = ?', folderId, userId),
  );
  return row !== null;
}

export async function countSubscriptions(db: Db, userId: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    sql('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?', userId),
  );
  return row?.n ?? 0;
}

/** The user's subscription to the feed with this canonical URL, if any. */
export async function findSubscriptionIdByFeedUrl(
  db: Db,
  userId: string,
  feedUrl: string,
): Promise<string | null> {
  const row = await db.first<{ id: string }>(
    sql(
      `SELECT s.id FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
        WHERE s.user_id = ? AND f.url = ?`,
      userId,
      feedUrl,
    ),
  );
  return row?.id ?? null;
}

export interface FeedRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
  body_hash: string | null;
  error_count: number;
  state: FeedState;
  fetch_interval_s: number;
  last_success_at: number | null;
  next_fetch_at: number;
  recent_keys: string | null;
  new_entries_day: number | null;
  new_entries_count: number;
  warning_code: string | null;
}

/** A feed by canonical URL. Shared data (no `user_id`): callers only learn whether it exists. */
export async function findFeedByUrl(db: Db, url: string): Promise<FeedRow | null> {
  return db.first<FeedRow>(
    sql(
      `SELECT id, url, etag, last_modified, body_hash, error_count, state, fetch_interval_s,
              last_success_at, next_fetch_at, recent_keys, new_entries_day, new_entries_count,
              warning_code
         FROM feeds WHERE url = ?`,
      url,
    ),
  );
}

export interface CreateSubscription {
  userId: string;
  subscriptionId: string;
  feedUrl: string;
  folderId: string | null;
  titleOverride: string | null;
  /** Epoch seconds. */
  now: number;
  /** Seconds in [0, 60): spec §7.1 jitter for `next_fetch_at`. */
  jitterS: number;
  limit: number;
}

/**
 * One batch (one transaction): upsert the feed, add the subscription, reset a parked, `dead` or
 * `gone` feed so the dispatcher tries it again (spec §7.1, ADR 0013 decision 7), and link the
 * newest existing entries to the user (FR-SU-3; items older than 7 days arrive already read).
 *
 * Returns false when no subscription was created: the user already has one, or is at the limit
 * (the caller tells them apart). The reset and the link only act when this batch created the
 * subscription.
 */
export async function createSubscription(db: Db, p: CreateSubscription): Promise<boolean> {
  const mine = 'id = ? AND user_id = ?';
  const readCutoff = p.now - READ_AFTER_SECONDS;
  // Stories this user already has from another feed are not linked again (ADR 0017).
  const notDup = notDuplicateOf('e', { param: p.userId }, p.now);
  const statements: Statement[] = [
    sql(
      `INSERT INTO feeds (url, next_fetch_at, state, created_at) VALUES (?, ?, 'pending', ?)
       ON CONFLICT (url) DO NOTHING`,
      p.feedUrl,
      p.now + p.jitterS,
      p.now,
    ),
    sql(
      `INSERT INTO subscriptions (id, user_id, feed_id, folder_id, title_override, created_at)
       SELECT ?, ?, f.id, ?, ?, ? FROM feeds f
        WHERE f.url = ? AND (SELECT COUNT(*) FROM subscriptions WHERE user_id = ?) < ?
       ON CONFLICT (user_id, feed_id) DO NOTHING`,
      p.subscriptionId,
      p.userId,
      p.folderId,
      p.titleOverride,
      p.now,
      p.feedUrl,
      p.userId,
      p.limit,
    ),
    sql(
      `UPDATE feeds
          SET state = CASE WHEN state IN ('dead', 'gone') THEN 'pending' ELSE state END,
              error_count = CASE WHEN state IN ('dead', 'gone') THEN 0 ELSE error_count END,
              next_fetch_at = ?
        WHERE url = ? AND (next_fetch_at = ? OR state IN ('dead', 'gone'))
          AND EXISTS (SELECT 1 FROM subscriptions WHERE ${mine} AND feed_id = feeds.id)`,
      p.now + p.jitterS,
      p.feedUrl,
      PARKED_AT,
      p.subscriptionId,
      p.userId,
    ),
    sql(
      `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, read_at)
       SELECT ?, e.id, e.feed_id, e.published_at,
              e.published_at < ?, CASE WHEN e.published_at < ? THEN ? END
         FROM entries e
        WHERE e.feed_id = (SELECT feed_id FROM subscriptions WHERE ${mine})
          AND e.purged_at IS NULL
          AND ${notDup.sql}
        ORDER BY e.published_at DESC, e.id DESC
        LIMIT ?
       ON CONFLICT DO NOTHING`,
      p.userId,
      readCutoff,
      readCutoff,
      p.now,
      p.subscriptionId,
      p.userId,
      ...notDup.params,
      NEW_SUBSCRIBER_LINK_LIMIT,
    ),
  ];
  const results = await db.batch(statements);
  return Number(results[1]?.meta.changes ?? 0) > 0;
}

/** How many articles the user has from one feed (the `ue_feed` index). */
export async function countUserEntriesForFeed(
  db: Db,
  userId: string,
  feedId: number,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    sql('SELECT COUNT(*) AS n FROM user_entries WHERE user_id = ? AND feed_id = ?', userId, feedId),
  );
  return row?.n ?? 0;
}

interface SubscriptionRow {
  id: string;
  feed_id: number;
  folder_id: string | null;
  title_override: string | null;
  created_at: number;
  url: string;
  site_url: string | null;
  title: string | null;
  state: FeedState;
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_error_code: string | null;
  next_fetch_at: number;
  warning_code: string | null;
}

const SUBSCRIPTION_SELECT = `
  SELECT s.id, s.feed_id, s.folder_id, s.title_override, s.created_at, f.url, f.site_url, f.title,
         f.state, f.last_success_at, f.last_attempt_at, f.last_error_code, f.next_fetch_at,
         f.warning_code
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id`;

function toSubscription(r: SubscriptionRow): Subscription {
  const errorCode = isFeedErrorCode(r.last_error_code) ? r.last_error_code : null;
  return {
    id: r.id,
    folderId: r.folder_id,
    title: r.title_override ?? (r.title || hostOf(r.url)),
    customTitle: r.title_override,
    feedUrl: r.url,
    siteUrl: r.site_url,
    createdAt: toIso(r.created_at),
    health: {
      state: r.state,
      lastSuccessAt: r.last_success_at === null ? null : toIso(r.last_success_at),
      lastAttemptAt: r.last_attempt_at === null ? null : toIso(r.last_attempt_at),
      errorCode,
      errorMessage: feedErrorMessage(errorCode),
      // A parked feed has no next fetch; the year-9999 sentinel is not a date to show.
      nextFetchAt: toIso(Math.min(r.next_fetch_at, PARKED_AT)),
      warning: feedWarningMessage(r.warning_code),
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function listSubscriptions(db: Db, userId: string): Promise<Subscription[]> {
  const { rows } = await db.all<SubscriptionRow>(
    sql(`${SUBSCRIPTION_SELECT} WHERE s.user_id = ? ORDER BY s.created_at, s.id`, userId),
  );
  return rows.map(toSubscription);
}

/** Resolved with the user ID: another user's subscription is simply not found (spec §10.8). */
export async function getSubscription(
  db: Db,
  userId: string,
  subscriptionId: string,
): Promise<{ subscription: Subscription; feedId: number } | null> {
  const row = await db.first<SubscriptionRow>(
    sql(`${SUBSCRIPTION_SELECT} WHERE s.user_id = ? AND s.id = ?`, userId, subscriptionId),
  );
  return row ? { subscription: toSubscription(row), feedId: row.feed_id } : null;
}

// ── Folders (FR-FO-1 to FR-FO-5) ───────────────────────────────

export type FolderWrite =
  { ok: true; folder: Folder } | { ok: false; reason: 'conflict' | 'limit_reached' | 'not_found' };

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`);
}

/**
 * Names are unique per user and case-insensitive: the `name` column is `COLLATE NOCASE` and
 * `UNIQUE (user_id, name)` enforces it, so two racing creates cannot both win. The count guard is
 * inside the `INSERT`, so the limit cannot be passed by a race either.
 */
export async function createFolder(
  db: Db,
  userId: string,
  p: { id: string; name: string; now: number },
): Promise<FolderWrite> {
  try {
    const meta = await db.run(
      sql(
        `INSERT INTO folders (id, user_id, name, created_at)
         SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM folders WHERE user_id = ?) < ?`,
        p.id,
        userId,
        p.name,
        p.now,
        userId,
        FOLDER_LIMIT,
      ),
    );
    if (Number(meta.changes ?? 0) === 0) return { ok: false, reason: 'limit_reached' };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'conflict' };
    throw err;
  }
  return { ok: true, folder: { id: p.id, name: p.name } };
}

export async function renameFolder(
  db: Db,
  userId: string,
  folderId: string,
  name: string,
): Promise<FolderWrite> {
  try {
    const meta = await db.run(
      sql('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', name, folderId, userId),
    );
    if (Number(meta.changes ?? 0) === 0) return { ok: false, reason: 'not_found' };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'conflict' };
    throw err;
  }
  return { ok: true, folder: { id: folderId, name } };
}

/** FR-FO-3: the folder's subscriptions move to "no folder"; nothing is unsubscribed. */
export async function deleteFolder(db: Db, userId: string, folderId: string): Promise<boolean> {
  const results = await db.batch([
    sql(
      'UPDATE subscriptions SET folder_id = NULL WHERE user_id = ? AND folder_id = ?',
      userId,
      folderId,
    ),
    sql('DELETE FROM folders WHERE id = ? AND user_id = ?', folderId, userId),
  ]);
  return Number(results[1]?.meta.changes ?? 0) > 0;
}

// ── Subscription edit and unsubscribe (FR-SU-5, FR-SU-6) ───────

/** Each field is left alone when undefined. A null title clears the custom title. */
export async function updateSubscription(
  db: Db,
  userId: string,
  subscriptionId: string,
  p: { title?: string | null; folderId?: string | null },
): Promise<boolean> {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (p.title !== undefined) {
    sets.push('title_override = ?');
    params.push(p.title);
  }
  if (p.folderId !== undefined) {
    sets.push('folder_id = ?');
    params.push(p.folderId);
  }
  if (sets.length === 0) return (await getSubscription(db, userId, subscriptionId)) !== null;
  const meta = await db.run(
    sql(
      `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      ...params,
      subscriptionId,
      userId,
    ),
  );
  return Number(meta.changes ?? 0) > 0;
}

/**
 * One batch: delete the user's `user_entries` for the feed, delete the subscription, and park the
 * feed when nobody follows it any more (spec 7.1). Returns false when the user has no such
 * subscription.
 */
export async function deleteSubscription(
  db: Db,
  userId: string,
  subscriptionId: string,
): Promise<boolean> {
  const found = await getSubscription(db, userId, subscriptionId);
  if (!found) return false;
  await db.batch([
    sql('DELETE FROM user_entries WHERE user_id = ? AND feed_id = ?', userId, found.feedId),
    sql('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', subscriptionId, userId),
    sql(
      `UPDATE feeds SET next_fetch_at = ?
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE feed_id = feeds.id)`,
      PARKED_AT,
      found.feedId,
    ),
  ]);
  return true;
}
