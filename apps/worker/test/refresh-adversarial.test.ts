import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { feedErrorMessage, isFeedErrorCode } from '@tidings/shared';
import { sql } from '../src/db';
import { PARKED_AT, refreshFeed, runDispatcher } from '../src/refresh';
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
} from './support/refresh-harness';

// TID-012 adversarial and budget tests (tester). Local D1 `meta` supplies rows read and written.
// No real network: every origin is the fake fetch.

let fx: Fixture;
const NOW = () => Math.floor(fx.clock.now() / 1000);

beforeEach(async () => {
  await resetData();
  fx = createFixture();
});

async function refresh(feedId: number) {
  return refreshFeed(await jobFor(feedId), fx.deps);
}

describe('concurrency', () => {
  it('the same feed refreshed twice at once (overlapping lease) stores each item once', async () => {
    const id = await seedFeed({
      url: FEED_URL,
      subscribers: ['u1', 'u2'],
      lastSuccessAt: null,
    });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 20)));
    const job = await jobFor(id);
    const [a, b] = await Promise.all([refreshFeed(job, fx.deps), refreshFeed(job, fx.deps)]);
    expect([a.result, b.result]).toEqual(['updated', 'updated']);
    expect(await count('entries', 'feed_id = ?', id)).toBe(20);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(10); // first fetch links 10
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(10);
  });

  it('a lease that expires mid-flight lets a second dispatcher take the same feed; no duplicates result', async () => {
    const id = await seedFeed({ url: FEED_URL, nextFetchAt: 0 });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 5)));
    const seen: number[] = [];
    const run = (t: number) =>
      runDispatcher({
        db,
        clock: () => t,
        random: () => 0.5,
        refresh: async (j) => {
          seen.push(j.feedId);
          return refreshFeed(j, fx.deps);
        },
      });
    const t0 = fx.clock.now();
    await Promise.all([run(t0), run(t0 + 1801 * 1000)]);
    expect(seen).toEqual([id, id]);
    expect(await count('entries', 'feed_id = ?', id)).toBe(5);
    expect(await count('user_entries')).toBe(5);
  });

  it('a feed deleted mid-refresh never leaves orphans and the dispatcher survives', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, async () => {
      await db.run(sql('DELETE FROM subscriptions WHERE feed_id = ?', id));
      await db.run(sql('DELETE FROM feeds WHERE id = ?', id));
      return { status: 200, body: rss(items(1, 3)) };
    });
    const outcome = await refresh(id).then(
      (o) => o,
      () => 'rejected' as const,
    );
    expect(['rejected', 'updated', 'failed']).toContain(
      typeof outcome === 'string' ? outcome : outcome.result,
    );
    expect(await count('entries', 'feed_id = ?', id)).toBe(0);
    expect(await count('user_entries', 'feed_id = ?', id)).toBe(0);
  });

  it('a subscriber removed mid-refresh gets no user_entries; the other still does', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1', 'u2'] });
    fx.fake.route(FEED_URL, async () => {
      await db.run(sql('DELETE FROM subscriptions WHERE user_id = ? AND feed_id = ?', 'u2', id));
      return { status: 200, body: rss(items(1, 3)) };
    });
    const out = await refresh(id);
    expect(out.result).toBe('updated');
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(3);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(0);
  });
});

describe('duplicates', () => {
  it('duplicate guids inside one fetch store one entry (first wins)', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, {
      status: 200,
      body: rss([
        { guid: 'dup', title: 'First' },
        { guid: 'dup', title: 'Second' },
        { guid: 'other' },
      ]),
    });
    const out = await refresh(id);
    expect(out.newEntries).toBe(2);
    const { rows } = await db.all<{ title: string }>(
      sql(
        "SELECT title FROM entries WHERE feed_id = ? AND title LIKE 'First' OR title LIKE 'Second'",
        id,
      ),
    );
    expect(rows.map((r) => r.title)).toEqual(['First']);
  });

  it('the same guid in two feeds is stored per feed (an item can move between feeds)', async () => {
    const a = await seedFeed({ url: FEED_URL });
    const b = await seedFeed({ url: 'https://feed.example.com/other.xml' });
    fx.fake.route(FEED_URL, { status: 200, body: rss([{ guid: 'moved' }]) });
    fx.fake.route('https://feed.example.com/other.xml', {
      status: 200,
      body: rss([{ guid: 'moved' }]),
    });
    expect((await refresh(a)).newEntries).toBe(1);
    expect((await refresh(b)).newEntries).toBe(1);
    expect(await count('entries')).toBe(2);
  });

  it('CHARACTERISATION: a feed whose guids change every fetch adds 50 entries and about 401 rows each time', async () => {
    const id = await seedFeed({ url: FEED_URL });
    let written = 0;
    for (let n = 0; n < 4; n++) {
      fx.fake.route(FEED_URL, {
        status: 200,
        body: rss(Array.from({ length: 50 }, (_, k) => ({ guid: `churn-${n}-${k}` }))),
      });
      const out = await refresh(id);
      expect(out.newEntries).toBe(50);
      if (n > 0) written = out.usage.rowsWritten;
    }
    expect(written).toBe(50 * 3 + 50 * 5 + 1); // 401 per fetch, 48 fetches/day = 19,248 rows/day
    expect(await count('entries', 'feed_id = ?', id)).toBe(200); // nothing caps growth (DEF-013)
  });
});

