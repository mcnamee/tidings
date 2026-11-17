import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiError,
  Folder,
  ImportFeed,
  ImportOpmlRequest,
  ImportOpmlResponse,
  SubscriptionsResponse,
} from '@tidings/shared';
import { DAY, MINUTE } from '@tidings/test-utils';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, sql } from '../src/db';
import { PARKED_AT, refreshFeed } from '../src/refresh';
import {
  count,
  createFixture,
  db,
  feedRow,
  jobFor,
  resetData,
  rss,
  type Fixture,
} from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-016: OPML import (spec 8.7, FR-OP-1 to FR-OP-4, ADR 0013 decision 5). The API runs for real
// in workerd against local D1. The browser's parsing and chunking are tested in the web package.

let fx: Fixture;
let tokens: Record<string, string>;
const nowS = () => Math.floor(fx.clock.now() / 1000);

function app() {
  return createApp({
    clock: () => fx.clock.now(),
    subscriptions: { fetch: fx.fake.fetch as never, random: () => 0.5 },
  });
}

async function call(user: string | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  const headers = new Headers({ Origin: env.APP_ORIGIN });
  if (user) headers.set('Cookie', `${SESSION_COOKIE}=${tokens[user]}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return app().fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function importOpml(user: string, body: ImportOpmlRequest) {
  const res = await call(user, 'POST', '/api/import/opml', body);
  return { res, json: (await res.json()) as ImportOpmlResponse };
}

const feed = (n: number, title?: string): ImportFeed => ({
  xmlUrl: `https://f${n}.example.com/feed.xml`,
  ...(title ? { title } : {}),
});
const feeds = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => feed(from + i));

/** The 250-feed fixture shape: 18 folders, a few unfiled, sent in chunks of at most 100. */
function inChunks(all: ImportFeed[], size = 100): ImportOpmlRequest[] {
  const out: ImportOpmlRequest[] = [];
  for (let i = 0; i < all.length; i += size) {
    const part = all.slice(i, i + size);
    const folders = new Map<string, ImportFeed[]>();
    const unfiled: ImportFeed[] = [];
    part.forEach((f, k) => {
      const idx = (i + k) % 20;
      if (idx >= 18) unfiled.push(f);
      else folders.set(`Folder ${idx}`, [...(folders.get(`Folder ${idx}`) ?? []), f]);
    });
    out.push({
      folders: [...folders].map(([name, fs]) => ({ name, feeds: fs })),
      feeds: unfiled,
    });
  }
  return out;
}

async function addUser(id: string) {
  await seedUser(id);
  tokens[id] = await seedSession(id, { now: nowS() });
}

