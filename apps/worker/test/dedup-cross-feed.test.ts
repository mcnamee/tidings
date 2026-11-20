import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listEntries, sql, unreadCounts } from '../src/db';
import { notDuplicateOf } from '../src/db/dedup';
import { createSubscription } from '../src/db/subscriptions';
import { setRead } from '../src/db/readstate';
import { refreshFeed } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  jobFor,
  resetData,
  rss,
  seedFeed,
  type Fixture,
  type Item,
} from './support/refresh-harness';

// TID-061, ADR 0017: hide duplicate articles across feeds, per user.

const FEED_A = 'https://a.example.com/rss.xml';
const FEED_B = 'https://b.example.com/rss.xml';
const FEED_C = 'https://c.example.com/rss.xml';
const NOW = () => Math.floor(fx.clock.now() / 1000);

let fx: Fixture;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
});

async function fetchFeed(id: number, url: string, list: Item[]) {
  fx.fake.route(url, { status: 200, body: rss(list) });
  return refreshFeed(await jobFor(id), fx.deps);
}

/** Titles of the user's entries, newest first (all views are driven by `user_entries`). */
async function shown(user: string, view: 'all' | 'folder' | 'feed' = 'all', id?: string | number) {
  const page = await listEntries(db, user, { view, id, unreadOnly: false, limit: 100 });
  const { rows } = await db.all<{ id: number; title: string; feed_id: number }>(
    sql('SELECT id, title, feed_id FROM entries'),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return page.items.map((i) => byId.get(i.entry_id)!);
}

const story = (over: Partial<Item> = {}): Item => ({
  guid: 'g1',
  title: 'Prime minister announces big new plan',
  link: 'https://news.example.com/world/articles/c1',
  ageH: 2,
  ...over,
});

describe('AC1: same canonical URL in two feeds', () => {
  it('appears once in All, once in a folder holding both, and in the feed it arrived from first', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await db.run(
      sql("INSERT INTO folders (id, user_id, name, created_at) VALUES ('f1','u1','News',0)"),
    );
    await db.run(sql("UPDATE subscriptions SET folder_id = 'f1' WHERE user_id = 'u1'"));

    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    const out = await fetchFeed(b, FEED_B, [
      story({
        guid: 'b1',
        // scheme, www, tracking parameters and fragment differ
        link: 'http://www.news.example.com/world/articles/c1/?at_medium=RSS&at_campaign=rss&utm_source=x#top',
        title: 'Different headline entirely for this one',
      }),
    ]);

    expect(out.newEntries).toBe(1); // stored (shared, nothing is lost) ...
    expect(await count('entries')).toBe(2);
    expect(await count('user_entries')).toBe(1); // ... but not linked to the user who has it
    expect(await shown('u1')).toHaveLength(1);
    expect(await shown('u1', 'folder', 'f1')).toHaveLength(1);
    expect(await shown('u1', 'feed', a)).toHaveLength(1);
    expect(await shown('u1', 'feed', b)).toHaveLength(0);
  });

  it('a feed that points every item at its home page never matches another feed', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    const home = 'https://shared.example.com/';
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: home, title: 'First totally unrelated story here' }),
    ]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', link: home, title: 'Second totally different story there' }),
    ]);
    expect(await count('user_entries')).toBe(2);
  });

  it('a URL shared by two items of one fetch is not used as a key', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    const page = 'https://pod.example.com/show';
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: page, title: 'Episode one of the show' }),
      story({ guid: 'a2', link: page, title: 'Episode two of the show' }),
    ]);
    expect(await count('entries', 'url_key IS NOT NULL')).toBe(0);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', link: page, title: 'Episode three here too' }),
    ]);
    expect(await count('user_entries')).toBe(3);
  });

  it('a same-feed item with a new guid is left to the churn guard, not matched by URL', async () => {
    const a = await seedFeed({ url: FEED_A });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1' }),
      story({ guid: 'a2', title: 'A genuinely second story about it', ageH: 1 }),
    ]);
    expect(await count('user_entries')).toBe(2);
  });
});

