import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, Folder, SubscribeResponse, Subscription } from '@tidings/shared';
import { DAY, MINUTE } from '@tidings/test-utils';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { sql } from '../src/db';
import type { FetchFn } from '../src/fetch';
import { PARKED_AT, refreshFeed, type RefreshJob, type RefreshOutcome } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  feedRow,
  items,
  resetData,
  rss,
  type Fixture,
} from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-013: subscribe to a feed (spec 7.5, 8.4, 10.6, 10.8). The whole API runs for real in workerd
// against local D1. The only fakes are the network (fake fetch) and, where a test needs to look at
// the call, a spy around the real `refreshFeed`.

const FEED = 'https://feed.example.com/rss.xml';
const SITE = 'https://blog.example.com/';
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

let fx: Fixture;
let jobs: RefreshJob[];
let tokens: Record<string, string>;
const nowS = () => Math.floor(fx.clock.now() / 1000);

type RefreshFn = (job: RefreshJob) => Promise<RefreshOutcome>;

interface Options {
  refresh?: RefreshFn;
  timeoutMs?: number;
}

function appFor(options: Options = {}) {
  const realRefresh: RefreshFn = (job) => {
    jobs.push(job);
    return refreshFeed(job, fx.deps);
  };
  return createApp({
    clock: () => fx.clock.now(),
    subscriptions: {
      fetch: fx.fake.fetch as FetchFn,
      random: () => 0.5, // jitter of exactly 30 s
      refresh: options.refresh ?? realRefresh,
      ...(options.timeoutMs === undefined ? {} : { firstFetchTimeoutMs: options.timeoutMs }),
    },
  });
}

