import { beforeEach, describe, expect, it } from 'vitest';
import { feedErrorMessage, isFeedErrorCode } from '@tidings/shared';
import { generatedFeed } from '../../../e2e/fixtures/generate-feeds';
import { sql } from '../src/db';
import { PARKED_AT, refreshFeed } from '../src/refresh';
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

// TID-012 AC2 to AC9, AC11, AC14, AC15 and the too_large / too_deep / blocked_address outcomes,
// against a real (local) D1 in workerd with a fake fetch and a fixed clock. No real network.

let fx: Fixture;
const NOW = () => Math.floor(fx.clock.now() / 1000);

beforeEach(async () => {
  await resetData();
  fx = createFixture();
});

async function refresh(feedId: number) {
  return refreshFeed(await jobFor(feedId), fx.deps);
}

describe('success path (AC4) and write budget (spec 9.4, 9.5)', () => {
  it('inserts only the 3 new items, links each subscriber, updates validators', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1', 'u2'] });
    const feed = fx.fake.serveFeed(FEED_URL, rss(items(4, 50)), { etag: '"v1"' });

    const first = await refresh(id);
    expect(first.result).toBe('updated');
    expect(first.newEntries).toBe(47);
    expect(await count('entries', 'feed_id = ?', id)).toBe(47);

    feed.update(rss(items(1, 50)), '"v2"');
    const second = await refresh(id);

    expect(second.result).toBe('updated');
    expect(second.newEntries).toBe(3);
    expect(await count('entries', 'feed_id = ?', id)).toBe(50);
    // 47 + 3 per subscriber.
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(50);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(50);

    const row = await feedRow(id);
    expect(row).toMatchObject({
      etag: '"v2"',
      state: 'ok',
      error_count: 0,
      last_error_code: null,
      last_status: 200,
      last_success_at: NOW(),
      last_new_entry_at: NOW(),
      title: 'Test feed',
      site_url: 'https://site.example.com/',
      next_fetch_at: NOW() + 1800,
    });
    expect(row.body_hash).toMatch(/^[0-9a-f]{64}$/);

    // AC4: rows_written <= 3 x 3 + 3 x 6 x subscribers + 1.
    const subscribers = 2;
    // 49: 6 per user_entries since TID-021 (ue_entry); 4 per entry since TID-061 (entries_url_key; these
    // titles have under 4 words, so no entries_headline_key row).
    // TID-067: 1 more row per linked new entry (embed_queue), once per entry however many subscribers.
    // TID-071: + 1 image_queue row per new linked entry that has a link and no feed image.
    expect(second.usage.rowsWritten).toBe(3 * 4 + 3 * 6 * subscribers + 1 + 3 + 3);
    // Reads, measured (spec 9.5 budgets "<= 50 per changed fetch" for dedup): D1 counts every key
    // of an IN list (50) plus every hit (47), so dedup costs 97, not 47. Whole refresh: 121
    // (1 probe + 97 dedup + 3 insert checks + 18 link + 2 feed update). The bound is the worst case
    // of 50 keys all known: 1 + 100 + 9 + 18 + 2, with headroom for the link join.
    // TID-061 adds the duplicate probe: 3 reads per new entry and subscriber (index row, 3 x 2 = 18).
    expect(second.usage.rowsRead).toBe(121 + 18 + 12 + 12); // + 4 per new entry for each queue insert (embed_queue, TID-067; image_queue, TID-071)
    expect(second.usage.rowsRead).toBeLessThanOrEqual(
      1 + 2 * 50 + 9 + 3 * 3 * subscribers + 2 + 10 + 3 * subscribers * 6 + 3 * 4 + 3 * 4,
    );
    // Well inside the D1 limit of 50 queries per invocation (spec 7.3).
    expect(second.usage.statements).toBeLessThanOrEqual(15);
  });

  it('matches the per-event write numbers in spec 9.4 (entries 3, user_entries 6, state 1)', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1', 'u2', 'u3'] });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 4)));
    const out = await refresh(id);
    // 4 new entries x 4 rows (3 + entries_url_key, ADR 0017), 4 x 3 subscribers x 6 rows, 1 feeds update.
    // TID-067: + 4 embed_queue rows (one per new linked entry).
    // TID-071: + 4 image_queue rows.
    expect(out.usage.rowsWritten).toBe(4 * 4 + 4 * 3 * 6 + 1 + 4 + 4);
  });

  it('a feed with 50 items stays at or under 15 statements', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 60))); // parser stops at 50
    const out = await refresh(id);
    expect(out.newEntries).toBe(50);
    expect(out.usage.statements).toBeLessThanOrEqual(15);
  });

  it('a first-ever fetch links only the newest 10 items to the subscriber (FR-SU-3)', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'pending', lastSuccessAt: null });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 30)));
    const out = await refresh(id);
    expect(out.newEntries).toBe(30);
    expect(await count('entries', 'feed_id = ?', id)).toBe(30);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(10);
    // The linked ones are the newest (g1 is the newest).
    const { rows } = await db.all<{
      linked: number;
      oldest_linked: number;
      newest_unlinked: number;
    }>(
      sql(
        `SELECT (SELECT COUNT(*) FROM user_entries) AS linked,
                (SELECT MIN(published_at) FROM user_entries) AS oldest_linked,
                (SELECT MAX(published_at) FROM entries
                  WHERE id NOT IN (SELECT entry_id FROM user_entries)) AS newest_unlinked`,
      ),
    );
    expect(rows[0]?.linked).toBe(10);
    expect(rows[0]?.oldest_linked).toBeGreaterThan(rows[0]?.newest_unlinked ?? Infinity);
    const row = await feedRow(id);
    expect(row.state).toBe('ok');
    expect(row.last_success_at).toBe(NOW());
  });

  it('writes the feed row but no entries when the body changed without new items', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const feed = fx.fake.serveFeed(FEED_URL, rss(items(1, 5)));
    await refresh(id);
    feed.update(rss(items(1, 5), 'Renamed feed'), '"v2"');
    const out = await refresh(id);
    expect(out.result).toBe('updated');
    expect(out.newEntries).toBe(0);
    expect(out.usage.rowsWritten).toBe(1);
    expect((await feedRow(id)).title).toBe('Renamed feed');
  });

  it('decodes the declared charset', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const xml = rss([{ guid: 'x1', title: 'Café' }]).replace('UTF-8', 'ISO-8859-1');
    const bytes = Uint8Array.from(xml, (c) => c.charCodeAt(0)); // latin1: e-acute is 0xE9
    fx.fake.route(FEED_URL, { status: 200, body: bytes });
    await refresh(id);
    const { rows } = await db.all<{ title: string }>(
      sql('SELECT title FROM entries WHERE feed_id = ?', id),
    );
    expect(rows[0]?.title).toBe('Café');
  });
});