describe('AC2: same headline, different URLs, within 48 hours', () => {
  const pair = async (ageB: number, titleB = 'PRIME MINISTER announces: "big" new plan!') => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1', link: 'https://x.example.com/1', ageH: 2 })]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', link: 'https://y.example.com/other', title: titleB, ageH: ageB }),
    ]);
    return { a, b };
  };

  it('hides the later copy when case, punctuation and quotes differ', async () => {
    await pair(5);
    expect(await count('user_entries')).toBe(1);
  });

  it('folds curly quotes and apostrophes', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: 'https://x.example.com/1', title: "Why the PM won't quit now" }),
    ]);
    await fetchFeed(b, FEED_B, [
      story({
        guid: 'b1',
        link: 'https://y.example.com/2',
        title: '“Why the PM won’t quit now”',
      }),
    ]);
    expect(await count('user_entries')).toBe(1);
  });

  it('keeps both when published more than 48 hours apart, and hides at 47 hours', async () => {
    await resetData();
    await pair(2 + 49);
    expect(await count('user_entries')).toBe(2);
    await resetData();
    await pair(2 + 47);
    expect(await count('user_entries')).toBe(1);
  });

  it('a headline under 4 words never matches', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: 'https://x.example.com/1', title: 'Live updates' }),
    ]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', link: 'https://y.example.com/2', title: 'Live updates!' }),
    ]);
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: 'https://x.example.com/1', title: 'Live updates' }),
      story({ guid: 'a3', link: 'https://x.example.com/3', title: 'One two three', ageH: 1 }),
    ]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', link: 'https://y.example.com/2', title: 'Live updates!' }),
      story({ guid: 'b3', link: 'https://y.example.com/3', title: 'One two three', ageH: 1 }),
    ]);
    expect(await count('user_entries')).toBe(4);
    expect(await count('entries', 'headline_key IS NOT NULL')).toBe(0);
  });

  it('the same headline twice in one feed is not a cross-feed duplicate', async () => {
    const a = await seedFeed({ url: FEED_A });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1', link: 'https://x.example.com/1' })]);
    await fetchFeed(a, FEED_A, [
      story({ guid: 'a1', link: 'https://x.example.com/1' }),
      story({ guid: 'a2', link: 'https://x.example.com/2', ageH: 1 }),
    ]);
    expect(await count('user_entries')).toBe(2);
  });
});

describe('AC3: read state and counts', () => {
  it('a duplicate arriving after the first copy was read is not a new unread article', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    const { rows } = await db.all<{ entry_id: number }>(sql('SELECT entry_id FROM user_entries'));
    await setRead(db, 'u1', rows[0]!.entry_id, true, NOW());
    expect((await unreadCounts(db, 'u1')).counts.total).toBe(0);

    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    expect((await unreadCounts(db, 'u1')).counts.total).toBe(0);
    expect(await count('user_entries')).toBe(1);

    // Marking the visible copy unread and read again is the story's state; there is no second copy.
    await setRead(db, 'u1', rows[0]!.entry_id, false, NOW());
    expect((await unreadCounts(db, 'u1')).counts.total).toBe(1);
  });

  it('unread counts count the story once', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    const counts = await unreadCounts(db, 'u1');
    expect(counts.counts.total).toBe(1);
  });
});

describe('AC4: dedup is per user', () => {
  it("a user who follows only feed B still sees B's copy", async () => {
    const a = await seedFeed({ url: FEED_A, subscribers: ['u1'] });
    const b = await seedFeed({ url: FEED_B, subscribers: ['u1', 'u2'] });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    expect(await shown('u1')).toHaveLength(1);
    expect((await shown('u1'))[0]?.feed_id).toBe(a);
    const u2 = await shown('u2');
    expect(u2).toHaveLength(1);
    expect(u2[0]?.feed_id).toBe(b);
  });

  it('two users who both follow A and B each see the story once', async () => {
    const a = await seedFeed({ url: FEED_A, subscribers: ['u1', 'u2'] });
    const b = await seedFeed({ url: FEED_B, subscribers: ['u1', 'u2'] });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(1);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(1);
  });

  it("someone else's copy never hides mine", async () => {
    const a = await seedFeed({ url: FEED_A, subscribers: ['u2'] });
    const b = await seedFeed({ url: FEED_B, subscribers: ['u1'] });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(1);
  });

  it('subscribing to feed B later links its stories except those the user already has from A', async () => {
    const a = await seedFeed({ url: FEED_A, subscribers: ['u1'] });
    const b = await seedFeed({ url: FEED_B, subscribers: ['u2'] });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1' }),
      story({
        guid: 'b2',
        link: 'https://news.example.com/only-b',
        title: 'A story only feed B has',
        ageH: 1,
      }),
    ]);
    await db.run(
      sql("INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES ('u1','u1',0)"),
    );
    const created = await createSubscription(db, {
      userId: 'u1',
      subscriptionId: 'u1-b',
      feedUrl: FEED_B,
      folderId: null,
      titleOverride: null,
      now: NOW(),
      jitterS: 0,
      limit: 1000,
    });
    expect(created).toBe(true);
    const mine = await shown('u1');
    expect(mine.map((m) => m.title).sort()).toEqual([
      'A story only feed B has',
      'Prime minister announces big new plan',
    ]);
    expect(b).toBeGreaterThan(0);
  });
});

