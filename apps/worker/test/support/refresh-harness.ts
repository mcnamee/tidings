import { env } from 'cloudflare:workers';
import {
  createFakeFetch,
  createFixedClock,
  type FakeFetch,
  type FixedClock,
} from '@tidings/test-utils';
import { Db, sql } from '../../src/db';
import type { RefreshDeps, RefreshJob } from '../../src/refresh';

export const db = new Db(env.DB);

export const APP_ORIGIN = 'https://tidings.mcn.am';
export const FEED_URL = 'https://feed.example.com/rss.xml';

export interface Fixture {
  clock: FixedClock;
  fake: FakeFetch;
  logs: { event: string; data: Record<string, unknown> }[];
  deps: RefreshDeps;
}

export function createFixture(overrides: Partial<RefreshDeps> = {}): Fixture {
  const clock = createFixedClock();
  const fake = createFakeFetch();
  const logs: Fixture['logs'] = [];
  return {
    clock,
    fake,
    logs,
    deps: {
      db,
      fetch: fake.fetch as RefreshDeps['fetch'],
      clock: () => clock.now(),
      random: () => 0.5, // jitter factor exactly 1.0
      appOrigin: APP_ORIGIN,
      allowHosts: [],
      log: (event, data) => logs.push({ event, data }),
      ...overrides,
    },
  };
}

export async function resetData(): Promise<void> {
  for (const t of [
    'engagement',
    'user_entries',
    'entries',
    'subscriptions',
    'folders',
    'feeds',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
}

export async function seedUser(id: string): Promise<void> {
  await db.run(
    sql("INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, 'owner', 0)", id, id),
  );
}

export interface SeedFeed {
  id?: number;
  url?: string;
  nextFetchAt?: number;
  state?: string;
  errorCount?: number;
  etag?: string | null;
  bodyHash?: string | null;
  lastSuccessAt?: number | null;
  subscribers?: string[];
}

let nextId = 1000;

/** Inserts a feed (and subscriptions for `subscribers`, creating the users). Returns the feed id. */
export async function seedFeed(opts: SeedFeed = {}): Promise<number> {
  const id = opts.id ?? nextId++;
  await db.run(
    sql(
      `INSERT INTO feeds (id, url, next_fetch_at, state, error_count, etag, body_hash,
                          last_success_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      id,
      opts.url ?? `https://feed${id}.example.com/rss.xml`,
      opts.nextFetchAt ?? 0,
      opts.state ?? 'ok',
      opts.errorCount ?? 0,
      opts.etag ?? null,
      opts.bodyHash ?? null,
      opts.lastSuccessAt === undefined ? 1 : opts.lastSuccessAt,
    ),
  );
  for (const user of opts.subscribers ?? ['u1']) {
    await db.run(
      sql(
        'INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, 0)',
        user,
        user,
      ),
    );
    await db.run(
      sql(
        'INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES (?, ?, ?, 0)',
        `${user}-${id}`,
        user,
        id,
      ),
    );
  }
  return id;
}

export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  site_url: string | null;
  etag: string | null;
  last_modified: string | null;
  body_hash: string | null;
  fetch_interval_s: number;
  next_fetch_at: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_new_entry_at: number | null;
  error_count: number;
  last_error_code: string | null;
  last_status: number | null;
  state: string;
  recent_keys: string | null;
  new_entries_day: number | null;
  new_entries_count: number;
  warning_code: string | null;
}

export async function feedRow(id: number): Promise<FeedRow> {
  const { rows } = await db.all<FeedRow>(sql('SELECT * FROM feeds WHERE id = ?', id));
  const row = rows[0];
  if (!row) throw new Error(`no feed ${id}`);
  return row;
}

/** The job the dispatcher's lease would hand out for this feed right now. */
export async function jobFor(id: number): Promise<RefreshJob> {
  const r = await feedRow(id);
  return {
    feedId: r.id,
    url: r.url,
    etag: r.etag,
    lastModified: r.last_modified,
    bodyHash: r.body_hash,
    errorCount: r.error_count,
    state: r.state as RefreshJob['state'],
    fetchIntervalS: r.fetch_interval_s,
    lastSuccessAt: r.last_success_at,
    recentKeys: r.recent_keys,
    newEntriesDay: r.new_entries_day,
    newEntriesCount: r.new_entries_count,
    warningCode: r.warning_code,
  };
}

export async function count(
  table: string,
  where = '1 = 1',
  ...params: (string | number)[]
): Promise<number> {
  const { rows } = await db.all<{ n: number }>(
    sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params),
  );
  return rows[0]?.n ?? 0;
}

export interface Item {
  guid: string;
  title?: string;
  link?: string;
  /** Hours before the fixed clock. */
  ageH?: number;
}

/** A small RSS 2.0 document. */
export function rss(items: Item[], title = 'Test feed'): string {
  const body = items
    .map((i, n) => {
      const age = i.ageH ?? n + 1;
      const date = new Date(Date.UTC(2026, 10, 10, 12) - age * 3_600_000).toUTCString();
      return (
        `<item><title>${i.title ?? `Item ${i.guid}`}</title>` +
        `<link>${i.link ?? `https://site.example.com/posts/${i.guid}`}</link>` +
        `<guid isPermaLink="false">${i.guid}</guid><pubDate>${date}</pubDate>` +
        `<description>About ${i.guid}</description></item>`
      );
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
    `<title>${title}</title><link>https://site.example.com/</link>${body}</channel></rss>`
  );
}

export function items(from: number, to: number): Item[] {
  return Array.from({ length: to - from + 1 }, (_, n) => ({ guid: `g${from + n}` }));
}