describe('unchanged content (AC2, AC3)', () => {
  it('AC2: a 304 on a healthy feed writes nothing', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 3)));
    await refresh(id); // stores etag + hash
    const before = await feedRow(id);

    const out = await refresh(id);

    expect(fx.fake.calls.at(-1)?.headers.get('if-none-match')).toBe(before.etag);
    expect(out.result).toBe('unchanged');
    expect(out.usage.rowsWritten).toBe(0);
    expect(await feedRow(id)).toEqual(before);
  });

  it('AC2: a 304 on an unhealthy feed writes one row that restores ok', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'failing', errorCount: 4, etag: '"v1"' });
    await db.run(
      sql("UPDATE feeds SET last_error_code = 'http_500', last_status = 500 WHERE id = ?", id),
    );
    fx.fake.serveFeed(FEED_URL, rss(items(1, 3)), { etag: '"v1"' });

    const out = await refresh(id);

    expect(out.result).toBe('unchanged');
    expect(out.usage.rowsWritten).toBe(1);
    expect(await feedRow(id)).toMatchObject({
      state: 'ok',
      error_count: 0,
      last_error_code: null,
      last_success_at: NOW(),
    });
  });

  it('AC3: a byte-identical 200 is not parsed and writes nothing', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const xml = rss(items(1, 3));
    // A server with no conditional GET support: always 200 with the same bytes.
    fx.fake.route(FEED_URL, {
      status: 200,
      body: xml,
      headers: { 'Content-Type': 'application/xml' },
    });
    await refresh(id);
    const before = await feedRow(id);

    const out = await refresh(id);

    expect(out.result).toBe('unchanged');
    expect(out.usage.rowsWritten).toBe(0);
    // Only the subscriber probe ran: no dedup lookup means parse and dedup never happened.
    expect(out.usage.statements).toBe(1);
    expect(out.usage.rowsRead).toBeLessThanOrEqual(1);
    expect(await feedRow(id)).toEqual(before);
  });
});