describe('AC5: an updated article is not shown twice', () => {
  it('the same URL with new content in another feed is the same story', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', title: 'UPDATED: prime minister announces big new plan' }),
    ]);
    expect(await count('user_entries')).toBe(1);
  });

  it('the same guid with changed content in the same feed adds nothing', async () => {
    const a = await seedFeed({ url: FEED_A });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(a, FEED_A, [story({ guid: 'a1', title: 'Edited headline of the same story' })]);
    expect(await count('entries')).toBe(1);
    expect(await count('user_entries')).toBe(1);
  });
});

describe('AC6: bounded, indexed lookup and measured cost', () => {
  it('only compares against the last 7 days', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    fx.clock.advance(8 * 86_400_000); // A's copy was published 8 days ago by now
    await fetchFeed(b, FEED_B, [story({ guid: 'b1', ageH: 2 })]);
    expect(await count('user_entries')).toBe(2);
  });

  it('writes 2 more rows per keyed new entry, nothing for a hidden duplicate, 0 extra statements', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    const first = await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    // entries: row + unique + entries_published + url key + headline key = 5; user_entries 6;
    // feed update 1. Before TID-061: 3 + 6 + 1 = 10.
    // + 1 embed_queue row (TID-067).
    // + 1 image_queue row (TID-071: no feed image, has a link).
    expect(first.usage.rowsWritten).toBe(5 + 6 + 1 + 1 + 1);
    // parked check, dedup lookup, entries insert, link, embed_queue insert (TID-067), image_queue insert
    // (TID-071), feed update.
    expect(first.usage.statements).toBe(7);

    const dup = await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    expect(dup.usage.rowsWritten).toBe(5 + 0 + 1); // no user_entries rows
    expect(dup.usage.statements).toBe(7);
    // probe reads: a handful of index rows, not a scan (measured; see spec 9.5).
    expect(dup.usage.rowsRead).toBeLessThanOrEqual(1 + 1 + 1 + 1 + 12);
  });

  it('50 new items x 3 subscribers: at most 6 extra reads per candidate and subscriber', async () => {
    const mk = (prefix: string, keyed: boolean): Item[] =>
      Array.from({ length: 50 }, (_, k) =>
        story({
          guid: `${prefix}${k}`,
          // keyless: home-page link and a 2-word headline, so neither key exists
          link: keyed ? `https://n.example.com/${prefix}/${k}` : 'https://n.example.com/',
          title: keyed ? `Story number ${k} of the day ${prefix}` : `Item ${prefix}${k}`,
          ageH: k + 1,
        }),
      );
    const run = async (prefix: string, keyed: boolean) => {
      await resetData();
      const id = await seedFeed({ url: FEED_A, subscribers: ['u1', 'u2', 'u3'] });
      const out = await fetchFeed(id, FEED_A, mk(prefix, keyed));
      expect(out.newEntries).toBe(50);
      return out.usage;
    };
    const keyless = await run('k', false);
    const keyed = await run('n', true);
    console.log(
      `TID-061 50 items x 3 subscribers: keyless ${JSON.stringify(keyless)} keyed ${JSON.stringify(keyed)}`,
    );
    expect(keyed.statements).toBeLessThanOrEqual(15);
    expect(keyed.statements).toBe(keyless.statements); // no statement added by the probes
    expect(keyed.rowsWritten - keyless.rowsWritten).toBe(50 * 2);
    expect(keyed.rowsRead - keyless.rowsRead).toBeLessThanOrEqual(150 * 6);
  });

  it('the lookup uses the key indexes and a primary-key probe, never a scan of user_entries', async () => {
    const n = notDuplicateOf('e', { column: 's.user_id' }, 1_000_000);
    // The fragment is the production builder's constant text, not user input.
    const text = `EXPLAIN QUERY PLAN SELECT s.user_id, e.id FROM entries e JOIN subscriptions s ON s.feed_id = e.feed_id
        WHERE e.feed_id = 1 AND e.guid_hash IN ('x') AND ${n.sql}`;
    const { results } = await env.DB.prepare(text)
      .bind(...n.params)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join('\n');
    expect(plan).toMatch(
      /USING (COVERING )?INDEX entries_url_key \(url_key=\? AND published_at>\?\)/,
    );
    expect(plan).toMatch(
      /USING (COVERING )?INDEX entries_headline_key \(headline_key=\? AND published_at>\? AND published_at<\?\)/,
    );
    expect(plan).toMatch(
      /SEARCH ue USING (COVERING )?INDEX ue_entry \(entry_id=\? AND user_id=\?\)/,
    );
    expect(plan).not.toMatch(/SCAN (ue|d|user_entries)/);
  });

  it('deleting keyed entries (maintenance) removes their index rows too', async () => {
    const a = await seedFeed({ url: FEED_A });
    await fetchFeed(
      a,
      FEED_A,
      Array.from({ length: 10 }, (_, k) =>
        story({
          guid: `a${k}`,
          link: `https://n.example.com/s/${k}`,
          title: `Story number ${k} of the day`,
          ageH: k + 1,
        }),
      ),
    );
    expect(await count('entries', 'url_key IS NOT NULL AND headline_key IS NOT NULL')).toBe(10);
    await db.run(sql('DELETE FROM user_entries')); // measure the entries rows alone
    await db.run(sql('DELETE FROM embed_queue')); // (TID-067) a cascade would be counted in `changes`
    await db.run(sql('DELETE FROM image_queue')); // (TID-071) likewise
    const meta = await db.run(sql('DELETE FROM entries WHERE feed_id = ?', a));
    expect(meta.changes).toBe(10);
    // D1 bills each removed index row as a row written: 5 per entry (row, unique, entries_published,
    // 2 key indexes) instead of 3. The local simulator's meta does not report index deletes, so the
    // spec 9.4 figure is the rule, and this checks the delete leaves no key-index row behind.
    expect(meta.rows_written).toBeGreaterThanOrEqual(10);
    expect(await count('entries', 'url_key IS NOT NULL')).toBe(0);
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM entries INDEXED BY entries_url_key WHERE url_key IS NOT NULL',
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('first-fetch entries that are not linked get no keys and no index rows', async () => {
    const id = await seedFeed({ url: FEED_A, lastSuccessAt: null, state: 'pending' });
    const list = Array.from({ length: 30 }, (_, k) =>
      story({
        guid: `a${k}`,
        link: `https://n.example.com/s/${k}`,
        title: `Story number ${k} of the day`,
        ageH: k + 1,
      }),
    );
    const out = await fetchFeed(id, FEED_A, list);
    expect(await count('entries')).toBe(30);
    expect(await count('user_entries')).toBe(10);
    expect(await count('entries', 'url_key IS NOT NULL')).toBe(10);
    // + 10 embed_queue rows for the linked entries (TID-067).
    // + 10 image_queue rows (TID-071).
    expect(out.usage.rowsWritten).toBe(30 * 3 + 10 * 2 + 10 * 6 + 1 + 10 + 10);
  });
});