beforeEach(async () => {
  await resetData();
  fx = createFixture();
  tokens = {};
  await addUser('u1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const subscriptions = async (user = 'u1') =>
  ((await (await call(user, 'GET', '/api/subscriptions')).json()) as SubscriptionsResponse).items;
const folders = async (user = 'u1') =>
  ((await (await call(user, 'GET', '/api/folders')).json()) as { items: Folder[] }).items;

describe('AC2: subscribed into the top-level folders, first folder wins', () => {
  it('creates folders by name, files the feeds, keeps the title, and the first folder wins', async () => {
    const dup = feed(1);
    const { res, json } = await importOpml('u1', {
      folders: [
        { name: 'News', feeds: [dup, feed(2, ' Two  ')] },
        { name: 'Tech', feeds: [dup, feed(3)] }, // feed 1 again: stays in News
        { name: 'news', feeds: [feed(4)] }, // same folder, different case
      ],
      feeds: [feed(5)],
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({ created: 5, existing: 0, deferred: 0, invalid: [] });

    const fl = await folders();
    expect(fl.map((f) => f.name).sort()).toEqual(['News', 'Tech']);
    const byId = new Map(fl.map((f) => [f.id, f.name]));
    const where = Object.fromEntries(
      (await subscriptions()).map((s) => [s.feedUrl, byId.get(s.folderId ?? '') ?? null]),
    );
    expect(where).toEqual({
      'https://f1.example.com/feed.xml': 'News',
      'https://f2.example.com/feed.xml': 'News',
      'https://f3.example.com/feed.xml': 'Tech',
      'https://f4.example.com/feed.xml': 'News',
      'https://f5.example.com/feed.xml': null,
    });
    const two = (await subscriptions()).find((s) => s.feedUrl.includes('f2.'));
    expect(two?.title).toBe('Two');
  });

  it('accepts at most 100 feeds per request', async () => {
    const res = await call('u1', 'POST', '/api/import/opml', {
      folders: [{ name: 'A', feeds: feeds(1, 60) }],
      feeds: feeds(61, 101),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe('validation_failed');
    expect(await count('subscriptions')).toBe(0);
    expect((await call('u1', 'POST', '/api/import/opml', { nope: 1 })).status).toBe(400);
  });

  it('a 100-feed request stays far below the subrequest limit and uses set-based writes', async () => {
    let queries = 0;
    for (const m of ['all', 'first', 'run', 'batch'] as const) {
      const original = Db.prototype[m] as (...a: unknown[]) => unknown;
      vi.spyOn(Db.prototype, m as 'all').mockImplementation(function (this: Db, ...a: unknown[]) {
        queries += 1;
        return original.apply(this, a) as never;
      } as never);
    }
    const [first] = inChunks(feeds(1, 100));
    const { json } = await importOpml('u1', first!);
    expect(json.created).toBe(100);
    expect(queries).toBeLessThanOrEqual(15); // the free plan allows 50 per invocation
  });
});

describe('AC3: nothing is fetched during import; first fetches are staggered 20 a minute', () => {
  it('never calls fetch, and every new feed is due within ceil(n / 20) minutes', async () => {
    const outbound = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    vi.stubGlobal('fetch', outbound);
    const all = feeds(1, 250);
    for (const req of inChunks(all)) await importOpml('u1', req);

    expect(outbound).not.toHaveBeenCalled();
    expect(fx.fake.calls).toHaveLength(0);
    const { rows } = await db.all<{ next_fetch_at: number; state: string }>(
      sql('SELECT next_fetch_at, state FROM feeds'),
    );
    expect(rows).toHaveLength(250);
    const t = nowS();
    for (const r of rows) {
      expect(r.state).toBe('pending');
      expect(r.next_fetch_at).toBeGreaterThanOrEqual(t);
      expect(r.next_fetch_at).toBeLessThan(t + Math.ceil(250 / 20) * 60);
    }
    // 20 a minute: no minute holds more than 20 feeds.
    const perMinute = new Map<number, number>();
    for (const r of rows) {
      const m = Math.floor((r.next_fetch_at - t) / 60);
      perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
    }
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(20);
  });
});

describe('AC5: importing the same file again', () => {
  it('creates nothing, duplicates no folder, and reports every feed as existing', async () => {
    const reqs = inChunks(feeds(1, 120));
    for (const r of reqs) await importOpml('u1', r);
    const folderCount = await count('folders');
    const subCount = await count('subscriptions');

    const again = [];
    for (const r of reqs) again.push((await importOpml('u1', r)).json);
    expect(again.reduce((n, j) => n + j.created, 0)).toBe(0);
    expect(again.reduce((n, j) => n + j.existing, 0)).toBe(120);
    expect(await count('folders')).toBe(folderCount);
    expect(await count('subscriptions')).toBe(subCount);
  });
});

describe('AC6: invalid and private addresses are reported, the rest imports', () => {
  it('reports invalid_url and blocked_address per feed', async () => {
    const { res, json } = await importOpml('u1', {
      folders: [
        {
          name: 'Mixed',
          feeds: [
            feed(1),
            { xmlUrl: 'not a url' },
            { xmlUrl: 'ftp://f9.example.com/feed.xml' },
            { xmlUrl: 'http://127.0.0.1/feed.xml' },
            { xmlUrl: 'http://10.0.0.5/rss' },
            { xmlUrl: 'http://localhost:8080/rss' },
            { xmlUrl: 'https://user:pw@f8.example.com/feed.xml' },
          ],
        },
      ],
      feeds: [],
    });
    expect(res.status).toBe(200);
    expect(json.created).toBe(1);
    const reasons = Object.fromEntries(json.invalid.map((i) => [i.url, i.reason]));
    expect(reasons).toMatchObject({
      'not a url': 'invalid_url',
      'ftp://f9.example.com/feed.xml': 'invalid_url',
      'http://127.0.0.1/feed.xml': 'blocked_address',
      'http://10.0.0.5/rss': 'blocked_address',
      'http://localhost:8080/rss': 'blocked_address',
      'https://user:pw@f8.example.com/feed.xml': 'invalid_url',
    });
    expect(await count('feeds')).toBe(1);
  });

  it('reports what does not fit under the 1,000-subscription limit as limit_reached', async () => {
    await db.run(
      sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 998)
           INSERT INTO feeds (url, next_fetch_at, state, created_at)
           SELECT 'https://seed' || i || '.example.com/f.xml', ${PARKED_AT}, 'ok', 0 FROM n`),
    );
    await db.run(
      sql(`INSERT INTO subscriptions (id, user_id, feed_id, created_at)
           SELECT 's' || id, 'u1', id, 0 FROM feeds`),
    );
    const { json } = await importOpml('u1', { folders: [], feeds: feeds(1, 5) });
    expect(json.created).toBe(2);
    expect(json.invalid.map((i) => i.reason)).toEqual([
      'limit_reached',
      'limit_reached',
      'limit_reached',
    ]);
    expect(await count('subscriptions')).toBe(1000);
  });
});

describe('AC8: write cost of 250 imported feeds with 50 items each, then their first fetches', () => {
  it('writes no more than 53,000 rows in total', async () => {
    // Count the import's own writes through D1's per-batch meta.
    let importRows = 0;
    const real = env.DB;
    const counting = new Proxy(real, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const r of results) importRows += Number(r.meta.rows_written ?? 0);
            return results;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const countingEnv = { ...env, DB: counting } as typeof env;
    for (const body of inChunks(feeds(1, 250))) {
      const res = await createApp({ clock: () => fx.clock.now() }).fetch(
        new Request(`${env.APP_ORIGIN}/api/import/opml`, {
          method: 'POST',
          headers: {
            Origin: env.APP_ORIGIN,
            Cookie: `${SESSION_COOKIE}=${tokens.u1}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        countingEnv,
      );
      expect(res.status).toBe(200);
    }

    let fetchRows = 0;
    const { rows } = await db.all<{ id: number }>(sql('SELECT id FROM feeds ORDER BY id'));
    expect(rows).toHaveLength(250);
    for (const { id } of rows) {
      const f = await feedRow(id);
      const items = Array.from({ length: 50 }, (_, k) => ({ guid: `${id}-${k}`, ageH: k + 1 }));
      fx.fake.serveFeed(f.url, rss(items), { etag: `"e${id}"` });
      fetchRows += (await refreshFeed(await jobFor(id), fx.deps)).usage.rowsWritten;
    }
    const total = importRows + fetchRows;
    console.log(`TID-016 AC8: import ${importRows} + first fetches ${fetchRows} = ${total} rows`);
    expect(await count('entries')).toBe(250 * 50);
    expect(total).toBeLessThanOrEqual(53_000);
  }, 180_000);
});

describe('AC9: 250 import first fetches per UTC day, the rest from 00:05 UTC tomorrow', () => {
  const tomorrow = () => (Math.floor(nowS() / 86400) + 1) * 86400;

  it('a 300-feed import schedules 250 today and defers 50', async () => {
    const results: ImportOpmlResponse[] = [];
    for (const req of inChunks(feeds(1, 300))) results.push((await importOpml('u1', req)).json);
    expect(results.reduce((n, j) => n + j.created, 0)).toBe(300);
    expect(results.reduce((n, j) => n + j.deferred, 0)).toBe(50);

    const { rows } = await db.all<{ next_fetch_at: number }>(
      sql('SELECT next_fetch_at FROM feeds ORDER BY next_fetch_at'),
    );
    const today = rows.filter((r) => r.next_fetch_at < tomorrow());
    const later = rows.filter((r) => r.next_fetch_at >= tomorrow());
    expect(today).toHaveLength(250);
    expect(later).toHaveLength(50);
    // From 00:05, 20 a minute: 50 feeds fit in minutes 0 to 2.
    for (const r of later) {
      expect(r.next_fetch_at).toBeGreaterThanOrEqual(tomorrow() + 300);
      expect(r.next_fetch_at).toBeLessThan(tomorrow() + 300 + 3 * 60);
    }
  });

  it('a later import the same day is deferred entirely; the next day the budget is fresh', async () => {
    for (const req of inChunks(feeds(1, 250))) await importOpml('u1', req);
    const more = await importOpml('u1', { folders: [], feeds: feeds(251, 270) });
    expect(more.json).toMatchObject({ created: 20, deferred: 20 });

    // Tomorrow's 20 are already booked, so 230 more fit before the cap moves on again.
    fx.clock.advance(DAY);
    const next = await importOpml('u1', { folders: [], feeds: feeds(271, 370) });
    expect(next.json.created).toBe(100);
    // 20 pending feeds from yesterday are due today, plus 100 new: all within today's 250.
    expect(next.json.deferred).toBe(0);
  });

  it('a feed another user already follows is not re-scheduled or counted', async () => {
    await addUser('u2');
    await importOpml('u2', { folders: [], feeds: [feed(1)] });
    const before = await db.first<{ next_fetch_at: number }>(
      sql("SELECT next_fetch_at FROM feeds WHERE url = 'https://f1.example.com/feed.xml'"),
    );
    fx.clock.advance(10 * MINUTE);
    const { json } = await importOpml('u1', { folders: [], feeds: [feed(1)] });
    expect(json).toMatchObject({ created: 1, deferred: 0 });
    const after = await db.first<{ next_fetch_at: number }>(
      sql("SELECT next_fetch_at FROM feeds WHERE url = 'https://f1.example.com/feed.xml'"),
    );
    expect(after?.next_fetch_at).toBe(before?.next_fetch_at);
  });

  it('a parked or dead feed comes back as pending, due at its slot', async () => {
    await addUser('u2');
    await importOpml('u2', { folders: [], feeds: feeds(1, 2) });
    await db.run(sql(`UPDATE feeds SET next_fetch_at = ${PARKED_AT}`));
    await db.run(
      sql("UPDATE feeds SET state = 'dead', error_count = 7 WHERE url LIKE 'https://f2.%'"),
    );
    await db.run(sql('DELETE FROM subscriptions'));
    await importOpml('u1', { folders: [], feeds: feeds(1, 2) });
    const { rows } = await db.all<{ state: string; error_count: number; next_fetch_at: number }>(
      sql('SELECT state, error_count, next_fetch_at FROM feeds'),
    );
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'pending', error_count: 0 });
      expect(r.next_fetch_at).toBeLessThan(nowS() + 120);
    }
  });
});

describe('isolation (spec 10.8, ADR 0012)', () => {
  it('needs a session', async () => {
    const res = await call(null, 'POST', '/api/import/opml', { folders: [], feeds: [] });
    expect(res.status).toBe(401);
  });

  it("one user's import never reads or changes another user's folders or subscriptions", async () => {
    await addUser('u2');
    await importOpml('u1', { folders: [{ name: 'News', feeds: [feed(1)] }], feeds: [] });
    const a = await folders('u1');

    const { json } = await importOpml('u2', {
      folders: [{ name: 'News', feeds: [feed(1), feed(2)] }],
      feeds: [],
    });
    // Folder names are matched within the caller's own folders: u2 gets a folder of its own.
    expect(json).toMatchObject({ created: 2, existing: 0 });
    const b = await folders('u2');
    expect(b).toHaveLength(1);
    expect(b[0]?.id).not.toBe(a[0]?.id);
    expect(await folders('u1')).toEqual(a);
    expect(await subscriptions('u1')).toHaveLength(1);
    expect((await subscriptions('u2')).every((s) => s.folderId === b[0]?.id)).toBe(true);
    expect(await count('feeds')).toBe(2); // the shared feed row is reused
  });
});