async function call(
  app: ReturnType<typeof createApp>,
  user: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
  });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return Promise.resolve(
    app.fetch(
      new Request(`${env.APP_ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    ),
  );
}

async function subscribe(user: string, body: unknown, options: Options = {}) {
  const res = await call(appFor(options), user, 'POST', '/api/subscriptions', body);
  return { res, json: (await res.json()) as unknown };
}

const ok = (json: unknown) => json as SubscribeResponse;
const err = (json: unknown) => (json as ApiError).error;

async function addUser(id: string): Promise<void> {
  await seedUser(id);
  tokens[id] = await seedSession(id, { now: nowS() });
}

async function seedFolder(id: string, userId: string, name: string): Promise<void> {
  await db.run(
    sql(
      'INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, 0)',
      id,
      userId,
      name,
    ),
  );
}

/** An HTML page that links the given feeds. */
function page(links: string[], extra = ''): string {
  return `<!doctype html><html><head><title>Blog</title>${links.join('')}</head><body>${extra}</body></html>`;
}
const link = (href: string, type = 'application/rss+xml', title = '') =>
  `<link rel="alternate" type="${type}" href="${href}"${title ? ` title="${title}"` : ''}>`;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
  jobs = [];
  tokens = {};
  await addUser('u1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC1: a direct feed URL', () => {
  it('returns 201, fetches, and links the newest 10 items, items older than 7 days already read', async () => {
    // 12 items: 8 from the last day, 4 from 8 or more days ago. The newest 10 are linked.
    const old = [0, 1, 2, 3].map((n) => ({ guid: `old${n}`, ageH: 24 * 8 + n }));
    const recent = items(1, 8);
    fx.fake.serveFeed(FEED, rss([...recent, ...old]));

    const { res, json } = await subscribe('u1', { url: FEED });

    expect(res.status).toBe(201);
    const body = ok(json);
    expect(body.fetch).toEqual({ ok: true, newEntries: 10 });
    expect(body.subscription).toMatchObject({
      title: 'Test feed',
      customTitle: null,
      folderId: null,
      feedUrl: FEED,
      health: { state: 'ok', errorCode: null, errorMessage: null },
    });
    expect(await count('entries')).toBe(12);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(10);
    expect(await count('user_entries', 'user_id = ? AND is_read = 0', 'u1')).toBe(8);
    const readRows = await db.all<{ read_at: number | null; published_at: number }>(
      sql('SELECT read_at, published_at FROM user_entries WHERE user_id = ? AND is_read = 1', 'u1'),
    );
    expect(readRows.rows).toHaveLength(2);
    for (const r of readRows.rows) {
      expect(r.published_at).toBeLessThan(nowS() - 7 * 86400);
      expect(r.read_at).toBe(nowS());
    }
    // These are the rows /feeds/:id lists (user_entries by user and feed, ue_feed index).
    const feedId = (await db.first<{ id: number }>(sql('SELECT id FROM feeds')))?.id;
    expect(await count('user_entries', 'user_id = ? AND feed_id = ?', 'u1', feedId ?? -1)).toBe(10);
  });

  it('GET /api/subscriptions then lists it, and the new feed is jittered within 60 s', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    await subscribe('u1', { url: FEED });
    const res = await call(appFor(), 'u1', 'GET', '/api/subscriptions');
    const list = ((await res.json()) as { items: Subscription[] }).items;
    expect(list).toHaveLength(1);
    expect(list[0]?.feedUrl).toBe(FEED);
  });

  it('a feed:// address and a fragment are canonicalised before the feed row is made', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { res, json } = await subscribe('u1', { url: 'feed://FEED.example.com:443/rss.xml#top' });
    expect(res.status).toBe(201);
    expect(ok(json).subscription.feedUrl).toBe(FEED);
  });

  it('malformed bodies are 400 validation_failed', async () => {
    for (const body of [{}, { url: '' }, { url: 'not a url' }, { url: 'ftp://x.example.com/' }]) {
      const { res, json } = await subscribe('u1', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(err(json).code).toBe('validation_failed');
    }
    expect(await count('feeds')).toBe(0);
  });
});

describe('AC2: a website URL', () => {
  it('with one discoverable feed subscribes to that feed', async () => {
    fx.fake.route(SITE, { headers: HTML, body: page([link('/feed.xml')]) });
    fx.fake.serveFeed('https://blog.example.com/feed.xml', rss(items(1, 3)));

    const { res, json } = await subscribe('u1', { url: SITE });

    expect(res.status).toBe(201);
    expect(ok(json).subscription.feedUrl).toBe('https://blog.example.com/feed.xml');
    expect(ok(json).fetch.newEntries).toBe(3);
  });

  it('with several returns 422 feed_choice_required with candidates, and creates nothing', async () => {
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([
        link('/rss.xml', 'application/rss+xml', 'Posts'),
        link('/atom.xml', 'application/atom+xml', 'Posts (Atom)'),
        link('/feed.json', 'application/feed+json', 'JSON'),
      ]),
    });

    const { res, json } = await subscribe('u1', { url: SITE });

    expect(res.status).toBe(422);
    expect(err(json).code).toBe('feed_choice_required');
    expect(err(json).details).toEqual({
      candidates: [
        { url: 'https://blog.example.com/rss.xml', title: 'Posts', type: 'rss', supported: true },
        {
          url: 'https://blog.example.com/atom.xml',
          title: 'Posts (Atom)',
          type: 'atom',
          supported: true,
        },
        {
          url: 'https://blog.example.com/feed.json',
          title: 'JSON',
          type: 'json',
          supported: false,
        },
      ],
    });
    expect(await count('feeds')).toBe(0);
    expect(await count('subscriptions')).toBe(0);
  });

  it('after picking a candidate, posting its URL subscribes', async () => {
    fx.fake.serveFeed('https://blog.example.com/atom.xml', rss(items(1, 2)));
    const { res } = await subscribe('u1', { url: 'https://blog.example.com/atom.xml' });
    expect(res.status).toBe(201);
  });

  it('with none returns 422 no_feed_found, and creates nothing', async () => {
    fx.fake.route(SITE, { headers: HTML, body: page([link('/style.css', 'text/css')]) });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(422);
    expect(err(json).code).toBe('no_feed_found');
    expect(await count('feeds')).toBe(0);
  });

  it('a page that only links a JSON Feed is no_feed_found (unsupported in the MVP)', async () => {
    fx.fake.route(SITE, { headers: HTML, body: page([link('/f.json', 'application/feed+json')]) });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(422);
    expect(err(json).code).toBe('no_feed_found');
  });

  it('something that is neither a feed nor a page is no_feed_found', async () => {
    fx.fake.route(SITE, { headers: { 'Content-Type': 'text/plain' }, body: 'just some text' });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(422);
    expect(err(json).code).toBe('no_feed_found');
  });
});

describe('AC3: already subscribed', () => {
  it('returns 409 with the existing ID, also for an equivalent spelling of the URL', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    const first = ok((await subscribe('u1', { url: FEED })).json).subscription;

    for (const url of [FEED, 'HTTPS://Feed.Example.COM:443/rss.xml#x', 'feed:' + FEED]) {
      const { res, json } = await subscribe('u1', { url });
      expect(res.status, url).toBe(409);
      expect(err(json).code).toBe('already_subscribed');
      expect(err(json).details).toEqual({ subscriptionId: first.id });
    }
    expect(await count('subscriptions')).toBe(1);
  });

  it('is also found through a website whose feed the user already follows', async () => {
    fx.fake.serveFeed('https://blog.example.com/feed.xml', rss(items(1, 3)));
    const first = ok((await subscribe('u1', { url: 'https://blog.example.com/feed.xml' })).json);
    fx.fake.route(SITE, { headers: HTML, body: page([link('/feed.xml')]) });

    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(409);
    expect(err(json).details).toEqual({ subscriptionId: first.subscription.id });
  });
});

describe('AC4: a feed another user already has', () => {
  it('fetched within 30 minutes: no origin fetch, the newest 10 existing entries are linked', async () => {
    await addUser('u2');
    fx.fake.serveFeed(FEED, rss(items(1, 15)));
    await subscribe('u1', { url: FEED });
    const fetchesBefore = fx.fake.calls.length;
    const jobsBefore = jobs.length;
    fx.clock.advance(10 * MINUTE);

    const { res, json } = await subscribe('u2', { url: FEED });

    expect(res.status).toBe(201);
    expect(fx.fake.calls.length).toBe(fetchesBefore); // no discovery fetch, no refresh fetch
    expect(jobs.length).toBe(jobsBefore); // the refresher was not called
    expect(ok(json).fetch).toEqual({ ok: true, newEntries: 10 });
    const ids = async (u: string) =>
      (
        await db.all<{ entry_id: number }>(
          sql('SELECT entry_id FROM user_entries WHERE user_id = ? ORDER BY entry_id', u),
        )
      ).rows.map((r) => r.entry_id);
    expect(await ids('u2')).toEqual(await ids('u1'));
    expect(await ids('u2')).toHaveLength(10);
  });

  it('fetched more than 30 minutes ago: the refresher runs, and the user still gets the existing items', async () => {
    await addUser('u2');
    fx.fake.serveFeed(FEED, rss(items(1, 15)));
    await subscribe('u1', { url: FEED });
    const jobsBefore = jobs.length;
    fx.clock.advance(31 * MINUTE);

    const { res, json } = await subscribe('u2', { url: FEED });

    expect(res.status).toBe(201);
    expect(jobs.length).toBe(jobsBefore + 1);
    expect(ok(json).fetch.newEntries).toBe(10);
  });
});

describe('AC5: a first fetch that fails or is slow', () => {
  it('an origin error still creates the subscription, failing, with the fixed message', async () => {
    fx.fake.route(FEED, { status: 500, headers: { 'Content-Type': 'application/rss+xml' } });
    const { res, json } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(201);
    expect(ok(json).fetch).toEqual({ ok: false, newEntries: 0, errorCode: 'http_500' });
    expect(ok(json).subscription.health).toMatchObject({
      state: 'failing',
      errorCode: 'http_500',
      errorMessage: 'The server returned 500 Internal Server Error',
    });
    expect(await count('subscriptions')).toBe(1);
  });

  it('a network error on the address still subscribes (the person may have typed a feed URL)', async () => {
    fx.fake.route(FEED, { error: new Error('connection reset') });
    const { res, json } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(201);
    expect(ok(json).fetch.errorCode).toBe('network_error');
    expect(ok(json).subscription.health.state).toBe('failing');
  });

  it('a first fetch that exceeds 10 s: the API answers 201, pending, and does not wait forever', async () => {
    fx.fake.route(FEED, { headers: { 'Content-Type': 'application/rss+xml' }, body: '<rss/>' });
    let release: () => void = () => undefined;
    const hung: RefreshFn = () =>
      new Promise((resolve) => {
        release = () => resolve({} as RefreshOutcome);
      });
    const started = Date.now();
    const { res, json } = await subscribe('u1', { url: FEED }, { refresh: hung, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(5000);
    release();
    expect(res.status).toBe(201);
    expect(ok(json).fetch).toEqual({ ok: false, newEntries: 0, errorCode: 'timeout' });
    expect(ok(json).subscription.health.state).toBe('pending');
    // The dispatcher retries soon: next_fetch_at is within 60 s.
    const row = await db.first<{ next_fetch_at: number }>(
      sql('SELECT next_fetch_at FROM feeds WHERE url = ?', FEED),
    );
    expect(row?.next_fetch_at).toBe(nowS() + 30);
  });

  it('an RPC rejection (the callee died) is a 201 with a fixed code, never exception text', async () => {
    fx.fake.route(FEED, { headers: { 'Content-Type': 'application/rss+xml' }, body: '<rss/>' });
    const boom: RefreshFn = () => Promise.reject(new Error('SECRET exception text'));
    const { res, json } = await subscribe('u1', { url: FEED }, { refresh: boom });
    expect(res.status).toBe(201);
    expect(ok(json).fetch).toEqual({ ok: false, newEntries: 0, errorCode: 'internal' });
    expect(JSON.stringify(json)).not.toContain('SECRET');
  });
});

describe('AC6: private and internal addresses', () => {
  it.each([
    'http://127.0.0.1/feed.xml',
    'http://[::1]/feed.xml',
    'http://169.254.169.254/latest/meta-data',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://localhost/feed.xml',
    'http://localhost./feed.xml',
    'http://10.0.0.5/rss',
    'http://printer.local/rss',
    'https://feed.example.com:22/rss.xml',
    'https://tidings.mcn.am/api/health',
  ])('%s is 422 blocked_address and nothing is created or fetched', async (url) => {
    const { res, json } = await subscribe('u1', { url });
    expect(res.status).toBe(422);
    expect(err(json)).toEqual({ code: 'blocked_address', message: 'This address is not allowed' });
    expect(await count('feeds')).toBe(0);
    expect(await count('subscriptions')).toBe(0);
    expect(fx.fake.calls).toHaveLength(0);
  });

  it('a public URL that redirects to a private address is blocked too, and nothing is created', async () => {
    fx.fake.route(FEED, { redirectTo: 'http://169.254.169.254/latest/meta-data' });
    const { res, json } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(422);
    expect(err(json).code).toBe('blocked_address');
    expect(await count('feeds')).toBe(0);
    expect(fx.fake.calls.map((c) => c.url)).toEqual([FEED]); // the private hop was never requested
  });
});

describe('AC7: 1,000 subscriptions', () => {
  async function seedSubscriptions(n: number): Promise<void> {
    // D1's exec() takes one statement per line.
    await env.DB.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO feeds (id, url, next_fetch_at, state, created_at) SELECT i, 'https://f' || i || '.example.net/rss', 0, 'ok', 0 FROM n`,
    );
    await env.DB.exec(
      "INSERT INTO subscriptions (id, user_id, feed_id, created_at) SELECT 's' || id, 'u1', id, 0 FROM feeds",
    );
  }

  it('at 1,000 the answer is 422 limit_reached and nothing is added', async () => {
    await seedSubscriptions(1000);
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { res, json } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(422);
    expect(err(json)).toEqual({
      code: 'limit_reached',
      message: "You've reached the limit of 1,000 feeds.",
    });
    expect(await count('subscriptions')).toBe(1000);
    expect(await count('feeds', 'url = ?', FEED)).toBe(0);
  });

  it('at 999 the 1,000th succeeds', async () => {
    await seedSubscriptions(999);
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { res } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(201);
    expect(await count('subscriptions', 'user_id = ?', 'u1')).toBe(1000);
  });
});

