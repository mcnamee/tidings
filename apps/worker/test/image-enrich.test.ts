import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, type FakeFetch } from '@tidings/test-utils';
import { sql } from '../src/db';
import {
  DAILY_PAGE_CAP,
  MAX_AGE_SECONDS,
  MAX_REDIRECTS,
  PAGES_PER_HOST,
  PAGES_PER_RUN,
  runEnrichImages,
  type EnrichDeps,
} from '../src/images/enrich';
import { MAX_PAGE_BYTES } from '../src/images/extract';
import { ImageEnricher } from '../src/images/entrypoint';
import { handleScheduled } from '../src/refresh';
import { refreshFeed } from '../src/refresh';
import migration from '../migrations/0009_image_queue.sql?raw';
import {
  count,
  createFixture,
  db,
  jobFor,
  resetData,
  rss,
  seedFeed,
} from './support/refresh-harness';

// TID-071 (ADR 0019, spec 6.1, 7.3b, 9, 10.6) against local D1 with a fake fetch. No real network.
const NOW = 1_790_000_000;
const DAY = 86_400;
const APP = 'https://tidings.mcn.am';

let fake: FakeFetch;
let feedId = 0;
let n = 0;

const html = (og: string | null) =>
  `<!doctype html><html><head><title>t</title>${
    og ? `<meta property="og:image" content="${og}">` : ''
  }</head><body>x</body></html>`;
const page = (
  body: string,
  headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' },
) => ({
  headers,
  body,
});

const deps = (over: Partial<EnrichDeps> = {}): EnrichDeps => ({
  db,
  fetch: fake.fetch as EnrichDeps['fetch'],
  appOrigin: APP,
  clock: () => NOW * 1000,
  ...over,
});

interface Seed {
  url?: string | null;
  image?: string | null;
  read?: boolean;
  fetchedAt?: number;
  queued?: boolean;
}
/** An entry linked to u1 (unread unless `read`), queued by default. Returns its id. */
async function entry(o: Seed = {}): Promise<number> {
  n++;
  const url = o.url === undefined ? `https://site${n}.example.com/a/${n}` : o.url;
  await db.run(
    sql(
      `INSERT INTO entries (feed_id, guid_hash, url, title, image_url, published_at, fetched_at)
       VALUES (?, ?, ?, 't', ?, ?, ?)`,
      feedId,
      `h${n}`,
      url,
      o.image ?? null,
      NOW - 100,
      o.fetchedAt ?? NOW - 100,
    ),
  );
  const row = await db.first<{ id: number }>(sql('SELECT MAX(id) AS id FROM entries'));
  const id = (row as { id: number }).id;
  await db.run(
    sql(
      `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES ('u1', ?, ?, ?, ?)`,
      id,
      feedId,
      NOW - 100,
      o.read ? 1 : 0,
    ),
  );
  if (o.queued !== false) await db.run(sql('INSERT INTO image_queue (entry_id) VALUES (?)', id));
  return id;
}
const imageOf = async (id: number) =>
  (
    await db.first<{ image_url: string | null }>(
      sql('SELECT image_url FROM entries WHERE id = ?', id),
    )
  )?.image_url ?? null;
const queued = () => count('image_queue');
const urlOf = async (id: number) =>
  (await db.first<{ url: string }>(sql('SELECT url FROM entries WHERE id = ?', id)))!.url;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM image_queue');
  await env.DB.exec("DELETE FROM rate_limits WHERE key = 'img:pages'");
  await resetData();
  feedId = await seedFeed({ subscribers: ['u1'] });
  fake = createFakeFetch();
});

