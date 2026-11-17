import { runSql, SEED_USER_ID } from './auth-state.ts';

// Folders, feeds and articles for the owner that the E2E database starts with (TID-018). Specs that
// add rows remove them again with `clearListData()` so the resting state stays "an owner, nothing
// else". Setup only: never build these statements from page input.

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export interface SeedFolder {
  id: string;
  name: string;
}
export interface SeedSub {
  id: string;
  feedId: number;
  title: string;
  folderId?: string;
}
export interface SeedEntry {
  id: number;
  feedId: number;
  title: string;
  summary?: string;
  author?: string;
  url?: string;
  /** Raw feed HTML, as stored (TID-019). */
  contentHtml?: string;
  publishedAt: number;
  isRead?: boolean;
}

export function seedListData(data: {
  folders?: SeedFolder[];
  subs?: SeedSub[];
  entries?: SeedEntry[];
}): void {
  const sql: string[] = [];
  for (const f of data.folders ?? []) {
    sql.push(
      `INSERT INTO folders (id, user_id, name, created_at) VALUES (${q(f.id)}, ${q(SEED_USER_ID)}, ${q(f.name)}, 0);`,
    );
  }
  for (const s of data.subs ?? []) {
    // next_fetch_at far in the future: the refresh cron never picks these feeds up.
    sql.push(
      `INSERT INTO feeds (id, url, title, next_fetch_at, state, last_success_at, created_at) VALUES (${s.feedId}, ${q(`https://e2e-${s.feedId}.example.com/rss`)}, ${q(s.title)}, 9999999999, 'ok', 1, 0);`,
      `INSERT INTO subscriptions (id, user_id, feed_id, folder_id, created_at) VALUES (${q(s.id)}, ${q(SEED_USER_ID)}, ${s.feedId}, ${s.folderId ? q(s.folderId) : 'NULL'}, 0);`,
    );
  }
  for (const e of data.entries ?? []) {
    sql.push(
      `INSERT INTO entries (id, feed_id, guid_hash, url, title, author, summary, content_html, published_at, fetched_at) VALUES (${e.id}, ${e.feedId}, ${q(`e2e-guid-${e.id}`)}, ${e.url ? q(e.url) : 'NULL'}, ${q(e.title)}, ${e.author ? q(e.author) : 'NULL'}, ${e.summary ? q(e.summary) : 'NULL'}, ${e.contentHtml ? q(e.contentHtml) : 'NULL'}, ${e.publishedAt}, ${e.publishedAt});`,
      `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (${q(SEED_USER_ID)}, ${e.id}, ${e.feedId}, ${e.publishedAt}, ${e.isRead ? 1 : 0});`,
    );
  }
  if (sql.length > 0) runSql(sql.join(' '));
}

export function clearListData(): void {
  runSql(
    'DELETE FROM user_entries; DELETE FROM entries; DELETE FROM subscriptions; DELETE FROM folders; DELETE FROM feeds;',
  );
}