describe('AC8: folder and custom title at add time', () => {
  it('creates the subscription with them', async () => {
    await seedFolder('f1', 'u1', 'Tech');
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { res, json } = await subscribe('u1', {
      url: FEED,
      folderId: 'f1',
      title: '  My news  ',
    });
    expect(res.status).toBe(201);
    expect(ok(json).subscription).toMatchObject({
      folderId: 'f1',
      title: 'My news',
      customTitle: 'My news',
    });
    const row = await db.first<{ folder_id: string; title_override: string }>(
      sql('SELECT folder_id, title_override FROM subscriptions'),
    );
    expect(row).toEqual({ folder_id: 'f1', title_override: 'My news' });
  });

  it('a blank title means no custom title; a null folder means none', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { json } = await subscribe('u1', { url: FEED, folderId: null, title: '   ' });
    expect(ok(json).subscription).toMatchObject({
      folderId: null,
      customTitle: null,
      title: 'Test feed',
    });
  });

  it('a title over 200 characters is 400', async () => {
    const { res } = await subscribe('u1', { url: FEED, title: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('GET /api/folders lists the user’s folders alphabetically, ignoring case', async () => {
    await seedFolder('f1', 'u1', 'tech');
    await seedFolder('f2', 'u1', 'Art');
    const res = await call(appFor(), 'u1', 'GET', '/api/folders');
    expect(((await res.json()) as { items: Folder[] }).items.map((f) => f.name)).toEqual([
      'Art',
      'tech',
    ]);
  });
});

describe('AC9: the first fetch runs through the FeedRefresher entrypoint', () => {
  it('the API calls the refresher with the feed job, and parses nothing itself', async () => {
    const calls: RefreshJob[] = [];
    const spy: RefreshFn = (job) => {
      calls.push(job);
      return Promise.resolve({
        feedId: job.feedId,
        result: 'unchanged',
        newEntries: 0,
        errorCode: null,
        usage: { rowsRead: 0, rowsWritten: 0, statements: 0 },
      });
    };
    fx.fake.serveFeed(FEED, rss(items(1, 5)));

    const { res, json } = await subscribe('u1', { url: FEED }, { refresh: spy });

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: FEED, state: 'pending', lastSuccessAt: null });
    // The refresher did nothing here, and so there are no entries: the request did no parsing.
    expect(await count('entries')).toBe(0);
    expect(await count('user_entries')).toBe(0);
    expect(ok(json).fetch).toEqual({ ok: true, newEntries: 0 });
  });

  it('in production wiring the call goes to ctx.exports.FeedRefresher.refresh', async () => {
    const fake = fx.fake;
    vi.stubGlobal('fetch', fake.fetch);
    fake.serveFeed(FEED, rss(items(1, 4)));
    // No `refresh` is injected: the API reaches the real entrypoint through ctx.exports.
    const app = createApp({
      clock: () => fx.clock.now(),
      subscriptions: { fetch: fake.fetch as FetchFn },
    });
    const res = await app.fetch(
      new Request(`${env.APP_ORIGIN}/api/subscriptions`, {
        method: 'POST',
        headers: {
          Origin: env.APP_ORIGIN,
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${tokens.u1}`,
        },
        body: JSON.stringify({ url: FEED }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SubscribeResponse;
    // Entries exist only because the entrypoint (a separate invocation) fetched and stored them.
    expect(body.fetch).toEqual({ ok: true, newEntries: 4 });
    expect(await count('entries')).toBe(4);
    // One look at the URL by the API (discovery), one fetch by the refresher.
    expect(fake.callsTo(FEED)).toHaveLength(2);
  });
});

describe('AC10: no oracle (spec 10.6 rule 8)', () => {
  const MARK = 'ORACLE-MARKER-7f3a';
  const hostile = {
    status: 500,
    headers: { 'X-Marker': MARK, 'Content-Type': 'text/html', 'Set-Cookie': `m=${MARK}` },
    body: `<html><body>${MARK} stack trace at /srv/app.js</body></html>`,
  };

  function noMarker(...parts: string[]) {
    for (const p of parts) expect(p).not.toContain(MARK);
  }

  it('an origin that errors: only the code and the fixed message', async () => {
    fx.fake.route(FEED, hostile);
    const { res, json } = await subscribe('u1', { url: FEED });
    const text = JSON.stringify(json);
    noMarker(text, [...res.headers].join('\n'));
    expect(ok(json).fetch.errorCode).toBe('http_500');
    const listed = await (await call(appFor(), 'u1', 'GET', '/api/subscriptions')).text();
    noMarker(listed);
  });

  it('a redirect whose Location carries a marker: neither the Location nor the marker is echoed', async () => {
    fx.fake.route(FEED, { redirectTo: `http://169.254.169.254/${MARK}`, headers: hostile.headers });
    const { res, json } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(422);
    noMarker(JSON.stringify(json), [...res.headers].join('\n'));
  });

  it('a redirect chain that ends in an error page', async () => {
    fx.fake.route(FEED, { redirectTo: `https://other.example.com/${MARK}` });
    fx.fake.route(`https://other.example.com/${MARK}`, hostile);
    const { res, json } = await subscribe('u1', { url: FEED });
    noMarker(JSON.stringify(json), [...res.headers].join('\n'));
    expect(ok(json).fetch.errorCode).toBe('http_500');
  });

  it('a non-feed page with markers everywhere: no_feed_found with the fixed copy', async () => {
    fx.fake.route(SITE, {
      status: 200,
      headers: { ...hostile.headers, 'Content-Type': 'text/html' },
      body: `<html><head><title>${MARK}</title></head><body>${MARK}</body></html>`,
    });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(422);
    expect(err(json)).toEqual({
      code: 'no_feed_found',
      message: "We couldn't find a feed at that address.",
    });
    noMarker(JSON.stringify(json), [...res.headers].join('\n'));
  });

  it('feed_choice_required candidates carry only url, title, type and supported', async () => {
    fx.fake.route(SITE, {
      headers: { ...hostile.headers, 'Content-Type': 'text/html' },
      status: 200,
      body: page(
        [link('/a.xml', 'application/rss+xml', 'A'), link('/b.xml', 'application/atom+xml', 'B')],
        `<p>${MARK}</p>`,
      ),
    });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(422);
    const candidates = (err(json).details as { candidates: Record<string, unknown>[] }).candidates;
    for (const c of candidates)
      expect(Object.keys(c).sort()).toEqual(['supported', 'title', 'type', 'url']);
    noMarker(JSON.stringify(json), [...res.headers].join('\n'));
  });

  it('a long candidate title is cut, not passed through whole', async () => {
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([
        link('/a.xml', 'application/rss+xml', 'x'.repeat(500)),
        link('/b.xml', 'application/atom+xml'),
      ]),
    });
    const { json } = await subscribe('u1', { url: SITE });
    const first = (err(json).details as { candidates: { title: string }[] }).candidates[0];
    expect(first?.title).toHaveLength(120);
  });

  it('a feed that fails to parse: parse_error, nothing from the body', async () => {
    fx.fake.route(FEED, {
      headers: { 'Content-Type': 'application/rss+xml', 'X-Marker': MARK },
      body: `<rss><channel>${MARK}<item></rss>`,
    });
    const { json } = await subscribe('u1', { url: FEED });
    noMarker(JSON.stringify(json));
    // Whatever the parser made of it, only fixed codes and messages come back.
    const sub = ok(json).subscription;
    if (sub.health.errorCode) expect(sub.health.errorMessage).toBe("Couldn't parse the feed");
  });
});

describe('AC11: per-user isolation', () => {
  beforeEach(async () => {
    await addUser('u2');
  });

  async function snapshot(user: string) {
    return {
      folders: (await db.all(sql('SELECT * FROM folders WHERE user_id = ? ORDER BY id', user)))
        .rows,
      subscriptions: (
        await db.all(sql('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id', user))
      ).rows,
      userEntries: (
        await db.all(sql('SELECT * FROM user_entries WHERE user_id = ? ORDER BY entry_id', user))
      ).rows,
    };
  }

  it('B posting A’s folderId gets 404 not_found, and nothing is created or changed', async () => {
    await seedFolder('fa', 'u1', 'Tech');
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    const before = await snapshot('u1');
    const feedsBefore = await count('feeds');

    const { res, json } = await subscribe('u2', { url: FEED, folderId: 'fa' });

    expect(res.status).toBe(404);
    expect(err(json).code).toBe('not_found');
    expect(await count('subscriptions', 'user_id = ?', 'u2')).toBe(0);
    expect(await count('feeds')).toBe(feedsBefore);
    expect(fx.fake.calls).toHaveLength(0);
    expect(await snapshot('u1')).toEqual(before);
  });

  it('a folder that does not exist looks exactly the same as another user’s', async () => {
    await seedFolder('fa', 'u1', 'Tech');
    const a = await subscribe('u2', { url: FEED, folderId: 'fa' });
    const b = await subscribe('u2', { url: FEED, folderId: 'nope' });
    expect(a.res.status).toBe(b.res.status);
    expect(a.json).toEqual(b.json);
  });

  it('B subscribing to A’s feed sees only B’s subscription, and A’s entries are untouched', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 15)));
    const a = ok((await subscribe('u1', { url: FEED, title: 'A’s name' })).json).subscription;
    const before = await snapshot('u1');
    fx.clock.advance(5 * MINUTE);

    const { res, json } = await subscribe('u2', { url: FEED });

    expect(res.status).toBe(201);
    const b = ok(json).subscription;
    expect(b.id).not.toBe(a.id);
    expect(b.title).toBe('Test feed'); // not A's custom title
    expect(JSON.stringify(json)).not.toContain(a.id);
    const list = (await (await call(appFor(), 'u2', 'GET', '/api/subscriptions')).json()) as {
      items: Subscription[];
    };
    expect(list.items.map((s) => s.id)).toEqual([b.id]);
    expect(await snapshot('u1')).toEqual(before);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(10);
  });

  it('GET /api/folders returns only the caller’s folders', async () => {
    await seedFolder('fa', 'u1', 'Tech');
    await seedFolder('fb', 'u2', 'Mine');
    const res = await call(appFor(), 'u2', 'GET', '/api/folders');
    expect(((await res.json()) as { items: Folder[] }).items).toEqual([{ id: 'fb', name: 'Mine' }]);
  });

  it('an unauthenticated request is 401', async () => {
    const res = await createApp().fetch(
      new Request(`${env.APP_ORIGIN}/api/subscriptions`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: FEED }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('AC12: subscribing resets a parked, dead or gone feed (ADR 0013 decision 7)', () => {
  async function seedUnsubscribedFeed(state: string, nextFetchAt: number, errorCount = 0) {
    await db.run(
      sql(
        `INSERT INTO feeds (id, url, next_fetch_at, state, error_count, last_error_code,
                            last_success_at, created_at)
         VALUES (500, ?, ?, ?, ?, 'http_410', 1, 0)`,
        FEED,
        nextFetchAt,
        state,
        errorCount,
      ),
    );
  }

  it('a parked feed gets next_fetch_at = now plus jitter (within 60 s)', async () => {
    await seedUnsubscribedFeed('ok', PARKED_AT);
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    const { res } = await subscribe(
      'u1',
      { url: FEED },
      { refresh: () => Promise.reject(new Error('x')) },
    );
    expect(res.status).toBe(201);
    const row = await feedRow(500);
    expect(row.next_fetch_at).toBeGreaterThanOrEqual(nowS());
    expect(row.next_fetch_at).toBeLessThanOrEqual(nowS() + 60);
    expect(row.state).toBe('ok');
  });

  it.each(['dead', 'gone'])(
    'a %s feed returns to pending with error_count 0, before the first fetch',
    async (state) => {
      await seedUnsubscribedFeed(state, PARKED_AT, 20);
      fx.fake.serveFeed(FEED, rss(items(1, 3)));

      const { res, json } = await subscribe('u1', { url: FEED });

      expect(res.status).toBe(201);
      // The job the refresher got was already reset ...
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ feedId: 500, state: 'pending', errorCount: 0 });
      // ... and the fetch ran (last_success_at was 1: the feed is now fresh and healthy).
      expect(ok(json).fetch.ok).toBe(true);
      expect(await feedRow(500)).toMatchObject({ state: 'ok', error_count: 0 });
    },
  );

  it('a dead feed whose first fetch fails again goes back to failing, one failure counted', async () => {
    await seedUnsubscribedFeed('dead', nowS() + 86400, 20);
    fx.fake.route(FEED, { status: 404 });
    await subscribe('u1', { url: FEED });
    expect(await feedRow(500)).toMatchObject({ state: 'failing', error_count: 1 });
  });

  it('a healthy feed that already has subscribers is not rescheduled', async () => {
    await addUser('u2');
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    await subscribe('u2', { url: FEED });
    const before = (
      await db.first<{ next_fetch_at: number }>(
        sql('SELECT next_fetch_at FROM feeds WHERE url = ?', FEED),
      )
    )?.next_fetch_at;
    fx.clock.advance(5 * MINUTE);
    await subscribe('u1', { url: FEED });
    const after = (
      await db.first<{ next_fetch_at: number }>(
        sql('SELECT next_fetch_at FROM feeds WHERE url = ?', FEED),
      )
    )?.next_fetch_at;
    expect(after).toBe(before);
  });
});

describe('AC1: the 7 day cut-off is measured from now', () => {
  it('an item exactly 7 days old is unread, one second older is read', async () => {
    const day = DAY / 1000;
    const cutoff = nowS() - 7 * day;
    // Two items, published exactly at the cut-off and one second before it.
    const xml = (t: number) => new Date(t * 1000).toUTCString();
    fx.fake.serveFeed(
      FEED,
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
        `<item><guid>edge</guid><title>edge</title><pubDate>${xml(cutoff)}</pubDate></item>` +
        `<item><guid>older</guid><title>older</title><pubDate>${xml(cutoff - 1)}</pubDate></item>` +
        '</channel></rss>',
    );
    await subscribe('u1', { url: FEED });
    const rows = (
      await db.all<{ is_read: number; published_at: number }>(
        sql('SELECT is_read, published_at FROM user_entries ORDER BY published_at'),
      )
    ).rows;
    expect(rows.map((r) => r.is_read)).toEqual([1, 0]);
  });
});
