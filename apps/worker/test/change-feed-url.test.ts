import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiError,
  ChangeFeedUrlResponse,
  SubscribeResponse,
  Subscription,
} from '@tidings/shared';
import { MINUTE } from '@tidings/test-utils';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { runMaintenance } from '../src/maintenance';
import { sql } from '../src/db';
import type { FetchFn } from '../src/fetch';
import { PARKED_AT, refreshFeed, type RefreshJob, type RefreshOutcome } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  items,
  resetData,
  rss,
  type Fixture,
} from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-068: change a subscription's feed address (spec 8.4). The whole API runs for real in
// workerd against local D1; only the network is faked.

const OLD = 'https://old.example.com/rss.xml';
const NEW = 'https://new.example.com/feed.xml';
const SITE = 'https://blog.example.com/';
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

let fx: Fixture;
let jobs: RefreshJob[];
let tokens: Record<string, string>;
const nowS = () => Math.floor(fx.clock.now() / 1000);

type RefreshFn = (job: RefreshJob) => Promise<RefreshOutcome>;

function appFor(options: { refresh?: RefreshFn; timeoutMs?: number } = {}) {
  const realRefresh: RefreshFn = (job) => {
    jobs.push(job);
    return refreshFeed(job, fx.deps);
  };
  return createApp({
    clock: () => fx.clock.now(),
    subscriptions: {
      fetch: fx.fake.fetch as FetchFn,
      random: () => 0.5,
      refresh: options.refresh ?? realRefresh,
      ...(options.timeoutMs === undefined ? {} : { firstFetchTimeoutMs: options.timeoutMs }),
    },
  });
}

async function call(
  user: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  options: { refresh?: RefreshFn; timeoutMs?: number } = {},
) {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
  });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await appFor(options).fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { res, json: (await res.json()) as unknown };
}

const subscribe = (user: string, body: unknown) => call(user, 'POST', '/api/subscriptions', body);
const change = (
  user: string,
  id: string,
  url: unknown,
  options: { refresh?: RefreshFn; timeoutMs?: number } = {},
) => call(user, 'POST', `/api/subscriptions/${id}/url`, { url }, options);

const subOf = (json: unknown) => (json as SubscribeResponse).subscription;
const changed = (json: unknown) => json as ChangeFeedUrlResponse;
const err = (json: unknown) => (json as ApiError).error;

async function addUser(id: string): Promise<void> {
  await seedUser(id);
  tokens[id] = await seedSession(id, { now: nowS() });
}

async function subscribeTo(user: string, url: string, body: Record<string, unknown> = {}) {
  const { res, json } = await subscribe(user, { url, ...body });
  expect(res.status).toBe(201);
  return subOf(json);
}

const page = (links: string[], extra = '') =>
  `<!doctype html><html><head><title>Blog</title>${links.join('')}</head><body>${extra}</body></html>`;
const link = (href: string, title = '') =>
  `<link rel="alternate" type="application/rss+xml" href="${href}"${title ? ` title="${title}"` : ''}>`;

async function feedRow(url: string) {
  return db.first<{ id: number; next_fetch_at: number; state: string; error_count: number }>(
    sql('SELECT * FROM feeds WHERE url = ?', url),
  );
}

async function feedIdOf(url: string): Promise<number> {
  const row = await feedRow(url);
  if (!row) throw new Error(`no feed ${url}`);
  return row.id;
}

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