describe('enrichment', () => {
  it('stores the og:image, dequeues, and writes 2 rows per entry plus up to 2 counter rows per run', async () => {
    const ids = [await entry(), await entry(), await entry()];
    for (const [i, id] of ids.entries()) {
      fake.route(
        await urlOf(id),
        page(html(i === 2 ? '/rel/p.jpg' : `https://cdn.example.com/${i}.jpg`)),
      );
    }
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: 3, found: 3, missed: 0, skipped: 0, deferred: 0 });
    expect(await imageOf(ids[0]!)).toBe('https://cdn.example.com/0.jpg');
    expect(await imageOf(ids[2]!)).toBe(new URL('/rel/p.jpg', await urlOf(ids[2]!)).href);
    expect(await queued()).toBe(0);
    // 3 UPDATEs + 3 queue deletes + the counter upsert (measured: 2 rows, table + index, for a first
    // insert). With the queue insert at refresh that is 3 rows per entry, plus 2 per run.
    expect(out.rowsWritten).toBe(3 + 3 + 2);
  });

  it('sends only GET with the Tidings user agent, an HTML Accept header, and no cookies', async () => {
    const id = await entry();
    fake.route(await urlOf(id), page(html('https://cdn.example.com/a.jpg')));
    await runEnrichImages(deps());
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.headers.get('User-Agent')).toMatch(/^Tidings\//);
    expect(call.headers.get('Accept')).toMatch(/^text\/html/);
    expect(call.headers.get('Cookie')).toBeNull();
    expect(call.redirect).toBe('manual');
  });

  it('a page without an image, an HTTP error, a timeout and a non-HTML page are tried once and never again', async () => {
    const miss = await entry();
    const err = await entry();
    const slow = await entry();
    const pdf = await entry();
    fake.route(await urlOf(miss), page(html(null)));
    fake.route(await urlOf(err), { status: 503 });
    fake.route(await urlOf(slow), { error: new Error('connection reset') });
    fake.route(
      await urlOf(pdf),
      page(html('https://cdn.example.com/a.jpg'), { 'Content-Type': 'application/pdf' }),
    );
    const first = await runEnrichImages(deps());
    expect(first).toMatchObject({ fetched: 4, found: 0, missed: 4 });
    expect(await queued()).toBe(0);
    // 4 deletes + the counter upsert (2 rows), no entries UPDATE.
    expect(first.rowsWritten).toBe(4 + 2);
    const before = fake.calls.length;
    expect(await runEnrichImages(deps())).toMatchObject({ stopped: 'idle', fetched: 0 });
    expect(fake.calls.length).toBe(before);
    for (const id of [miss, err, slow, pdf]) expect(await imageOf(id)).toBeNull();
  });

  it('does not touch entries that already have an image, have no url, are read, or are too old', async () => {
    const has = await entry({ image: 'https://feed.example.com/own.jpg' });
    const noUrl = await entry({ url: null });
    const read = await entry({ read: true });
    const old = await entry({ fetchedAt: NOW - MAX_AGE_SECONDS - 10 });
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: 0, skipped: 4 });
    expect(fake.calls).toHaveLength(0);
    expect(await imageOf(has)).toBe('https://feed.example.com/own.jpg');
    for (const id of [noUrl, read, old]) expect(await imageOf(id)).toBeNull();
    expect(await queued()).toBe(0);
  });

  it('never overwrites an image that arrived between the read and the write', async () => {
    const id = await entry();
    fake.route(await urlOf(id), async () => {
      await db.run(
        sql("UPDATE entries SET image_url = 'https://feed.example.com/late.jpg' WHERE id = ?", id),
      );
      return page(html('https://cdn.example.com/a.jpg'));
    });
    await runEnrichImages(deps());
    expect(await imageOf(id)).toBe('https://feed.example.com/late.jpg');
  });

  it('cuts a huge page at 128 KB: reads no more of the stream and ignores a late og:image', async () => {
    const id = await entry();
    let pulled = 0;
    const chunk = new TextEncoder().encode('<!-- ' + 'x'.repeat(16 * 1024) + ' -->');
    fake.route(await urlOf(id), () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= 64) return c.close(); // 1 MB if read to the end
          sent++;
          pulled += chunk.byteLength;
          c.enqueue(chunk);
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/html' } });
    });
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: 1, found: 0 });
    expect(pulled).toBeLessThan(MAX_PAGE_BYTES + 3 * chunk.byteLength);
  });

  it('finds an og:image that sits inside the first 128 KB of a large page', async () => {
    const id = await entry();
    const big = html('https://cdn.example.com/in.jpg') + '<!-- ' + 'y'.repeat(900_000) + ' -->';
    fake.route(await urlOf(id), page(big));
    expect(await runEnrichImages(deps())).toMatchObject({ found: 1 });
    expect(await imageOf(id)).toBe('https://cdn.example.com/in.jpg');
  });

  it('uses the final URL after redirects as the base for relative image URLs', async () => {
    const id = await entry();
    fake.route(await urlOf(id), { redirectTo: 'https://www.final.example.com/news/story' });
    fake.route('https://www.final.example.com/news/story', page(html('thumb.jpg')));
    await runEnrichImages(deps());
    expect(await imageOf(id)).toBe('https://www.final.example.com/news/thumb.jpg');
  });
});