describe('AC7: nothing is lost when a duplicate is hidden', () => {
  it('the hidden copy stays in entries with its content, only the user link is skipped', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', title: 'Hidden copy with its own title here' }),
    ]);
    const { rows } = await db.all<{ title: string; summary: string | null }>(
      sql('SELECT title, summary FROM entries WHERE feed_id = ?', b),
    );
    expect(rows).toEqual([{ title: 'Hidden copy with its own title here', summary: 'About b1' }]);
    // A later fetch of B does not resurrect it (the guid is known).
    const again = await fetchFeed(b, FEED_B, [
      story({ guid: 'b1', title: 'Hidden copy with its own title here' }),
    ]);
    expect(again.newEntries).toBe(0);
    expect(await count('user_entries')).toBe(1);
  });

  it('a third feed with the same story is hidden too', async () => {
    const a = await seedFeed({ url: FEED_A });
    const b = await seedFeed({ url: FEED_B });
    const c = await seedFeed({ url: FEED_C });
    await fetchFeed(a, FEED_A, [story({ guid: 'a1' })]);
    await fetchFeed(b, FEED_B, [story({ guid: 'b1' })]);
    await fetchFeed(c, FEED_C, [story({ guid: 'c1' })]);
    expect(await count('user_entries')).toBe(1);
    expect(await count('entries')).toBe(3);
  });
});