describe('changing the address', () => {
  it('points the subscription at the new feed and keeps its id, title, folder and created date', async () => {
    await db.run(
      sql("INSERT INTO folders (id, user_id, name, created_at) VALUES ('f1', 'u1', 'Tech', 0)"),
    );
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const before = await subscribeTo('u1', OLD, { title: 'My name', folderId: 'f1' });
    fx.clock.advance(5 * MINUTE);
    fx.fake.serveFeed(NEW, rss(items(1, 3).map((i) => ({ ...i, guid: `n-${i.guid}` }))));

    const { res, json } = await change('u1', before.id, NEW);

    expect(res.status).toBe(200);
    const body = changed(json);
    expect(body.changed).toBe(true);
    expect(body.subscription).toMatchObject({
      id: before.id,
      title: 'My name',
      customTitle: 'My name',
      folderId: 'f1',
      createdAt: before.createdAt,
      feedUrl: NEW,
    });
    expect(await count('subscriptions', 'user_id = ?', 'u1')).toBe(1);
  });

  it('never edits the old shared feed row, and leaves other followers on it', async () => {
    await addUser('u2');
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    await subscribeTo('u2', OLD);
    const oldBefore = await feedRow(OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));

    await change('u1', a.id, NEW);

    expect(await feedRow(OLD)).toEqual(oldBefore); // url, schedule and state are untouched
    expect(await count('subscriptions', 'feed_id = ?', await feedIdOf(OLD))).toBe(1);
    const u2 = await db.first<{ n: number }>(
      sql(
        'SELECT COUNT(*) AS n FROM subscriptions s JOIN feeds f ON f.id = s.feed_id WHERE s.user_id = ? AND f.url = ?',
        'u2',
        OLD,
      ),
    );
    expect(u2?.n).toBe(1);
  });

  it('keeps the user’s entries (read state included) under the subscription, and cross-feed dedup hides the new feed’s copies', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 4)));
    const a = await subscribeTo('u1', OLD);
    // Read one article, so there is history to keep.
    await db.run(
      sql(
        'UPDATE user_entries SET is_read = 1, read_at = 1 WHERE user_id = ? AND entry_id = (SELECT MIN(entry_id) FROM user_entries WHERE user_id = ?)',
        'u1',
        'u1',
      ),
    );
    const idsBefore = (
      await db.all<{ entry_id: number; is_read: number }>(
        sql('SELECT entry_id, is_read FROM user_entries WHERE user_id = ? ORDER BY entry_id', 'u1'),
      )
    ).rows;
    // The new feed serves the same stories (same links) plus one new one.
    fx.clock.advance(5 * MINUTE);
    fx.fake.serveFeed(NEW, rss([...items(1, 4), ...items(5, 5)]));

    const { json } = await change('u1', a.id, NEW);

    const newId = await feedIdOf(NEW);
    const rows = (
      await db.all<{ entry_id: number; is_read: number; feed_id: number }>(
        sql(
          'SELECT entry_id, is_read, feed_id FROM user_entries WHERE user_id = ? ORDER BY entry_id',
          'u1',
        ),
      )
    ).rows;
    // The old four are still there, with the same read state, now shown under this subscription.
    expect(rows.filter((r) => idsBefore.some((b) => b.entry_id === r.entry_id))).toEqual(
      idsBefore.map((b) => ({ ...b, feed_id: newId })),
    );
    // Only the genuinely new story is added from the new feed: the copies are hidden (ADR 0017).
    expect(rows).toHaveLength(5);
    expect(changed(json).fetch.newEntries).toBe(5);
    // The entries themselves are shared and stay on the old feed.
    expect(await count('entries', 'feed_id = ?', await feedIdOf(OLD))).toBe(4);
    // Unread counts and the feed's article list use the new feed id.
    const counts = await call('u1', 'GET', '/api/counts');
    expect((counts.json as { subscriptions: Record<string, number> }).subscriptions[a.id]).toBe(4);
    const list = await call('u1', 'GET', `/api/entries?view=feed&id=${a.id}&state=all`);
    expect((list.json as { items: unknown[] }).items).toHaveLength(5);
  });

  it('parks the old feed when nobody follows it any more, and keeps its entries for the user', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));

    await change('u1', a.id, NEW);

    expect((await feedRow(OLD))?.next_fetch_at).toBe(PARKED_AT);
    expect((await feedRow(NEW))?.next_fetch_at).not.toBe(PARKED_AT);
  });

  it('the dead-feed purge leaves entries a user still has, so history survives the parked feed', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    await change('u1', a.id, NEW);

    fx.clock.advance(8 * 86_400_000);
    // Keep the user's rows young enough for retention: this test is about the feed purge only.
    await db.run(sql('UPDATE user_entries SET published_at = ? WHERE user_id = ?', nowS(), 'u1'));
    await db.run(sql('UPDATE feeds SET last_attempt_at = 1 WHERE url = ?', OLD));
    await runMaintenance({ db, clock: () => fx.clock.now() });

    expect(await count('entries', 'feed_id = ?', await feedIdOf(OLD))).toBe(3);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(6);
  });

  it('does not park the old feed while another user follows it', async () => {
    await addUser('u2');
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    await subscribeTo('u2', OLD);
    const scheduled = (await feedRow(OLD))?.next_fetch_at;
    fx.fake.serveFeed(NEW, rss(items(10, 12)));

    await change('u1', a.id, NEW);

    expect((await feedRow(OLD))?.next_fetch_at).toBe(scheduled);
  });

  it('subscribing to a feed that already exists links its newest entries and skips the fetch when fresh', async () => {
    await addUser('u2');
    fx.fake.serveFeed(NEW, rss(items(10, 14)));
    await subscribeTo('u2', NEW);
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.clock.advance(5 * MINUTE);
    const jobsBefore = jobs.length;

    const { json } = await change('u1', a.id, NEW);

    expect(jobs.length).toBe(jobsBefore); // fetched 5 minutes ago: no first fetch (FR-SU-2)
    expect(changed(json).fetch).toEqual({ ok: true, newEntries: 8 }); // 3 old + 5 linked
  });

  it('a parked or dead target feed is reset so the dispatcher tries it again', async () => {
    await addUser('u2');
    fx.fake.serveFeed(NEW, rss(items(10, 11)));
    const b = await subscribeTo('u2', NEW);
    await call('u2', 'GET', '/api/subscriptions');
    await db.run(
      sql(
        "UPDATE feeds SET state = 'dead', error_count = 9, last_success_at = NULL WHERE url = ?",
        NEW,
      ),
    );
    await db.run(sql('DELETE FROM subscriptions WHERE id = ?', b.id));
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);

    const { res } = await change('u1', a.id, NEW);

    expect(res.status).toBe(200);
    const row = await feedRow(NEW);
    expect(row?.state).not.toBe('dead');
    expect(row?.error_count).toBe(0);
  });
});