describe('limits', () => {
  it('fetches at most PAGES_PER_RUN pages per run and leaves the rest queued', async () => {
    const ids: number[] = [];
    for (let i = 0; i < PAGES_PER_RUN + 8; i++) ids.push(await entry());
    fake.route(/site\d+\.example\.com/, page(html('https://cdn.example.com/a.jpg')));
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: PAGES_PER_RUN, found: PAGES_PER_RUN, deferred: 8 });
    expect(fake.calls).toHaveLength(PAGES_PER_RUN);
    expect(await queued()).toBe(8);
    // Newest first; the next run takes the rest.
    expect(await imageOf(ids[ids.length - 1]!)).not.toBeNull();
    expect(await imageOf(ids[0]!)).toBeNull();
    expect(await runEnrichImages(deps())).toMatchObject({ fetched: 8 });
    expect(await queued()).toBe(0);
  });

  it('keeps the worst case under the 50-subrequest limit', () => {
    // Every page fetch may follow MAX_REDIRECTS redirects; a run also makes about 4 D1 calls.
    expect(PAGES_PER_RUN * (1 + MAX_REDIRECTS) + 4).toBeLessThan(50);
  });

  it('fetches at most PAGES_PER_HOST pages from one host per run, and still serves other hosts', async () => {
    for (let i = 0; i < 8; i++) await entry({ url: `https://busy.example.com/p/${i}` });
    for (let i = 0; i < 2; i++) await entry({ url: `https://quiet${i}.example.com/p` });
    fake.route(/example\.com/, page(html('https://cdn.example.com/a.jpg')));
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: PAGES_PER_HOST + 2, deferred: 8 - PAGES_PER_HOST });
    expect(fake.calls.filter((c) => c.url.startsWith('https://busy.example.com/'))).toHaveLength(
      PAGES_PER_HOST,
    );
    expect(await queued()).toBe(8 - PAGES_PER_HOST);
  });

  it('stops at the daily cap without touching the queue, and starts again the next UTC day', async () => {
    const id = await entry();
    const day = NOW - (NOW % DAY);
    await db.run(
      sql(
        "INSERT INTO rate_limits (key, window_start, count) VALUES ('img:pages', ?, ?)",
        day,
        DAILY_PAGE_CAP,
      ),
    );
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ stopped: 'daily_cap', fetched: 0, deferred: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(await queued()).toBe(1);

    fake.route(await urlOf(id), page(html('https://cdn.example.com/a.jpg')));
    const next = await runEnrichImages(deps({ clock: () => (day + DAY + 60) * 1000 }));
    expect(next).toMatchObject({ fetched: 1, found: 1 });
    const row = await db.first<{ count: number; window_start: number }>(
      sql("SELECT count, window_start FROM rate_limits WHERE key = 'img:pages'"),
    );
    expect(row).toEqual({ count: 1, window_start: day + DAY });
  });

  it('a run only spends what is left of the daily cap', async () => {
    for (let i = 0; i < 5; i++) await entry();
    const day = NOW - (NOW % DAY);
    await db.run(
      sql(
        "INSERT INTO rate_limits (key, window_start, count) VALUES ('img:pages', ?, ?)",
        day,
        DAILY_PAGE_CAP - 2,
      ),
    );
    fake.route(/site\d+\.example\.com/, page(html('https://cdn.example.com/a.jpg')));
    expect(await runEnrichImages(deps())).toMatchObject({ fetched: 2, deferred: 3 });
  });
});

