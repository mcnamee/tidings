import { Db, sql, type Meta, type SqlValue } from './client';
import { decodeCursor, encodeCursor } from './cursor';
import { ValidationError } from './errors';

export type EntryView = 'all' | 'folder' | 'feed';

export interface ListEntriesParams {
  view: EntryView;
  /** Folder ID (view=folder) or feed ID (view=feed); ignored for view=all. */
  id?: string | number;
  unreadOnly: boolean;
  limit: number;
  cursor?: string | null;
}

export interface EntrySummaryRow {
  entry_id: number;
  feed_id: number;
  published_at: number;
  is_read: number;
  is_starred: number;
  title: string | null;
  author: string | null;
  url: string | null;
  summary: string | null;
  image_url: string | null;
  /** Packed `entries.topics` (TID-077); null when untagged. */
  topics: number | null;
}

export interface EntryPage {
  items: EntrySummaryRow[];
  nextCursor: string | null;
  meta: Meta;
}

export const MAX_PAGE_LIMIT = 100;

const SELECT =
  'SELECT ue.entry_id, ue.feed_id, ue.published_at, ue.is_read, ue.is_starred, ' +
  'e.title, e.author, e.url, e.summary, e.image_url, e.topics ';

// Static index names only (never user input). Partial indexes need `is_read = 0` in the WHERE.
const INDEX_FOR: Record<EntryView, { unread: string | null; all: string | null }> = {
  all: { unread: 'ue_unread_all', all: 'ue_all' },
  feed: { unread: 'ue_unread_feed', all: 'ue_feed' },
  // IN-list over feeds: let the planner choose (spec §8.6).
  folder: { unread: null, all: null },
};

/**
 * Keyset-paginated entries list (spec §8.6), scoped to `userId`. Reads at most about
 * (limit + 1) * 2 rows for the all and feed views (NFR-7).
 */
export async function listEntries(
  db: Db,
  userId: string,
  params: ListEntriesParams,
): Promise<EntryPage> {
  const { view, unreadOnly, limit } = params;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ValidationError('limit must be between 1 and 100', { field: 'limit' });
  }
  if (view !== 'all' && (params.id === undefined || params.id === '')) {
    throw new ValidationError('id is required unless view=all', { field: 'id' });
  }

  const index = INDEX_FOR[view][unreadOnly ? 'unread' : 'all'];
  const binds: SqlValue[] = [userId];
  let text: string;

  if (view === 'folder') {
    // Keys first (NFR-7b, DEF-050): pick the page's (feed, published_at, entry) keys from the
    // covering feed index, then fetch the row and entry columns for those keys only. The plain
    // join made the planner walk the user's whole unread/all view and test the folder per row.
    const keyIndex = unreadOnly ? 'ue_unread_feed' : 'ue_feed';
    let keys =
      'SELECT feed_id, published_at, entry_id FROM user_entries INDEXED BY ' +
      keyIndex +
      ' WHERE user_id = ?';
    if (unreadOnly) keys += ' AND is_read = 0';
    keys +=
      ' AND feed_id IN (SELECT feed_id FROM subscriptions WHERE user_id = ? AND folder_id = ?)';
    binds.push(userId, String(params.id));
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      keys += ' AND (published_at, entry_id) < (?, ?)';
      binds.push(c.p, c.i);
    }
    keys += ' ORDER BY published_at DESC, entry_id DESC LIMIT ?';
    binds.push(limit + 1);
    text =
      SELECT +
      'FROM (' +
      keys +
      ') k JOIN user_entries ue ON ue.user_id = ? AND ue.entry_id = k.entry_id ' +
      'JOIN entries e ON e.id = k.entry_id ORDER BY k.published_at DESC, k.entry_id DESC';
    binds.push(userId);
  } else {
    text =
      SELECT +
      'FROM user_entries ue ' +
      (index ? 'INDEXED BY ' + index + ' ' : '') +
      'JOIN entries e ON e.id = ue.entry_id WHERE ue.user_id = ?';

    if (unreadOnly) text += ' AND ue.is_read = 0';
    if (view === 'feed') {
      text += ' AND ue.feed_id = ?';
      binds.push(Number(params.id));
    }
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      text += ' AND (ue.published_at, ue.entry_id) < (?, ?)';
      binds.push(c.p, c.i);
    }
    text += ' ORDER BY ue.published_at DESC, ue.entry_id DESC LIMIT ?';
    binds.push(limit + 1);
  }

  const { rows, meta } = await db.all<EntrySummaryRow>(sql(text, ...binds));
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ p: last.published_at, i: last.entry_id }) : null,
    meta,
  };
}