describe('first fetch', () => {
  it('runs through the refresher with the new feed’s job', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    jobs.length = 0;

    const { json } = await change('u1', a.id, NEW);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.url).toBe(NEW);
    expect(changed(json).fetch).toEqual({ ok: true, newEntries: 5 });
  });

  it('a feed that errors still changes the address: 200 with fetch.ok false and a fixed code', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(NEW, { status: 500, headers: { 'Content-Type': 'application/rss+xml' } });

    const { res, json } = await change('u1', a.id, NEW);

    expect(res.status).toBe(200);
    expect(changed(json).changed).toBe(true);
    expect(changed(json).fetch.ok).toBe(false);
    expect(changed(json).fetch.errorCode).toBe('http_500');
    expect(changed(json).subscription.feedUrl).toBe(NEW);
  });

  it('a network error while looking at the address still changes it (we keep trying)', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(NEW, { error: new Error('connection reset') });

    const { res, json } = await change('u1', a.id, NEW);

    expect(res.status).toBe(200);
    expect(changed(json).fetch.errorCode).toBe('network_error');
  });

  it('a first fetch over 10 s: answers 200 with a timeout code and does not wait forever', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    const never: RefreshFn = () => new Promise(() => undefined);

    const { res, json } = await change('u1', a.id, NEW, { refresh: never, timeoutMs: 20 });

    expect(res.status).toBe(200);
    expect(changed(json).fetch).toMatchObject({ ok: false, errorCode: 'timeout' });
    expect(changed(json).subscription.feedUrl).toBe(NEW);
  });

  it('an RPC rejection is a fixed code, never exception text', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 2)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    const boom: RefreshFn = () => Promise.reject(new Error('secret internal detail'));

    const { res, json } = await change('u1', a.id, NEW, { refresh: boom });

    expect(res.status).toBe(200);
    expect(changed(json).fetch.ok).toBe(false);
    expect(JSON.stringify(json)).not.toContain('secret internal detail');
  });
});