describe('failures and backoff (AC5 to AC8)', () => {
  it('AC5: three 500s give error_count 3, failing, and 1800 x 2^3 seconds +-10%', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 500, body: 'oops' });
    for (let n = 1; n <= 3; n++) {
      const out = await refresh(id);
      expect(out).toMatchObject({ result: 'failed', errorCode: 'http_500' });
      expect((await feedRow(id)).error_count).toBe(n);
    }
    const row = await feedRow(id);
    expect(row).toMatchObject({ state: 'failing', last_error_code: 'http_500', last_status: 500 });
    const delay = row.next_fetch_at - NOW();
    expect(delay).toBeGreaterThanOrEqual(14_400 * 0.9);
    expect(delay).toBeLessThanOrEqual(14_400 * 1.1);
  });

  it('AC6: 429 with Retry-After 7200 schedules exactly now + 7200', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 429, retryAfter: 7200 });
    await refresh(id);
    const row = await feedRow(id);
    expect(row.next_fetch_at).toBe(NOW() + 7200);
    expect(row).toMatchObject({ state: 'failing', error_count: 1, last_error_code: 'http_429' });
  });

  it('AC6: Retry-After as an HTTP date, clamped to [1800, 86400]; ignored on a plain 500', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(
      FEED_URL,
      { status: 503, retryAfter: new Date(fx.clock.now() + 3_600_000).toUTCString() },
      { times: 1 },
    );
    await refresh(id);
    expect((await feedRow(id)).next_fetch_at).toBe(NOW() + 3600);

    fx.fake.route(FEED_URL, { status: 429, retryAfter: 5 }, { times: 1 });
    await refresh(id);
    expect((await feedRow(id)).next_fetch_at).toBe(NOW() + 1800);

    fx.fake.route(FEED_URL, { status: 429, retryAfter: 999_999 }, { times: 1 });
    await refresh(id);
    expect((await feedRow(id)).next_fetch_at).toBe(NOW() + 86_400);

    fx.fake.route(FEED_URL, { status: 500, retryAfter: 7200 }, { times: 1 });
    await refresh(id);
    // 4th failure, no Retry-After for 500: 1800 x 2^4 = 28,800.
    expect((await feedRow(id)).next_fetch_at).toBe(NOW() + 28_800);
  });

  it('AC7: 410 marks the feed gone and parks it', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 410 });
    const out = await refresh(id);
    expect(out).toMatchObject({ result: 'failed', errorCode: 'http_410' });
    expect(await feedRow(id)).toMatchObject({
      state: 'gone',
      last_error_code: 'http_410',
      next_fetch_at: PARKED_AT,
    });
  });

  it('AC8: the 20th consecutive failure makes the feed dead, and later failures retry daily', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'failing', errorCount: 19 });
    fx.fake.route(FEED_URL, { status: 500 });
    await refresh(id);
    expect(await feedRow(id)).toMatchObject({
      state: 'dead',
      error_count: 20,
      next_fetch_at: NOW() + 86_400,
    });
    await refresh(id);
    expect(await feedRow(id)).toMatchObject({
      state: 'dead',
      error_count: 21,
      next_fetch_at: NOW() + 86_400,
    });
  });

  it('a success after failures returns the feed to ok', async () => {
    const id = await seedFeed({ url: FEED_URL, state: 'dead', errorCount: 25 });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 2)));
    await refresh(id);
    expect(await feedRow(id)).toMatchObject({ state: 'ok', error_count: 0, last_error_code: null });
  });

  it('404, 401 and 403 back off like any failure (some recover)', async () => {
    for (const status of [404, 401, 403]) {
      await resetData();
      const id = await seedFeed({ url: FEED_URL });
      fx.fake.reset();
      fx.fake.route(FEED_URL, { status });
      await refresh(id);
      expect(await feedRow(id)).toMatchObject({
        state: 'failing',
        error_count: 1,
        last_error_code: `http_${status}`,
        last_status: status,
        next_fetch_at: NOW() + 3600,
      });
    }
  });

  it('network errors, parse errors and blocked addresses are recorded with fixed codes', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { error: new Error('connection reset') }, { times: 1 });
    expect(await refresh(id)).toMatchObject({ result: 'failed', errorCode: 'network_error' });

    fx.fake.route(
      FEED_URL,
      { status: 200, body: '<html><body>not a feed</body></html>' },
      { times: 1 },
    );
    expect(await refresh(id)).toMatchObject({ result: 'failed', errorCode: 'parse_error' });

    const blocked = await seedFeed({ url: 'http://127.0.0.1/feed.xml' });
    const callsBefore = fx.fake.calls.length;
    expect(await refresh(blocked)).toMatchObject({
      result: 'failed',
      errorCode: 'blocked_address',
    });
    expect(fx.fake.calls.length).toBe(callsBefore); // refused before any fetch
    expect(await feedRow(blocked)).toMatchObject({ state: 'failing', error_count: 1 });
  });

  it('too_large: a feed over 1 MiB is rejected while streaming and never parsed', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { status: 200, body: generatedFeed('rss-huge') }); // ~3 MB
    const out = await refresh(id);
    expect(out).toMatchObject({ result: 'failed', errorCode: 'too_large' });
    expect(await feedRow(id)).toMatchObject({ state: 'failing', last_error_code: 'too_large' });
    expect(await count('entries')).toBe(0);
  });
});