describe('SSRF (spec 10.6)', () => {
  it('never fetches private, loopback, metadata or non-http page URLs, and still dequeues them', async () => {
    const urls = [
      'http://10.0.0.1/a',
      'http://127.0.0.1/a',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a',
      'http://localhost/a',
      'ftp://site.example.com/a',
      'javascript:alert(1)',
    ];
    for (const u of urls) await entry({ url: u });
    const out = await runEnrichImages(deps());
    expect(out.found).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(await queued()).toBe(0);
  });

  it('refuses a redirect to a private address after the first hop and records the page as tried', async () => {
    const id = await entry();
    fake.route(await urlOf(id), { redirectTo: 'http://169.254.169.254/latest/meta-data' });
    fake.route(/169\.254/, page(html('https://cdn.example.com/leak.jpg')));
    const out = await runEnrichImages(deps());
    expect(out).toMatchObject({ fetched: 1, found: 0, missed: 1 });
    expect(fake.calls.map((c) => c.url)).toEqual([await urlOf(id)]);
    expect(await queued()).toBe(0);
    expect(await imageOf(id)).toBeNull();
  });

  it('gives up after MAX_REDIRECTS redirects', async () => {
    const id = await entry();
    for (let i = 0; i < 6; i++) {
      fake.route(i === 0 ? await urlOf(id) : `https://hop${i}.example.com/`, {
        redirectTo: `https://hop${i + 1}.example.com/`,
      });
    }
    await runEnrichImages(deps());
    expect(fake.calls.length).toBeLessThanOrEqual(1 + MAX_REDIRECTS);
    expect(await imageOf(id)).toBeNull();
  });

  it('does not store a hostile image URL from the page', async () => {
    const ids = [await entry(), await entry(), await entry()];
    const bad = ['javascript:alert(1)', 'http://127.0.0.1/a.jpg', 'data:image/png;base64,AAAA'];
    for (const [i, id] of ids.entries()) fake.route(await urlOf(id), page(html(bad[i]!)));
    await runEnrichImages(deps());
    for (const id of ids) expect(await imageOf(id)).toBeNull();
  });
});

describe('queueing by the refresh', () => {
  it('queues new unread entries that have a link and no image, once, and never re-queues them', async () => {
    const f = createFixture();
    const id = await seedFeed({
      url: 'https://feed.example.com/rss.xml',
      subscribers: ['u1'],
      lastSuccessAt: 1,
    });
    const xml = rss([{ guid: 'a' }, { guid: 'b' }, { guid: 'c' }]).replace(
      '<guid isPermaLink="false">b</guid>',
      '<guid isPermaLink="false">b</guid><enclosure url="https://feed.example.com/b.jpg" type="image/jpeg" length="1"/>',
    );
    f.fake.serveFeed('https://feed.example.com/rss.xml', xml);
    await refreshFeed(await jobFor(id), f.deps);
    // a and c have no image; b has one from the feed.
    expect(await count('entries', 'feed_id = ?', id)).toBe(3);
    expect(await queued()).toBe(2);
    expect(
      await count('image_queue q JOIN entries e ON e.id = q.entry_id', 'e.image_url IS NOT NULL'),
    ).toBe(0);

    await env.DB.exec('DELETE FROM image_queue');
    f.fake.reset();
    f.fake.serveFeed('https://feed.example.com/rss.xml', xml, { etag: '"2"' });
    await refreshFeed(await jobFor(id), f.deps);
    expect(await queued()).toBe(0); // known entries are not queued again
  });

  it('does not queue entries linked as already read (older than 7 days on a first fetch)', async () => {
    const f = createFixture();
    const id = await seedFeed({
      url: 'https://feed.example.com/rss.xml',
      subscribers: ['u1'],
      lastSuccessAt: null,
    });
    f.fake.serveFeed(
      'https://feed.example.com/rss.xml',
      rss([
        { guid: 'new', ageH: 2 },
        { guid: 'old', ageH: 24 * 30 },
      ]),
    );
    await refreshFeed(await jobFor(id), f.deps);
    expect(await queued()).toBe(1);
  });

  it('queues nothing for an entry without a link', async () => {
    const f = createFixture();
    const id = await seedFeed({
      url: 'https://feed.example.com/rss.xml',
      subscribers: ['u1'],
      lastSuccessAt: 1,
    });
    const xml = rss([{ guid: 'nolink' }]).replace(
      /<link>https:\/\/site\.example\.com\/posts\/nolink<\/link>/,
      '',
    );
    f.fake.serveFeed('https://feed.example.com/rss.xml', xml);
    await refreshFeed(await jobFor(id), f.deps);
    expect(await count('entries', 'feed_id = ? AND url IS NULL', id)).toBe(1);
    expect(await queued()).toBe(0);
  });

  it('a deleted entry drops its queue row (cascade)', async () => {
    const id = await entry();
    await env.DB.exec('PRAGMA foreign_keys = ON');
    await db.run(sql('DELETE FROM user_entries WHERE entry_id = ?', id));
    await db.run(sql('DELETE FROM entries WHERE id = ?', id));
    expect(await queued()).toBe(0);
  });
});

