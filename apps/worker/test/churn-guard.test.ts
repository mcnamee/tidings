import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../src/db';
import { MAX_NEW_ENTRIES_PER_FEED_PER_DAY, refreshFeed } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  feedRow,
  FEED_URL,
  items,
  jobFor,
  resetData,
  rss,
  seedFeed,
  type Fixture,
  type Item,
} from './support/refresh-harness';

// TID-046 (DEF-013, ADR 0013 decision 2): GUID churn guard and per-feed daily cap.

let fx: Fixture;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
});

async function refresh(feedId: number) {
  return refreshFeed(await jobFor(feedId), fx.deps);
}

/** `n` items with stable links and titles; the guid carries a per-fetch tag. */
const stable = (n: number, tag: string, link?: string): Item[] =>
  Array.from({ length: n }, (_, k) => ({
    guid: `${tag}-${k}`,
    title: `Stable title ${k}`,
    link: link ?? `https://site.example.com/posts/${k}`,
  }));

describe('AC1: new guids, same links and titles', () => {
  it('creates nothing after the first fetch and writes exactly 1 row per refresh', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: rss(stable(50, 'f0')) });
    expect((await refresh(id)).newEntries).toBe(50);

    for (let n = 1; n <= 10; n++) {
      fx.fake.route(FEED_URL, { status: 200, body: rss(stable(50, `f${n}`)) });
      const out = await refresh(id);
      expect(out.result).toBe('updated');
      expect(out.newEntries).toBe(0);
      expect(out.usage.rowsWritten).toBe(1);
    }
    expect(await count('entries', 'feed_id = ?', id)).toBe(50);
    expect(await count('user_entries', 'feed_id = ?', id)).toBe(50);
  });
});

describe('AC2: secondary key rules', () => {
  it('items sharing one link still dedupe by title; only the 3 new titles are inserted', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const home = 'https://site.example.com/';
    fx.fake.route(FEED_URL, { status: 200, body: rss(stable(50, 'a', home)) });
    await refresh(id);

    const next = [
      ...Array.from({ length: 3 }, (_, k) => ({
        guid: `b-new-${k}`,
        title: `Brand new ${k}`,
        link: home,
      })),
      ...stable(47, 'b', home),
    ];
    fx.fake.route(FEED_URL, { status: 200, body: rss(next) });
    const out = await refresh(id);
    expect(out.newEntries).toBe(3);
    expect(await count('entries', 'feed_id = ?', id)).toBe(53);
  });

  it('a key shared by two items in one fetch is ignored (same link and same title)', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const same = (tag: string): Item[] =>
      Array.from({ length: 5 }, (_, k) => ({
        guid: `${tag}-${k}`,
        title: 'Update',
        link: 'https://site.example.com/',
      }));
    fx.fake.route(FEED_URL, { status: 200, body: rss(same('a')) });
    expect((await refresh(id)).newEntries).toBe(5);
    expect((await feedRow(id)).recent_keys).toBe('[]');
    fx.fake.route(FEED_URL, { status: 200, body: rss(same('b')) });
    expect((await refresh(id)).newEntries).toBe(5); // not suppressed: the shared key is ignored
  });

  it('3 items with new guids whose link and title match the previous fetch are known', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: rss(stable(50, 'a')) });
    await refresh(id);
    const next = [...stable(3, 'renamed'), ...stable(50, 'a').slice(3)];
    fx.fake.route(FEED_URL, { status: 200, body: rss(next) });
    expect((await refresh(id)).newEntries).toBe(0);
  });

  it('an item with no link is keyed by title and date', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const noLink = (tag: string) =>
      rss([{ guid: tag, title: 'Linkless', ageH: 5 }]).replace(
        /<link>https:\/\/site\.example\.com\/posts\/[^<]*<\/link>/,
        '',
      );
    fx.fake.route(FEED_URL, { status: 200, body: noLink('a') });
    expect((await refresh(id)).newEntries).toBe(1);
    fx.fake.route(FEED_URL, { status: 200, body: noLink('b') });
    expect((await refresh(id)).newEntries).toBe(0);
  });
});

