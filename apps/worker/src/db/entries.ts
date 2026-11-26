import { TOPIC_SCAN_LIMIT, topicIdOfSlug } from '@tidings/shared';
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
  /** TID-078: an active topic slug. Only with `view=all`. */
  topic?: string;
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

/** True when any of the three packed topic slots of `column` holds `?`. NULL (untagged) never matches. */
export const TOPIC_MATCH = (column: string) =>
  `((${column} & 255) = ? OR ((${column} >> 8) & 255) = ? OR ((${column} >> 16) & 255) = ?)`;

/** The numeric ID of the topic slug, or a validation error (unknown, retired or not allowed with this view). */
export function topicIdFor(view: EntryView, slug: string): number {
  const id = topicIdOfSlug(slug);
  if (id === null) throw new ValidationError('Unknown topic', { field: 'topic' });
  if (view !== 'all') {
    throw new ValidationError('topic is only allowed with view=all', { field: 'topic' });
  }
  return id;
}

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

  if (params.topic !== undefined) return listTopicEntries(db, userId, params);

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

/**
 * One page of All articles filtered by topic (TID-078, ADR 0021 section 7, spec 8.6). `entries.topics`
 * is not indexed, so the page walks the same index as the unfiltered list and reads at most
 * {@link TOPIC_SCAN_LIMIT} of the caller's rows after the cursor (a subquery bound), joining each to
 * `entries` by primary key and keeping those whose topic matches. The page can therefore be short or
 * empty with a cursor: when the page fills it is the last item served, when the scan limit comes first it
 * is the last row scanned, and `null` only when the index is exhausted. `user_id = ?` is in the scan.
 */
async function listTopicEntries(
  db: Db,
  userId: string,
  params: ListEntriesParams,
): Promise<EntryPage> {
  const { unreadOnly, limit } = params;
  const topicId = topicIdFor(params.view, params.topic ?? '');
  const index = INDEX_FOR.all[unreadOnly ? 'unread' : 'all'];

  // The scan: the caller's index rows after the cursor, newest first, at most TOPIC_SCAN_LIMIT.
  const scanBinds: SqlValue[] = [userId];
  let scan =
    'FROM user_entries INDEXED BY ' +
    index +
    ' WHERE user_id = ?' +
    (unreadOnly ? ' AND is_read = 0' : '');
  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    scan += ' AND (published_at, entry_id) < (?, ?)';
    scanBinds.push(c.p, c.i);
  }
  scan += ' ORDER BY published_at DESC, entry_id DESC LIMIT ' + TOPIC_SCAN_LIMIT;

  const { rows, meta } = await db.all<EntrySummaryRow>(
    sql(
      SELECT +
        'FROM (SELECT entry_id, feed_id, published_at, is_read, is_starred ' +
        scan +
        ') ue JOIN entries e ON e.id = ue.entry_id WHERE ' +
        TOPIC_MATCH('e.topics') +
        ' ORDER BY ue.published_at DESC, ue.entry_id DESC LIMIT ?',
      ...scanBinds,
      topicId,
      topicId,
      topicId,
      limit + 1,
    ),
  );
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    const last = items[items.length - 1] as EntrySummaryRow;
    return {
      items,
      nextCursor: encodeCursor({ p: last.published_at, i: last.entry_id }),
      meta,
    };
  }

  // Fewer matches than a page: the whole scan was read. If the index goes on past it, carry on from the
  // last row scanned (a covering index read, and only on a page that did not fill).
  const edge = await db.all<{ published_at: number; entry_id: number }>(
    sql(
      'SELECT published_at, entry_id ' +
        scan.replace(/ LIMIT \d+$/, '') +
        ' LIMIT 2 OFFSET ' +
        (TOPIC_SCAN_LIMIT - 1),
      ...scanBinds,
    ),
  );
  const [lastScanned, beyond] = edge.rows;
  return {
    items: rows,
    nextCursor:
      lastScanned && beyond
        ? encodeCursor({ p: lastScanned.published_at, i: lastScanned.entry_id })
        : null,
    meta: { ...meta, rows_read: Number(meta.rows_read ?? 0) + Number(edge.meta.rows_read ?? 0) },
  };
}