describe('edge cases', () => {
  it('the same URL (also another spelling) is a no-op success and fetches nothing', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    const callsBefore = fx.fake.calls.length;
    const subsBefore = (await db.all(sql('SELECT * FROM subscriptions'))).rows;

    const { res, json } = await change('u1', a.id, 'HTTPS://Old.Example.com/rss.xml#top');

    expect(res.status).toBe(200);
    expect(changed(json).changed).toBe(false);
    expect(changed(json).subscription.id).toBe(a.id);
    expect(changed(json).fetch).toEqual({ ok: true, newEntries: 3 });
    expect(fx.fake.calls.length).toBe(callsBefore);
    expect((await db.all(sql('SELECT * FROM subscriptions'))).rows).toEqual(subsBefore);
  });

  it('a website address whose discovered feed is the current one is also a no-op', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(SITE, { headers: HTML, body: page([link(OLD)]) });

    const { res, json } = await change('u1', a.id, SITE);

    expect(res.status).toBe(200);
    expect(changed(json).changed).toBe(false);
  });

  it('a feed the user follows under another subscription is 409 with that subscription id, and nothing changes', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    const a = await subscribeTo('u1', OLD);
    const b = await subscribeTo('u1', NEW);
    const before = (await db.all(sql('SELECT * FROM subscriptions ORDER BY id'))).rows;
    const entriesBefore = (await db.all(sql('SELECT * FROM user_entries ORDER BY entry_id'))).rows;

    const { res, json } = await change('u1', a.id, NEW);

    expect(res.status).toBe(409);
    expect(err(json)).toMatchObject({
      code: 'already_subscribed',
      details: { subscriptionId: b.id },
    });
    expect((await db.all(sql('SELECT * FROM subscriptions ORDER BY id'))).rows).toEqual(before);
    expect((await db.all(sql('SELECT * FROM user_entries ORDER BY entry_id'))).rows).toEqual(
      entriesBefore,
    );
  });

  it('is also 409 when a website address leads to a feed followed under another subscription', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    const a = await subscribeTo('u1', OLD);
    const b = await subscribeTo('u1', NEW);
    fx.fake.route(SITE, { headers: HTML, body: page([link(NEW)]) });
    // The feed row for NEW exists, but SITE is unknown, so it is discovered.
    const { res, json } = await change('u1', a.id, SITE);
    expect(res.status).toBe(409);
    expect(err(json).details).toEqual({ subscriptionId: b.id });
  });

  it('a website address with one feed discovers it', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(SITE, { headers: HTML, body: page([link('/feed.xml')]) });
    fx.fake.serveFeed('https://blog.example.com/feed.xml', rss(items(10, 12)));

    const { res, json } = await change('u1', a.id, SITE);

    expect(res.status).toBe(200);
    expect(changed(json).subscription.feedUrl).toBe('https://blog.example.com/feed.xml');
  });

  it('a page with several feeds is 422 feed_choice_required with candidates, and nothing changes', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([link('/a.xml', 'A'), link('/b.xml', 'B')]),
    });
    const feedsBefore = await count('feeds');

    const { res, json } = await change('u1', a.id, SITE);

    expect(res.status).toBe(422);
    expect(err(json).code).toBe('feed_choice_required');
    const cands = (err(json).details as { candidates: { url: string }[] }).candidates;
    expect(cands.map((c) => c.url)).toEqual([
      'https://blog.example.com/a.xml',
      'https://blog.example.com/b.xml',
    ]);
    expect(await count('feeds')).toBe(feedsBefore);
    expect((await feedRow(OLD))?.next_fetch_at).not.toBe(PARKED_AT);
  });

  it('a page with no feed is 422 no_feed_found with the fixed copy', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(SITE, { headers: HTML, body: page([], 'SECRET-MARKER') });

    const { res, json } = await change('u1', a.id, SITE);

    expect(res.status).toBe(422);
    expect(err(json)).toEqual({
      code: 'no_feed_found',
      message: "We couldn't find a feed at that address.",
    });
    expect(JSON.stringify(json)).not.toContain('SECRET-MARKER');
  });

  it.each([
    'http://127.0.0.1/feed.xml',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost/feed.xml',
    'https://feed.example.com:22/rss.xml',
  ])('%s is 422 blocked_address and nothing is created or fetched', async (url) => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    const feeds = await count('feeds');
    const calls = fx.fake.calls.length;

    const { res, json } = await change('u1', a.id, url);

    expect(res.status).toBe(422);
    expect(err(json)).toEqual({ code: 'blocked_address', message: 'This address is not allowed' });
    expect(await count('feeds')).toBe(feeds);
    expect(fx.fake.calls.length).toBe(calls);
    expect((await feedRow(OLD))?.next_fetch_at).not.toBe(PARKED_AT);
  });

  it('a redirect to a private address is blocked, and a discovered private feed is dropped', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(NEW, { redirectTo: 'http://169.254.169.254/latest/meta-data' });
    const redirected = await change('u1', a.id, NEW);
    expect(redirected.res.status).toBe(422);
    expect(err(redirected.json).code).toBe('blocked_address');

    fx.fake.route(SITE, { headers: HTML, body: page([link('http://10.0.0.5/feed.xml')]) });
    const discovered = await change('u1', a.id, SITE);
    expect(discovered.res.status).toBe(422);
    expect(err(discovered.json).code).toBe('blocked_address');
    expect(fx.fake.calls.some((c) => c.url.includes('10.0.0.5'))).toBe(false);
    expect((await subOfUser('u1', a.id))?.feedUrl).toBe(OLD);
  });

  it('a redirecting feed URL is stored under the address typed (like subscribe) and fetched by the refresher', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.route(NEW, { redirectTo: 'https://cdn.example.com/real.xml' });
    fx.fake.serveFeed('https://cdn.example.com/real.xml', rss(items(10, 12)));

    const { res, json } = await change('u1', a.id, NEW);

    expect(res.status).toBe(200);
    expect(changed(json).subscription.feedUrl).toBe(NEW);
  });

  it('malformed input is 400 validation_failed', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    for (const body of [{}, { url: '' }, { url: 42 }, { url: 'x'.repeat(3000) }]) {
      const { res } = await call('u1', 'POST', `/api/subscriptions/${a.id}/url`, body);
      expect(res.status).toBe(400);
    }
    for (const url of ['ftp://example.com/feed', 'https://user:pw@example.com/feed']) {
      const { res, json } = await change('u1', a.id, url);
      expect(res.status).toBe(400);
      expect(err(json).code).toBe('validation_failed');
    }
  });

  it('a missing subscription is 404 not_found', async () => {
    const { res, json } = await change('u1', 'nope', NEW);
    expect(res.status).toBe(404);
    expect(err(json).code).toBe('not_found');
  });

  it('an unauthenticated request is 401', async () => {
    const res = await createApp().fetch(
      new Request(`${env.APP_ORIGIN}/api/subscriptions/x/url`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: NEW }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('it is not a new subscription: the 1,000 limit does not apply', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    const stmts = Array.from({ length: 999 }, (_, n) =>
      sql(
        "INSERT INTO feeds (url, next_fetch_at, state, created_at) VALUES (?, 0, 'pending', 0)",
        `https://filler${n}.example.com/rss`,
      ),
    );
    await db.batch(stmts);
    await db.run(
      sql(
        `INSERT INTO subscriptions (id, user_id, feed_id, created_at)
         SELECT 'fill' || id, 'u1', id, 0 FROM feeds WHERE url LIKE 'https://filler%'`,
      ),
    );
    expect(await count('subscriptions', 'user_id = ?', 'u1')).toBe(1000);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));

    const { res } = await change('u1', a.id, NEW);

    expect(res.status).toBe(200);
  });
});