describe('migration 0009 on a populated database', () => {
  // D1 `exec` runs one statement per line, so run the file's statements one by one.
  const statements = migration
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  it('creates the queue and backfills only recent unread entries with a link and no image', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.exec('DROP TABLE image_queue');
    const good = await entry({ queued: false, fetchedAt: nowS - 60 });
    await entry({ queued: false, fetchedAt: nowS - 4 * DAY }); // too old
    await entry({ queued: false, fetchedAt: nowS - 60, read: true });
    await entry({ queued: false, fetchedAt: nowS - 60, image: 'https://feed.example.com/i.jpg' });
    await entry({ queued: false, fetchedAt: nowS - 60, url: null });
    const before = await count('entries');
    for (const s of statements) await db.run(sql(s));
    const rows = (await db.all<{ entry_id: number }>(sql('SELECT entry_id FROM image_queue'))).rows;
    expect(rows).toEqual([{ entry_id: good }]);
    expect(await count('entries')).toBe(before); // no entry row is touched
  });

  it('caps the backfill at 300 rows, newest first', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.exec('DROP TABLE image_queue');
    const stmts: ReturnType<typeof sql>[] = [];
    for (let i = 0; i < 320; i++) {
      stmts.push(
        sql(
          `INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at)
           VALUES (?, ?, ?, ?, 't', ?, ?)`,
          10_000 + i,
          feedId,
          `bulk${i}`,
          `https://bulk.example.com/${i}`,
          nowS,
          nowS,
        ),
        sql(
          `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES ('u1', ?, ?, ?, 0)`,
          10_000 + i,
          feedId,
          nowS,
        ),
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    for (const s of statements) await db.run(sql(s));
    expect(await count('image_queue')).toBe(300);
    expect(await count('image_queue', 'entry_id < 10020')).toBe(0); // the 20 oldest are left out
  });
});

describe('dispatcher wiring', () => {
  const controller = () =>
    createScheduledController({ cron: '* * * * *', scheduledTime: NOW * 1000 });
  const run = (steps: { enrichPending: () => Promise<unknown> }) =>
    handleScheduled(
      controller(),
      env,
      createExecutionContext(),
      { refresh: async () => undefined as never },
      undefined,
      steps as never,
    );

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('calls the image step only when the queue has a row', async () => {
    const step = vi.fn(async () => null);
    await run({ enrichPending: step });
    expect(step).not.toHaveBeenCalled();
    await entry();
    await run({ enrichPending: step });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('a failing image step does not fail the scheduled run', async () => {
    await entry();
    await expect(
      run({
        enrichPending: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ImageEnricher entrypoint', () => {
  it('makes no fetch under a production origin with ALLOW_FETCH_HOSTS set (spec 10.6)', async () => {
    await entry({ fetchedAt: Math.floor(Date.now() / 1000) });
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prod = { ...env, APP_ORIGIN: APP, ALLOW_FETCH_HOSTS: '127.0.0.1:8790' };
    expect(
      await new ImageEnricher(createExecutionContext() as never, prod).enrichPending(),
    ).toBeNull();
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await queued()).toBe(1);
  });

  it('runs the step with the global fetch and never throws for a failing page', async () => {
    const fresh = Math.floor(Date.now() / 1000); // the entrypoint uses the real clock
    const id = await entry({ fetchedAt: fresh });
    const bad = await entry({ fetchedAt: fresh });
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u === (await urlOf(bad))) throw new Error('reset');
      return new Response(html('https://cdn.example.com/e.jpg'), {
        headers: { 'Content-Type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await new ImageEnricher(createExecutionContext() as never, env).enrichPending();
    vi.unstubAllGlobals();
    expect(out).toMatchObject({ fetched: 2, found: 1, missed: 1 });
    expect(await imageOf(id)).toBe('https://cdn.example.com/e.jpg');
    expect(await queued()).toBe(0);
  });
});
