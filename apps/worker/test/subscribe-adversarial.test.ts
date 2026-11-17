import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, SubscribeResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { createSubscription, sql } from '../src/db';
import type { FetchFn } from '../src/fetch';
import { refreshFeed, type RefreshJob } from '../src/refresh';
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

// TID-013 tester pass: adversarial inputs against POST /api/subscriptions (spec 7.5, 8.4, 10.6, 10.8).
// Same harness as subscribe.test.ts: the real app in workerd with a local D1 and a fake network.

const FEED = 'https://feed.example.com/rss.xml';
const SITE = 'https://blog.example.com/';
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

let fx: Fixture;
let tokens: Record<string, string>;

function appFor() {
  return createApp({
    clock: () => fx.clock.now(),
    subscriptions: {
      fetch: fx.fake.fetch as FetchFn,
      random: () => 0.5,
      refresh: (job: RefreshJob) => refreshFeed(job, fx.deps),
    },
  });
}

async function post(user: string, raw: string, headers: Record<string, string> = {}) {
  const h = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
    'Content-Type': 'application/json',
    ...headers,
  });
  const res = await appFor().fetch(
    new Request(`${env.APP_ORIGIN}/api/subscriptions`, { method: 'POST', headers: h, body: raw }),
    env,
  );
  return { res, json: (await res.json().catch(() => null)) as unknown };
}
const subscribe = (user: string, body: unknown) => post(user, JSON.stringify(body));
const err = (json: unknown) => (json as ApiError).error;
const ok = (json: unknown) => json as SubscribeResponse;
const page = (links: string[], extra = '') =>
  `<!doctype html><html><head>${links.join('')}</head><body>${extra}</body></html>`;
const link = (href: string, type = 'application/rss+xml') =>
  `<link rel="alternate" type="${type}" href="${href}">`;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
  tokens = {};
  await seedUser('u1');
  tokens.u1 = await seedSession('u1', { now: Math.floor(fx.clock.now() / 1000) });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('hostile request bodies are refused and create nothing', () => {
  it.each([
    ['not JSON', 'nope'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a bare string', '"https://feed.example.com/"'],
    ['empty object', '{}'],
    ['url is a number', '{"url":5}'],
    ['url is an object', '{"url":{"href":"https://feed.example.com/"}}'],
    ['url is an array of strings', '{"url":["https://feed.example.com/"]}'],
    ['url is blank', '{"url":"   "}'],
    ['folderId is a number', `{"url":"${FEED}","folderId":7}`],
    ['folderId is empty', `{"url":"${FEED}","folderId":""}`],
    ['folderId is an object', `{"url":"${FEED}","folderId":{"$ne":null}}`],
    ['title is an object', `{"url":"${FEED}","title":{"a":1}}`],
    [
      'url is 2049 characters',
      JSON.stringify({ url: `https://feed.example.com/${'a'.repeat(2030)}` }),
    ],
  ])('%s is 400', async (_name, raw) => {
    const { res, json } = await post('u1', raw);
    expect(res.status).toBe(400);
    expect(err(json).code).toBe('validation_failed');
    expect(await count('feeds')).toBe(0);
    expect(await count('subscriptions')).toBe(0);
    expect(fx.fake.calls).toHaveLength(0);
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'ftp://feed.example.com/rss.xml',
    'gopher://feed.example.com/',
    'https://user:secret@feed.example.com/rss.xml',
    'not a url',
    'https://',
  ])('%j is refused (400 or 422) and nothing is created or fetched', async (url) => {
    const { res, json } = await subscribe('u1', { url });
    expect([400, 422]).toContain(res.status);
    expect(err(json).code).toMatch(/^(validation_failed|blocked_address)$/);
    expect(await count('feeds')).toBe(0);
    expect(fx.fake.calls).toHaveLength(0);
  });

  it('a 2 MB body is refused without a 5xx', async () => {
    const { res } = await post('u1', JSON.stringify({ url: FEED, title: 'x'.repeat(2_000_000) }));
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count('feeds')).toBe(0);
  });

  it('an SQL-looking folderId is a plain 404, and extra fields (userId, feedId) are ignored', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const a = await subscribe('u1', { url: FEED, folderId: "x' OR '1'='1" });
    expect(a.res.status).toBe(404);
    await seedUser('u2');
    const b = await subscribe('u1', { url: FEED, userId: 'u2', feedId: 1, id: 'sub-evil' });
    expect(b.res.status).toBe(201);
    expect(await count('subscriptions', 'user_id = ?', 'u2')).toBe(0);
    expect(ok(b.json).subscription.id).not.toBe('sub-evil');
  });

  it('a title with markup is stored and returned as text, untouched (the SPA escapes it)', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 2)));
    const { json } = await subscribe('u1', { url: FEED, title: '<img src=x onerror=alert(1)>' });
    expect(ok(json).subscription.title).toBe('<img src=x onerror=alert(1)>');
  });

  it('a request without the app Origin is refused (CSRF), and creates nothing', async () => {
    const { res } = await post('u1', JSON.stringify({ url: FEED }), {
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(await count('feeds')).toBe(0);
  });
});