async function subOfUser(user: string, id: string): Promise<Subscription | undefined> {
  const { json } = await call(user, 'GET', '/api/subscriptions');
  return (json as { items: Subscription[] }).items.find((s) => s.id === id);
}

describe('per-user isolation', () => {
  beforeEach(async () => {
    await addUser('u2');
  });

  async function snapshot() {
    return {
      subscriptions: (await db.all(sql('SELECT * FROM subscriptions ORDER BY id'))).rows,
      userEntries: (await db.all(sql('SELECT * FROM user_entries ORDER BY user_id, entry_id')))
        .rows,
      feeds: (await db.all(sql('SELECT * FROM feeds ORDER BY id'))).rows,
    };
  }

  it('B changing A’s subscription’s address gets 404 not_found, and nothing changes', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    fx.fake.serveFeed(NEW, rss(items(10, 12)));
    const before = await snapshot();
    const calls = fx.fake.calls.length;

    const { res, json } = await change('u2', a.id, NEW);

    expect(res.status).toBe(404);
    expect(err(json).code).toBe('not_found');
    expect(await snapshot()).toEqual(before);
    expect(fx.fake.calls.length).toBe(calls);
    // Looks exactly like an id that never existed.
    const nope = await change('u2', 'does-not-exist', NEW);
    expect(nope.res.status).toBe(404);
    expect(nope.json).toEqual(json);
  });

  it('A’s change does not touch B’s subscription to the same old feed or B’s entries', async () => {
    fx.fake.serveFeed(OLD, rss(items(1, 3)));
    const a = await subscribeTo('u1', OLD);
    const b = await subscribeTo('u2', OLD);
    const bEntries = (
      await db.all(sql('SELECT * FROM user_entries WHERE user_id = ? ORDER BY entry_id', 'u2'))
    ).rows;
    fx.fake.serveFeed(NEW, rss(items(10, 12)));

    await change('u1', a.id, NEW);

    expect(
      (await db.all(sql('SELECT * FROM user_entries WHERE user_id = ? ORDER BY entry_id', 'u2')))
        .rows,
    ).toEqual(bEntries);
    expect((await subOfUser('u2', b.id))?.feedUrl).toBe(OLD);
  });
});