describe('redirects (AC9, AC14)', () => {
  const NEW_URL = 'https://new.example.com/feed.xml';

  it('AC9: a 301 to a new URL no other feed uses updates feeds.url on success', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { redirectTo: NEW_URL, status: 301 });
    fx.fake.serveFeed(NEW_URL, rss(items(1, 2)));
    const out = await refresh(id);
    expect(out.result).toBe('updated');
    expect((await feedRow(id)).url).toBe(NEW_URL);
  });

  it('AC9: 308 then 301 chains update too; a 302 anywhere in the chain does not', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { redirectTo: 'https://mid.example.com/f', status: 308 });
    fx.fake.route('https://mid.example.com/f', { redirectTo: NEW_URL, status: 301 });
    fx.fake.serveFeed(NEW_URL, rss(items(1, 2)));
    await refresh(id);
    expect((await feedRow(id)).url).toBe(NEW_URL);

    const id2 = await seedFeed({ url: 'https://temp.example.com/a.xml' });
    fx.fake.route('https://temp.example.com/a.xml', {
      redirectTo: 'https://tmp2.example.com/a.xml',
      status: 302,
    });
    fx.fake.serveFeed('https://tmp2.example.com/a.xml', rss(items(1, 2)));
    await refresh(id2);
    expect((await feedRow(id2)).url).toBe('https://temp.example.com/a.xml');
  });

  it('AC9: keeps the old URL when another feed already has the target', async () => {
    const id = await seedFeed({ url: FEED_URL });
    await seedFeed({ url: NEW_URL });
    fx.fake.route(FEED_URL, { redirectTo: NEW_URL, status: 301 });
    fx.fake.serveFeed(NEW_URL, rss(items(1, 2)));
    const out = await refresh(id);
    expect(out.result).toBe('updated'); // the refresh itself succeeds
    expect((await feedRow(id)).url).toBe(FEED_URL);
  });

  it('AC9: the URL also updates when the redirect target answers 304', async () => {
    const id = await seedFeed({ url: FEED_URL, etag: '"v1"' });
    fx.fake.route(FEED_URL, { redirectTo: NEW_URL, status: 301 });
    fx.fake.serveFeed(NEW_URL, rss(items(1, 2)), { etag: '"v1"' });
    const out = await refresh(id);
    expect(out.result).toBe('unchanged');
    expect((await feedRow(id)).url).toBe(NEW_URL);
  });

  it('AC14: relative item links resolve against the final URL after redirects', async () => {
    const id = await seedFeed({ url: FEED_URL });
    fx.fake.route(FEED_URL, { redirectTo: 'https://cdn.example.com/dir/feed.xml', status: 302 });
    fx.fake.serveFeed(
      'https://cdn.example.com/dir/feed.xml',
      rss([
        { guid: 'r1', link: 'posts/1' },
        { guid: 'r2', link: '/abs/2' },
      ]),
    );
    await refresh(id);
    const { rows } = await db.all<{ url: string }>(
      sql('SELECT url FROM entries WHERE feed_id = ? ORDER BY id', id),
    );
    expect(rows.map((r) => r.url).sort()).toEqual([
      'https://cdn.example.com/abs/2',
      'https://cdn.example.com/dir/posts/1',
    ]);
  });

  it('AC14: a too_deep parse is stored as normal and logs exactly one structured warning', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const deep = '<x>'.repeat(80) + 'y' + '</x>'.repeat(80);
    const xml = rss(items(1, 2)).replace(
      '</channel>',
      `<item><title>deep</title><guid>deep1</guid><description>${deep}</description></item></channel>`,
    );
    fx.fake.route(FEED_URL, { status: 200, body: xml });
    const out = await refresh(id);
    expect(out.result).toBe('updated');
    expect(out.newEntries).toBe(2);
    expect(await count('entries', 'feed_id = ?', id)).toBe(2);
    expect(await feedRow(id)).toMatchObject({ state: 'ok', error_count: 0 });
    const warnings = fx.logs.filter((l) => l.event === 'feed_parse_too_deep');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({ feedId: id, maxDepth: 64 });
  });
});