describe('AC3: daily cap', () => {
  /** 50 items whose guids, links and titles are all new on every fetch. */
  const churn = (n: number): Item[] =>
    Array.from({ length: 50 }, (_, k) => ({
      guid: `c${n}-${k}`,
      title: `Title ${n}-${k}`,
      link: `https://site.example.com/c${n}/${k}`,
    }));

  it('stores at most 200 per UTC day, warns, and clears on a later day under the cap', async () => {
    fx.clock.set('2026-11-10T20:00:00Z');
    const id = await seedFeed({ url: FEED_URL });
    const total = () => count('entries', 'feed_id = ?', id);

    for (let n = 0; n < 4; n++) {
      fx.fake.route(FEED_URL, { status: 200, body: rss(churn(n)) });
      expect((await refresh(id)).newEntries).toBe(50);
    }
    expect(await total()).toBe(MAX_NEW_ENTRIES_PER_FEED_PER_DAY);
    expect((await feedRow(id)).warning_code).toBeNull();

    fx.fake.route(FEED_URL, { status: 200, body: rss(churn(4)) });
    const capped = await refresh(id);
    expect(capped.newEntries).toBe(0);
    expect(capped.usage.rowsWritten).toBe(1);
    expect(await total()).toBe(200);
    const row = await feedRow(id);
    expect(row.warning_code).toBe('new_item_cap');

    // Same UTC day, one minute before midnight: still capped, the warning stays.
    fx.clock.set('2026-11-10T23:59:00Z');
    fx.fake.route(FEED_URL, { status: 200, body: rss(churn(5)) });
    expect((await refresh(id)).newEntries).toBe(0);
    expect((await feedRow(id)).warning_code).toBe('new_item_cap');

    // Cross midnight UTC: a fetch with 3 new items stays under the cap and clears the warning.
    fx.clock.set('2026-11-11T00:01:00Z');
    fx.fake.route(FEED_URL, { status: 200, body: rss(churn(6).slice(0, 3)) });
    expect((await refresh(id)).newEntries).toBe(3);
    const after = await feedRow(id);
    expect(after.warning_code).toBeNull();
    expect(after.new_entries_count).toBe(3);
    expect(await total()).toBe(203);
  });

  it('when over the cap the newest items are kept and the warning is set', async () => {
    fx.clock.set('2026-11-10T20:00:00Z');
    const id = await seedFeed({ url: FEED_URL });
    const today = Math.floor(fx.clock.now() / 86_400_000);
    await db.run(
      sql('UPDATE feeds SET new_entries_day = ?, new_entries_count = 190 WHERE id = ?', today, id),
    );
    fx.fake.route(FEED_URL, { status: 200, body: rss(churn(0)) });
    const out = await refresh(id);
    expect(out.newEntries).toBe(10);
    expect((await feedRow(id)).warning_code).toBe('new_item_cap');
    // rss() ages items by index, so the newest are the first ten.
    const { rows } = await db.all<{ title: string }>(
      sql('SELECT title FROM entries WHERE feed_id = ? ORDER BY published_at DESC', id),
    );
    expect(rows.map((r) => r.title)).toEqual(
      churn(0)
        .slice(0, 10)
        .map((i) => i.title),
    );
  });
});

describe('AC4: normal feeds cost the same', () => {
  it('3 new in 50, 2 subscribers: 55 rows written, 163 read, 7 statements (one each added by TID-067 and TID-071)', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1', 'u2'] });
    const feed = fx.fake.serveFeed(FEED_URL, rss(items(4, 50)), { etag: '"v1"' });
    await refresh(id);
    feed.update(rss(items(1, 50)), '"v2"');
    const out = await refresh(id);
    expect(out.newEntries).toBe(3);
    expect(out.usage.rowsWritten).toBe(55); // + 3 image_queue rows (TID-071); 3 x 4 + 3 x 6 x 2 + 1 (ue_entry, TID-021; entries_url_key, TID-061) + 3 embed_queue rows (TID-067)
    expect(out.usage.rowsRead).toBe(163); // + 12 for the image_queue insert (TID-071: 4 per new entry); 121 + 3 new x 2 subscribers x 3 for the TID-061 duplicate probe + 12 for the embed_queue insert (TID-067: 4 per new entry)
    // parked check, dedup lookup, then one batch: entries insert, link, feed update.
    expect(out.usage.statements).toBe(7);
  });
});

describe('AC5: migration 0003', () => {
  it('adds exactly the four columns, and no index', async () => {
    const { rows } = await db.all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>(sql('SELECT name, type, "notnull", dflt_value FROM pragma_table_info(\'feeds\')'));
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.recent_keys).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(by.new_entries_day).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(by.new_entries_count).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    expect(by.warning_code).toMatchObject({ type: 'TEXT', notnull: 0 });
    const idx = await db.all<{ name: string }>(sql("SELECT name FROM pragma_index_list('feeds')"));
    // Only the automatic index for `url UNIQUE`.
    expect(idx.rows.every((r) => r.name.startsWith('sqlite_autoindex'))).toBe(true);
  });

  it('rejects an unknown warning code', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await expect(
      db.run(sql("UPDATE feeds SET warning_code = 'nope' WHERE id = ?", id)),
    ).rejects.toThrow();
  });
});

describe('AC6: first fetch', () => {
  it('drops nothing (even items sharing keys) and the cap counts the inserted entries', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'pending', lastSuccessAt: null });
    const dup: Item[] = [
      { guid: 'x1', title: 'Same', link: 'https://site.example.com/' },
      { guid: 'x2', title: 'Same', link: 'https://site.example.com/' },
      ...items(1, 48),
    ];
    fx.fake.route(FEED_URL, { status: 200, body: rss(dup) });
    const out = await refresh(id);
    expect(out.newEntries).toBe(50);
    expect(await count('entries', 'feed_id = ?', id)).toBe(50);
    const row = await feedRow(id);
    expect(row.new_entries_count).toBe(50);
    expect(row.warning_code).toBeNull();
  });
});
