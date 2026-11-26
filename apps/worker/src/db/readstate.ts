/**
 * Read state and the single-entry read (spec 8.5, 9.4). A read-state write costs one
 * `user_entries` row plus its partial-index maintenance (about 3 rows written), so every statement
 * only touches rows whose state really changes: repeating a request writes nothing. Every query
 * puts `user_id = ?` in its SQL (spec 10.8).
 */
import { Db, sql, type Meta, type SqlValue } from './client';
import { TOPIC_MATCH, topicIdFor, type EntrySummaryRow, type EntryView } from './entries';

export interface EntryRow extends EntrySummaryRow {
  content_html: string | null;
}

/** An entry ID from a URL or body: a plain integer, or null (it can match nothing). */
export function parseEntryId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export async function getEntry(db: Db, userId: string, entryId: number): Promise<EntryRow | null> {
  return db.first<EntryRow>(
    sql(
      'SELECT ue.entry_id, ue.feed_id, ue.published_at, ue.is_read, ue.is_starred, ' +
        'e.title, e.author, e.url, e.summary, e.image_url, e.topics, e.content_html ' +
        'FROM user_entries ue JOIN entries e ON e.id = ue.entry_id ' +
        'WHERE ue.user_id = ? AND ue.entry_id = ?',
      userId,
      entryId,
    ),
  );
}

/** Sets one entry's state. A no-op (and no write) when it is already in that state. */
export async function setRead(
  db: Db,
  userId: string,
  entryId: number,
  isRead: boolean,
  nowSeconds: number,
): Promise<Meta> {
  return db.run(
    sql(
      'UPDATE user_entries SET is_read = ?, read_at = ? ' +
        'WHERE user_id = ? AND entry_id = ? AND is_read = ?',
      isRead ? 1 : 0,
      isRead ? nowSeconds : null,
      userId,
      entryId,
      isRead ? 0 : 1,
    ),
  );
}

/**
 * Sets many entries' state in one statement. The IDs travel as one JSON parameter (D1 allows 100
 * bound parameters per statement), looked up on the primary key. Returns how many changed.
 */
export async function setReadMany(
  db: Db,
  userId: string,
  entryIds: readonly number[],
  isRead: boolean,
  nowSeconds: number,
): Promise<{ updated: number; meta: Meta }> {
  const meta = await db.run(
    sql(
      'UPDATE user_entries SET is_read = ?, read_at = ? ' +
        'WHERE user_id = ? AND is_read = ? AND entry_id IN (SELECT value FROM json_each(?))',
      isRead ? 1 : 0,
      isRead ? nowSeconds : null,
      userId,
      isRead ? 0 : 1,
      JSON.stringify(entryIds),
    ),
  );
  return { updated: Number(meta.changes ?? 0), meta };
}

/**
 * Marks every unread entry of a view read, in one set-based statement (FR-RD-9, spec 9.4). Only
 * rows that are unread, belong to `userId`, are in the view and have `published_at <= beforeSeconds`
 * are touched, so nothing that arrived after the list was loaded changes, and a repeat writes
 * nothing. `RETURNING` gives the changed IDs for Undo without a second query. `id` is the feed ID
 * (view=feed) or the folder ID (view=folder), already checked as the caller's.
 */
export async function markAllRead(
  db: Db,
  userId: string,
  view: EntryView,
  id: string | number | undefined,
  beforeSeconds: number,
  nowSeconds: number,
  topic?: string,
): Promise<{ entryIds: number[]; meta: Meta }> {
  const binds: SqlValue[] = [nowSeconds, userId, beforeSeconds];
  let scope = '';
  if (topic !== undefined) {
    // TID-078: only that topic's entries (view=all). The entry is looked up by primary key per unread
    // row, so the statement reads about 2 rows per unread article and never scans `entries`.
    const t = topicIdFor(view, topic);
    scope =
      ' AND EXISTS (SELECT 1 FROM entries e WHERE e.id = user_entries.entry_id AND ' +
      TOPIC_MATCH('e.topics') +
      ')';
    binds.push(t, t, t);
  }
  if (view === 'feed') {
    scope = ' AND feed_id = ?';
    binds.push(Number(id));
  } else if (view === 'folder') {
    scope =
      ' AND feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ? AND folder_id = ?)';
    binds.push(userId, String(id));
  }
  const { rows, meta } = await db.all<{ entry_id: number }>(
    sql(
      'UPDATE user_entries SET is_read = 1, read_at = ? ' +
        'WHERE user_id = ? AND is_read = 0 AND published_at <= ?' +
        scope +
        ' RETURNING entry_id',
      ...binds,
    ),
  );
  return { entryIds: rows.map((r) => r.entry_id), meta };
}