describe('no oracle (AC15)', () => {
  const MARK = 'ZZ-SECRET-MARKER';

  it('stores and returns only fixed codes, never origin text', async () => {
    const id = await seedFeed({ url: FEED_URL });
    const outcomes: unknown[] = [];

    const origin500 = () =>
      new Response(`${MARK}-body`, {
        status: 500,
        statusText: `${MARK}-statustext`,
        headers: {
          'X-Leak': `${MARK}-header`,
          Server: `${MARK}-server`,
          'Set-Cookie': `${MARK}=1`,
        },
      });
    fx.fake.route(FEED_URL, origin500, { times: 1 });
    outcomes.push(await refresh(id));

    fx.fake.route(
      FEED_URL,
      { redirectTo: `http://127.0.0.1/${MARK}-location`, status: 301 },
      { times: 1 },
    );
    outcomes.push(await refresh(id));

    fx.fake.route(
      FEED_URL,
      { redirectTo: `https://other.example.com/${MARK}-location`, status: 301 },
      { times: 1 },
    );
    fx.fake.route(
      (u) => u.hostname === 'other.example.com',
      () => origin500(),
      { times: 1 },
    );
    outcomes.push(await refresh(id));

    fx.fake.route(FEED_URL, { error: new Error(`${MARK}-exception`) }, { times: 1 });
    outcomes.push(await refresh(id));

    fx.fake.route(FEED_URL, { status: 200, body: `<html>${MARK}-html</html>` }, { times: 1 });
    outcomes.push(await refresh(id));

    fx.fake.route(FEED_URL, { status: 429, retryAfter: `${MARK}-retry` }, { times: 1 });
    outcomes.push(await refresh(id));

    const row = await feedRow(id);
    const { last_status, ...rest } = row;
    expect(typeof last_status === 'number' || last_status === null).toBe(true);
    expect(JSON.stringify(rest)).not.toContain(MARK);
    expect(JSON.stringify(outcomes)).not.toContain(MARK);
    expect(JSON.stringify(fx.logs)).not.toContain(MARK);

    // last_error_code is from the fixed set and its message comes from the fixed table.
    expect(isFeedErrorCode(row.last_error_code)).toBe(true);
    for (const o of outcomes as { errorCode: string | null }[]) {
      expect(isFeedErrorCode(o.errorCode)).toBe(true);
      expect(feedErrorMessage(o.errorCode)).not.toContain(MARK);
    }
    expect(feedErrorMessage(row.last_error_code)).toMatch(/^[A-Za-z0-9 ,.'()]+$/);
  });
});

describe('unsubscribed feeds (AC11)', () => {
  it('a feed with no subscriptions is parked instead of fetched', async () => {
    const id = await seedFeed({ url: FEED_URL, subscribers: [] });
    fx.fake.serveFeed(FEED_URL, rss(items(1, 3)));
    const out = await refresh(id);
    expect(out.result).toBe('parked');
    expect(fx.fake.calls).toHaveLength(0);
    expect((await feedRow(id)).next_fetch_at).toBe(PARKED_AT);
    expect(await count('entries')).toBe(0);
  });
});