describe('hostile and broken responses', () => {
  it.each([
    ['999999999', 86400],
    ['0', 1800],
    ['-5', null],
    ['99999999999999', null],
    ['not a date', null],
  ])('Retry-After %j on a 429 is clamped or ignored', async (value, expected) => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 429, retryAfter: value });
    await refresh(id);
    const row = await feedRow(id);
    if (expected !== null) expect(row.next_fetch_at).toBe(NOW() + expected);
    else expect(row.next_fetch_at).toBe(NOW() + 3600); // plain backoff, 1800 x 2^1
  });

  it(
    'a 304 for a feed that has never been fetched does not claim success (DEF-014)',
    async () => {
      const id = await seedFeed({ url: FEED_URL, state: 'pending', lastSuccessAt: null });
      fx.fake.route(FEED_URL, { status: 304 });
      await refresh(id);
      const row = await feedRow(id);
      expect(row.last_success_at).toBeNull();
    },
  );

  it('a 304 with no validators sent is http_304 with backoff and the feed is failing', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'pending', lastSuccessAt: null });
    fx.fake.route(FEED_URL, { status: 304 });
    const out = await refresh(id);
    expect(out).toMatchObject({ result: 'failed', errorCode: 'http_304' });
    const row = await feedRow(id);
    expect(row.state).toBe('failing');
    expect(row.error_count).toBe(1);
    expect(row.last_error_code).toBe('http_304');
    expect(row.next_fetch_at).toBeGreaterThan(NOW());
    expect(feedErrorMessage('http_304')).toBe('The server returned 304 Not Modified');
  });

  it('a 304 after we sent an ETag is still a success', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 2)), { etag: '"v1"' });
    await refresh(id);
    fx.fake.route(FEED_URL, { status: 304 });
    expect((await refresh(id)).result).toBe('unchanged');
  });

  it('a very long ETag round-trips and does not wedge the feed', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const etag = `"${'e'.repeat(7000)}"`;
    fx.fake.serveFeed(FEED_URL, rss(items(1, 2)), { etag });
    expect((await refresh(id)).result).toBe('updated');
    expect((await refresh(id)).result).toBe('unchanged');
  });

  it('a redirect loop is too_many_redirects and never updates the URL', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { redirectTo: 'https://b.example.com/f', status: 301 });
    fx.fake.route('https://b.example.com/f', { redirectTo: FEED_URL, status: 301 });
    const out = await refresh(id);
    expect(out.errorCode).toBe('too_many_redirects');
    expect((await feedRow(id)).url).toBe(FEED_URL);
  });

  it('two feeds that 301 to the same target: the first takes the URL, the second keeps its own', async () => {
    const a = await seedFeed({ url: FEED_URL });
    const b = await seedFeed({ url: 'https://feed.example.com/b.xml' });
    const target = 'https://new.example.com/f.xml';
    fx.fake.route(FEED_URL, { redirectTo: target, status: 301 });
    fx.fake.route('https://feed.example.com/b.xml', { redirectTo: target, status: 301 });
    fx.fake.serveFeed(target, rss(items(1, 2)));
    await refresh(a);
    expect((await refresh(b)).result).toBe('updated');
    expect((await feedRow(a)).url).toBe(target);
    expect((await feedRow(b)).url).toBe('https://feed.example.com/b.xml');
  });

  it.each([
    ['utf-16', 'application/xml; charset=utf-16'],
    ['an unknown label', 'application/xml; charset=no-such-charset'],
    ['replacement', 'application/xml; charset=replacement'],
  ])('a lying charset (%s) never throws and stores only fixed codes', async (_n, contentType) => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, {
      status: 200,
      headers: { 'Content-Type': contentType },
      body: rss([{ guid: 'c1', title: 'Café' }]),
    });
    const out = await refresh(id);
    expect(['updated', 'failed']).toContain(out.result);
    if (out.result === 'failed') expect(isFeedErrorCode(out.errorCode)).toBe(true);
  });

  it('an empty 200 body is parse_error with backoff', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: '' });
    const out = await refresh(id);
    expect(out.errorCode).toBe('parse_error');
    expect((await feedRow(id)).state).toBe('failing');
  });

  it('a valid feed with 0 items is a success that writes one row; the repeat writes none', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: rss([]) });
    const first = await refresh(id);
    expect(first.result).toBe('updated');
    expect(first.newEntries).toBe(0);
    expect(first.usage.rowsWritten).toBe(1);
    const second = await refresh(id);
    expect(second.result).toBe('unchanged');
    expect(second.usage.rowsWritten).toBe(0);
  });

  it('last_error_code is always from the fixed set across every status', async () => {
    const id = await seedFeed({ url: FEED_URL });
    for (const status of [400, 401, 403, 404, 408, 418, 429, 451, 500, 502, 503, 504, 599]) {
      fx.fake.route(FEED_URL, { status, body: 'ZZ-LEAK' }, { times: 1 });
      const out = await refresh(id);
      const row = await feedRow(id);
      expect(isFeedErrorCode(row.last_error_code)).toBe(true);
      expect(row.last_error_code).toBe(`http_${status}`);
      expect(feedErrorMessage(out.errorCode)).not.toContain('ZZ-LEAK');
    }
  });
});