describe('migration 0006 on a populated 0005 database', () => {
  it('keeps every row, adds NULL keys and the two partial indexes', async () => {
    const m6 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0006'));
    if (!m6) throw new Error('0006 migration not found');

    // Back to the 0005 shape, then fill it.
    await env.DB.exec('DROP INDEX entries_url_key');
    await env.DB.exec('DROP INDEX entries_headline_key');
    await env.DB.exec('ALTER TABLE entries DROP COLUMN url_key');
    await env.DB.exec('ALTER TABLE entries DROP COLUMN headline_key');
    const cols = (
      await env.DB.prepare('SELECT name FROM pragma_table_info(?)')
        .bind('entries')
        .all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols).not.toContain('url_key');

    const f = await seedFeed({ url: FEED_A, subscribers: ['u1', 'u2'] });
    const stmts = [];
    for (let i = 1; i <= 120; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO entries (id, feed_id, guid_hash, url, title, summary, content_html, published_at, fetched_at, purged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          i,
          f,
          `g${i}`,
          `https://n.example.com/${i}`,
          `Old story number ${i} here`,
          `s${i}`,
          i % 10 === 0 ? null : `<p>${i}</p>`,
          1000 + i,
          2000 + i,
          i % 10 === 0 ? 3000 : null,
        ),
      );
      for (const u of ['u1', 'u2']) {
        stmts.push(
          env.DB.prepare(
            'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, is_starred, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).bind(
            u,
            i,
            f,
            1000 + i,
            i % 3 === 0 ? 1 : 0,
            i % 7 === 0 ? 1 : 0,
            i % 3 === 0 ? 5000 : null,
          ),
        );
      }
    }
    await env.DB.batch(stmts);
    const snapshot = async () => ({
      entries: JSON.stringify(
        (await env.DB.prepare('SELECT * FROM entries ORDER BY id').all()).results,
      ),
      ue: JSON.stringify(
        (await env.DB.prepare('SELECT * FROM user_entries ORDER BY user_id, entry_id').all())
          .results,
      ),
    });
    const before = await snapshot();

    await applyD1Migrations(env.DB, [{ name: '0006_rerun', queries: m6.queries }]);

    const after = await env.DB.prepare('SELECT * FROM entries ORDER BY id').all<
      Record<string, unknown>
    >();
    expect(after.results).toHaveLength(120);
    expect(after.results.every((r) => r.url_key === null && r.headline_key === null)).toBe(true);
    const stripped = after.results.map((r) => {
      const rest = { ...r };
      delete rest.url_key;
      delete rest.headline_key;
      return rest;
    });
    expect(JSON.stringify(stripped)).toBe(before.entries);
    expect((await snapshot()).ue).toBe(before.ue);

    const idx = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE name IN ('entries_url_key','entries_headline_key') ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(idx.results.map((r) => r.name)).toEqual(['entries_headline_key', 'entries_url_key']);
    for (const r of idx.results) expect(r.sql).toMatch(/WHERE \w+ IS NOT NULL/);

    // Old rows have no keys, so they never match; new ones work immediately (no backfill, ADR 0017).
    await fetchFeed(f, FEED_A, [
      story({ guid: 'new1', link: 'https://n.example.com/5', title: 'Old story number 5 here' }),
    ]);
    expect(await count('entries', 'url_key IS NOT NULL')).toBe(1);
    expect(await count('user_entries')).toBe(240 + 2);
  });
});