describe('SSRF spellings', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0/',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://metadata.google.internal/',
    'http://foo.internal/',
    'http://foo.localhost/',
    'http://intranet/',
    'http://127.0.0.1.:80/',
    'HTTP://LOCALHOST/',
  ])('%s is 422 blocked_address, nothing fetched or created', async (url) => {
    const { res, json } = await subscribe('u1', { url });
    expect(res.status).toBe(422);
    expect(err(json).code).toBe('blocked_address');
    expect(await count('feeds')).toBe(0);
    expect(fx.fake.calls).toHaveLength(0);
  });

  it('a page whose only feed link points at a private address: the address is never requested', async () => {
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([link('http://169.254.169.254/latest/meta-data')]),
    });
    await subscribe('u1', { url: SITE });
    expect(fx.fake.calls.map((c) => c.url)).toEqual([SITE]);
  });

  // DEF-030: discovery hands the single discovered URL straight to createSubscription without the
  // address check, so a private feed row and subscription are created (the refresher then refuses
  // to fetch it, so no request leaves). Remove `.fails` when it is fixed.
  it.fails(
    'a page whose only feed link points at a private address must not create a subscription',
    async () => {
      fx.fake.route(SITE, {
        headers: HTML,
        body: page([link('http://169.254.169.254/latest/meta-data')]),
      });
      const { res, json } = await subscribe('u1', { url: SITE });
      expect(res.status).toBe(422);
      expect(err(json).code).toBe('blocked_address');
      expect(await count('feeds')).toBe(0);
      expect(await count('subscriptions')).toBe(0);
    },
  );

  it('a <base href> pointing at a private host does not redirect discovery: the relative link resolves against the page', async () => {
    fx.fake.route(SITE, {
      headers: HTML,
      body: `<!doctype html><html><head><base href="http://127.0.0.1/">${link('feed.xml')}</head></html>`,
    });
    await subscribe('u1', { url: SITE });
    expect(fx.fake.calls.every((c) => !c.url.includes('127.0.0.1'))).toBe(true);
  });
});

describe('canonicalisation of a discovered feed URL', () => {
  it('a page linking the feed with a different spelling is 409 for a feed the user already follows', async () => {
    fx.fake.serveFeed('https://blog.example.com/feed.xml', rss(items(1, 2)));
    const first = await subscribe('u1', { url: 'https://blog.example.com/feed.xml' });
    expect(first.res.status).toBe(201);
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([link('HTTPS://Blog.Example.com:443/feed.xml#top')]),
    });
    const { res, json } = await subscribe('u1', { url: SITE });
    expect(res.status).toBe(409);
    expect(err(json).code).toBe('already_subscribed');
    expect(await count('feeds')).toBe(1);
    expect(await count('subscriptions')).toBe(1);
  });

  it('two spellings of one feed URL never make two feed rows', async () => {
    fx.fake.serveFeed('https://blog.example.com/feed.xml', rss(items(1, 2)));
    fx.fake.route(SITE, {
      headers: HTML,
      body: page([link('https://Blog.Example.com:443/feed.xml#x')]),
    });
    await subscribe('u1', { url: SITE });
    await seedUser('u2');
    tokens.u2 = await seedSession('u2', { now: Math.floor(fx.clock.now() / 1000) });
    await subscribe('u2', { url: 'https://blog.example.com/feed.xml' });
    const { rows } = await db.all<{ url: string }>(sql('SELECT url FROM feeds ORDER BY id'));
    expect(rows.map((r) => r.url)).toEqual(['https://blog.example.com/feed.xml']);
  });
});

describe('races and size', () => {
  it('two concurrent subscribes to the same URL: one 201, one 409, one subscription', async () => {
    fx.fake.serveFeed(FEED, rss(items(1, 3)));
    const [a, b] = await Promise.all([
      subscribe('u1', { url: FEED }),
      subscribe('u1', { url: FEED }),
    ]);
    expect([a.res.status, b.res.status].sort()).toEqual([201, 409]);
    expect(await count('subscriptions', 'user_id = ?', 'u1')).toBe(1);
    expect(await count('feeds')).toBe(1);
  });

  it('a 6 MB HTML page is answered without a 5xx', async () => {
    fx.fake.route(SITE, {
      headers: HTML,
      body: `<html><body>${'x'.repeat(6_000_000)}</body></html>`,
    });
    const { res } = await subscribe('u1', { url: SITE });
    expect(res.status).toBeLessThan(500);
  });
});

describe('the limit is enforced in the insert too, not only in the pre-check', () => {
  it('createSubscription at the limit adds nothing (the race between the count and the insert)', async () => {
    await db.run(
      sql(
        "INSERT INTO feeds (id, url, next_fetch_at, state, created_at) VALUES (1, 'https://a.example.net/rss', 0, 'ok', 0)",
      ),
    );
    await db.run(
      sql("INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('s1', 'u1', 1, 0)"),
    );
    const created = await createSubscription(db, {
      userId: 'u1',
      subscriptionId: 's2',
      feedUrl: FEED,
      folderId: null,
      titleOverride: null,
      now: 1000,
      jitterS: 0,
      limit: 1,
    });
    expect(created).toBe(false);
    expect(await count('subscriptions', 'user_id = ?', 'u1')).toBe(1);
  });
});

describe('sniffing', () => {
  // DEF-031: a feed served as text/plain whose root element comes after 4 KB of prolog is read as
  // "not a feed" because only the first 4 KB are sniffed. Remove `.fails` when it is fixed.
  it.fails('a text/plain feed with a long comment before <rss> is still subscribed', async () => {
    fx.fake.route(FEED, {
      headers: { 'Content-Type': 'text/plain' },
      body: `<?xml version="1.0"?><!--${'x'.repeat(5000)}-->${rss(items(1, 3))}`,
    });
    const { res } = await subscribe('u1', { url: FEED });
    expect(res.status).toBe(201);
  });
});