describe('clock edges', () => {
  it('a feed due far in the past is leased; one due in the far future is not', async () => {
    const past = await seedFeed({ nextFetchAt: -1_000_000 });
    await seedFeed({ nextFetchAt: PARKED_AT - 1 });
    const seen: number[] = [];
    await runDispatcher({
      db,
      clock: () => fx.clock.now(),
      random: () => 0.5,
      refresh: async (j) => {
        seen.push(j.feedId);
        return refreshFeed(j, {
          ...fx.deps,
          fetch: async () => new Response(null, { status: 500 }),
        });
      },
    });
    expect(seen).toEqual([past]);
  });

  it.todo(
    'TID-013/014: resubscribing a parked or gone feed resets next_fetch_at to now (spec 7.1)',
  );
});

describe('write budget (spec 9.4)', () => {
  it('first fetch of a 50-item feed stores 50 entries but links 10: 201 rows, not the 81 in spec 9.8 (DEF-015)', async () => {
    const id = await seedFeed({ url: FEED_URL, lastSuccessAt: null, state: 'pending' });
    fx.fake.route(FEED_URL, { status: 200, body: rss(items(1, 50)) });
    const out = await refresh(id);
    expect(out.usage.rowsWritten).toBe(50 * 3 + 10 * 5 + 1);
  });

  it('a realistic mix writes only what spec 9.4 predicts', async () => {
    const ids: number[] = [];
    for (let n = 0; n < 30; n++)
      ids.push(await seedFeed({ url: `https://m${n}.example.com/f.xml` }));
    for (let n = 0; n < 30; n++) {
      const url = `https://m${n}.example.com/f.xml`;
      if (n < 20) fx.fake.serveFeed(url, rss(items(1, 10)), { etag: '"s"' });
      else if (n < 25) fx.fake.route(url, { status: 500 });
      else fx.fake.serveFeed(url, rss(items(1, 10)), { etag: '"c"' });
    }
    for (const id of ids) await refresh(id); // warm: everything is new once
    for (let n = 25; n < 30; n++) {
      fx.fake.serveFeed(`https://m${n}.example.com/f.xml`, rss(items(1, 12)), { etag: '"c2"' });
    }
    let written = 0;
    for (const id of ids) written += (await refresh(id)).usage.rowsWritten;
    // 20 unchanged (0), 5 failing (1 each), 5 changed with 2 new items (2x3 + 2x5 + 1 = 17).
    expect(written).toBe(5 + 5 * 17);
  });

  it('a near-1 MiB feed with 50 large items still writes in one batch under 15 statements', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const big = 'x'.repeat(19_000);
    const body = rss(
      Array.from({ length: 50 }, (_, k) => ({ guid: `big${k}`, title: `T${k}` })),
    ).replace(
      /<description>About (big\d+)<\/description>/g,
      `<description>$1 ${big}</description>`,
    );
    expect(body.length).toBeLessThan(1_048_576);
    fx.fake.route(FEED_URL, { status: 200, body });
    const out = await refresh(id);
    expect(out.result).toBe('updated');
    expect(out.usage.statements).toBeLessThanOrEqual(15);
    void env;
  });
});
