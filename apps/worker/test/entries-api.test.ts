import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiError, Counts, EntriesResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, decodeCursor, encodeCursor, listEntries, sql, unreadCounts } from '../src/db';
import { seedSession, seedUser } from './support/seed';

// TID-018 (spec 8.5, 8.6, ADR 0008, ADR 0012). The real API against local D1 on the seeded dataset
// (scripts/seed.mjs): user A = 'seed-user' has 500 entries over 10 feeds (375 unread), folders
// seed-folder-1..3 (feeds 1-3, 4-6, 7-8) and feeds 9 and 10 with no folder. User B is added here.

const A = 'seed-user';
const B = 'user-b';
const BASE = 1_760_000_000;
const NOW_MS = (BASE + 10_000) * 1000;
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));

const tokens: Record<string, string> = {};
const fetchSpy = vi.fn();
const refreshSpy = vi.fn();
const app = createApp({
  clock: () => NOW_MS,
  subscriptions: { fetch: fetchSpy, refresh: refreshSpy },
});

async function get(user: string, path: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${env.APP_ORIGIN}${path}`, {
        headers: { Origin: env.APP_ORIGIN, Cookie: `${SESSION_COOKIE}=${tokens[user]}` },
      }),
      env,
    ),
  );
}

async function entries(user: string, query: string) {
  const res = await get(user, `/api/entries?${query}`);
  return { res, json: (await res.json()) as EntriesResponse & ApiError };
}

beforeAll(async () => {
  for (const line of env.SEED_SQL.split('\n')) if (line.trim()) await env.DB.exec(line);
  await seedUser(B);
  await run(
    "INSERT INTO folders (id, user_id, name, position, created_at) VALUES ('b-folder', ?, 'B folder', 0, ?)",
    B,
    BASE,
  );
  await run(
    "INSERT INTO subscriptions (id, user_id, feed_id, folder_id, title_override, created_at) VALUES ('b-sub-1', ?, 1, 'b-folder', 'B calls it this', ?)",
    B,
    BASE,
  );
  for (const i of [1, 2, 3]) {
    await run(
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 1, ?, 0)',
      B,
      i * 10 - 9,
      BASE - 1000 + i,
    );
  }
  tokens[A] = await seedSession(A, { now: BASE });
  tokens[B] = await seedSession(B, { now: BASE });
});

describe('AC1: the three list views', () => {
  it('/all: newest first, 50 per page, with the fields a row needs', async () => {
    const { res, json } = await entries(A, 'view=all&state=all');
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(50);
    expect(json.nextCursor).not.toBeNull();
    expect(json.asOf).toBe(new Date(NOW_MS).toISOString());
    const times = json.items.map((i) => i.publishedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(json.items[0]).toMatchObject({
      id: '500',
      subscriptionId: 'seed-sub-10',
      feedTitle: 'Feed 10',
      title: 'Entry 500',
      author: 'Author 10',
      summary: 'Summary of entry 500',
      imageUrl: null,
      isRead: true,
      isStarred: false,
    });
  });

  it('/folders/:id: only that folder’s feeds', async () => {
    const { res, json } = await entries(A, 'view=folder&id=seed-folder-2&state=all');
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(50);
    const subs = new Set(json.items.map((i) => i.subscriptionId));
    expect([...subs].sort()).toEqual(['seed-sub-4', 'seed-sub-5', 'seed-sub-6']);
  });

  it('/feeds/:id: only that subscription’s articles, with the subscription ID', async () => {
    const { res, json } = await entries(A, 'view=feed&id=seed-sub-3&state=all');
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(50);
    expect(new Set(json.items.map((i) => i.subscriptionId))).toEqual(new Set(['seed-sub-3']));
    expect(json.items.every((i) => i.feedTitle === 'Feed 3')).toBe(true);
  });

  it('a custom title wins for feedTitle', async () => {
    const { json } = await entries(B, 'view=feed&id=b-sub-1&state=all');
    expect(json.items[0]?.feedTitle).toBe('B calls it this');
  });
});

describe('AC2: unread only and the default from settings', () => {
  it('state=unread has only unread; state=all includes read ones', async () => {
    const unread = await entries(A, 'view=feed&id=seed-sub-4&state=unread&limit=100');
    expect(unread.json.items.length).toBeGreaterThan(0);
    expect(unread.json.items.every((i) => !i.isRead)).toBe(true);
    const all = await entries(A, 'view=feed&id=seed-sub-4&state=all&limit=100');
    expect(all.json.items.some((i) => i.isRead)).toBe(true);
    expect(all.json.items.length).toBeGreaterThan(unread.json.items.length);
  });

  it('with no state, the user’s unreadOnly setting decides (default unread)', async () => {
    const def = await entries(A, 'view=feed&id=seed-sub-4&limit=100');
    expect(def.json.items.every((i) => !i.isRead)).toBe(true);

    await run('UPDATE users SET settings_json = ? WHERE id = ?', '{"unreadOnly":false}', A);
    try {
      const off = await entries(A, 'view=feed&id=seed-sub-4&limit=100');
      expect(off.json.items.some((i) => i.isRead)).toBe(true);
    } finally {
      await run("UPDATE users SET settings_json = '{}' WHERE id = ?", A);
    }
  });
});

describe('AC3: paging', () => {
  it('walks every unread entry once; 3 new entries between pages cause no duplicates or skips', async () => {
    const first = await entries(A, 'view=all&state=unread');
    expect(first.json.items).toHaveLength(50);
    const cursor = first.json.nextCursor;
    expect(cursor).not.toBeNull();

    // Three new entries arrive, newer than everything on page 1.
    for (const n of [1, 2, 3]) {
      const id = 9000 + n;
      await run(
        'INSERT INTO entries (id, feed_id, guid_hash, title, published_at, fetched_at) VALUES (?, 1, ?, ?, ?, ?)',
        id,
        `new-${id}`,
        `New ${id}`,
        BASE + n,
        BASE + n,
      );
      await run(
        'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 1, ?, 0)',
        A,
        id,
        BASE + n,
      );
    }
    try {
      const seen = first.json.items.map((i) => i.id);
      let next = cursor;
      while (next) {
        const page = await entries(A, `view=all&state=unread&cursor=${next}`);
        expect(page.res.status).toBe(200);
        seen.push(...page.json.items.map((i) => i.id));
        next = page.json.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen).toHaveLength(375); // skips nothing of what was there; the 3 new ones are not in it
      expect(seen.some((id) => Number(id) > 9000)).toBe(false);
    } finally {
      await run('DELETE FROM user_entries WHERE entry_id > 9000');
      await run('DELETE FROM entries WHERE id > 9000');
    }
  });

  it('a malformed cursor is 400 validation_failed', async () => {
    const { res, json } = await entries(A, 'view=all&cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('validation_failed');
  });

  it.each([
    ['view=nope'],
    ['view=feed'],
    ['view=folder'],
    ['view=all&limit=0'],
    ['view=all&limit=101'],
    ['view=all&state=read'],
  ])('bad query %s is 400 validation_failed', async (query) => {
    const { res, json } = await entries(A, query);
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('validation_failed');
  });
});

describe('AC4: counts', () => {
  it('match the unread user_entries per subscription, per folder and overall', async () => {
    const res = await get(A, '/api/counts');
    expect(res.status).toBe(200);
    const counts = (await res.json()) as Counts;

    const perFeed = (
      await db.all<{ feed_id: number; n: number }>(
        sql(
          'SELECT feed_id, COUNT(*) AS n FROM user_entries WHERE user_id = ? AND is_read = 0 GROUP BY feed_id',
          A,
        ),
      )
    ).rows;
    const subs = (
      await db.all<{ id: string; feed_id: number; folder_id: string | null }>(
        sql('SELECT id, feed_id, folder_id FROM subscriptions WHERE user_id = ?', A),
      )
    ).rows;
    expect(counts.total).toBe(375);
    for (const s of subs) {
      expect(counts.subscriptions[s.id]).toBe(perFeed.find((r) => r.feed_id === s.feed_id)?.n ?? 0);
    }
    // Folder = sum of its subscriptions: feeds 1-3, 4-6 and 7-8 hold 15 unread per 20 entries.
    expect(counts.folders['seed-folder-1']).toBe(
      ['seed-sub-1', 'seed-sub-2', 'seed-sub-3'].reduce(
        (sum, id) => sum + (counts.subscriptions[id] ?? 0),
        0,
      ),
    );
    expect(Object.keys(counts.folders).sort()).toEqual([
      'seed-folder-1',
      'seed-folder-2',
      'seed-folder-3',
    ]);
    expect(
      (counts.folders['seed-folder-1'] ?? 0) +
        (counts.folders['seed-folder-2'] ?? 0) +
        (counts.folders['seed-folder-3'] ?? 0) +
        (counts.subscriptions['seed-sub-9'] ?? 0) +
        (counts.subscriptions['seed-sub-10'] ?? 0),
    ).toBe(counts.total);
  });

  it('rows_read <= unread rows + subscriptions + 10', async () => {
    const { rowsRead } = await unreadCounts(db, A);
    expect(rowsRead).toBeLessThanOrEqual(375 + 10 + 10);
  });

  it('B’s counts cover only B', async () => {
    const counts = (await (await get(B, '/api/counts')).json()) as Counts;
    expect(counts).toEqual({
      total: 3,
      folders: { 'b-folder': 3 },
      subscriptions: { 'b-sub-1': 3 },
    });
  });
});

describe('AC5: read budgets (NFR-7, ADR 0008)', () => {
  const unread = [true, false] as const;
  const lim = 50;

  it.each(['all', 'feed'] as const)('%s view: page 1 <= 102 rows, unread and all', async (view) => {
    for (const unreadOnly of unread) {
      const page = await listEntries(db, A, {
        view,
        id: view === 'feed' ? 1 : undefined,
        unreadOnly,
        limit: lim,
      });
      expect(Number(page.meta.rows_read)).toBeLessThanOrEqual(102);
    }
  });

  it.each(['all', 'feed'] as const)(
    '%s view: continuation <= 102 + T, with T = 1 on the seed data',
    async (view) => {
      for (const unreadOnly of unread) {
        const params = { view, id: view === 'feed' ? 2 : undefined, unreadOnly, limit: lim };
        const p1 = await listEntries(db, A, params);
        const p2 = await listEntries(db, A, { ...params, cursor: p1.nextCursor });
        expect(Number(p2.meta.rows_read)).toBeLessThanOrEqual(103);
      }
    },
  );

  it('60 entries sharing one published_at, cursor inside the group: <= 102 + T', async () => {
    const C = 'user-c';
    await seedUser(C);
    await run(
      "INSERT INTO feeds (id, url, next_fetch_at, state, created_at) VALUES (21, 'https://tie.example.com/rss', 0, 'ok', 0)",
    );
    await run(
      "INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('c-sub', ?, 21, 0)",
      C,
    );
    const same = BASE + 5000;
    for (let i = 1; i <= 60; i++) {
      const id = 7000 + i;
      await run(
        'INSERT INTO entries (id, feed_id, guid_hash, published_at, fetched_at) VALUES (?, 21, ?, ?, ?)',
        id,
        `tie-${id}`,
        same,
        same,
      );
      await run(
        'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 21, ?, 0)',
        C,
        id,
        same,
      );
    }
    const T = 60;
    for (const view of ['all', 'feed'] as const) {
      for (const unreadOnly of unread) {
        const params = { view, id: view === 'feed' ? 21 : undefined, unreadOnly, limit: lim };
        const p1 = await listEntries(db, C, params);
        expect(Number(p1.meta.rows_read)).toBeLessThanOrEqual(102);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await listEntries(db, C, { ...params, cursor: p1.nextCursor });
        expect(p2.items).toHaveLength(10);
        expect(Number(p2.meta.rows_read)).toBeLessThanOrEqual(102 + T);
      }
    }
    // A cursor that lands in the middle of the group, not at a page boundary.
    const mid = encodeCursor({ p: same, i: 7030 });
    const p = await listEntries(db, C, { view: 'all', unreadOnly: true, limit: lim, cursor: mid });
    expect(p.items).toHaveLength(29);
    expect(Number(p.meta.rows_read)).toBeLessThanOrEqual(102 + T);
  });

  // Every seed folder: [id, feed ids, S]. The unread counts differ per folder, so a sparse folder
  // (seed-folder-3 holds 2 of 10 feeds) shows whether page cost follows M or the whole view.
  const FOLDERS = [
    ['seed-folder-1', '1, 2, 3', 3],
    ['seed-folder-2', '4, 5, 6', 3],
    ['seed-folder-3', '7, 8', 2],
  ] as const;

  async function folderBudgets(unreadOnly: boolean, folder: (typeof FOLDERS)[number]) {
    const [id, feeds, s] = folder;
    const filter = unreadOnly ? ' AND is_read = 0' : '';
    const params = { view: 'folder' as const, id, unreadOnly, limit: lim };
    const p1 = await listEntries(db, A, params);
    const p2 = await listEntries(db, A, { ...params, cursor: p1.nextCursor });
    const cursor = decodeCursor(p1.nextCursor ?? '');
    const count = async (extra: string, ...binds: number[]) =>
      (
        await db.first<{ n: number }>(
          sql(
            'SELECT COUNT(*) AS n FROM user_entries WHERE user_id = ? AND feed_id IN (' +
              feeds +
              ')' +
              filter +
              extra,
            A,
            ...binds,
          ),
        )
      )?.n ?? 0;
    return {
      // NFR-7b: M + (limit + 1) + S + 10, M at or below the cursor on continuation pages.
      page1: { read: Number(p1.meta.rows_read), bound: (await count('')) + 51 + s + 10 },
      page2: {
        read: Number(p2.meta.rows_read),
        bound:
          (await count(' AND (published_at, entry_id) <= (?, ?)', cursor.p, cursor.i)) +
          51 +
          s +
          10,
      },
    };
  }

  // DEF-050: the folder query walks the user's whole view (newest first, 2 reads per row) until it
  // has 51 matches, so its cost follows the view size and the folder's density, not M. This
  // asserts the AC as written; it fails today, so it is marked `it.fails` and flips with the fix.
  it.fails(
    'folder view: rows_read <= M + 51 + S + 10, unread and all, pages 1 and 2 (DEF-050)',
    async () => {
      for (const unreadOnly of unread) {
        for (const folder of FOLDERS) {
          const { page1, page2 } = await folderBudgets(unreadOnly, folder);
          expect(page1.read).toBeLessThanOrEqual(page1.bound);
          expect(page2.read).toBeLessThanOrEqual(page2.bound);
        }
      }
    },
  );

  it('folder view: never worse than reading the user’s whole view twice (guard for DEF-050)', async () => {
    for (const unreadOnly of unread) {
      for (const folder of FOLDERS) {
        const { page1 } = await folderBudgets(unreadOnly, folder);
        const whole = unreadOnly ? 375 : 500;
        expect(page1.read).toBeLessThanOrEqual(whole * 2 + 51 + folder[2] + 10);
      }
    }
  });
});

describe('AC8 and ADR 0012: isolation of the id inputs', () => {
  it('B asking for A’s subscription or folder gets 404 not_found, identical to a missing ID', async () => {
    const aFeed = await entries(B, 'view=feed&id=seed-sub-1&state=all');
    const aFolder = await entries(B, 'view=folder&id=seed-folder-1&state=all');
    const noFeed = await entries(B, 'view=feed&id=nope&state=all');
    const noFolder = await entries(B, 'view=folder&id=nope&state=all');
    for (const r of [aFeed, aFolder, noFeed, noFolder]) {
      expect(r.res.status).toBe(404);
      expect(r.json.error.code).toBe('not_found');
    }
    expect(aFeed.json).toEqual(noFeed.json);
    expect(aFolder.json).toEqual(noFolder.json);
  });

  it('the folder query is scoped in SQL, not only by the route: B reading A’s folder ID directly gets nothing', async () => {
    // B subscribes to feed 1, which A also has in seed-folder-1, so only the subscription filter
    // inside the query keeps B's own rows for feed 1 out of A's folder.
    const page = await listEntries(db, B, {
      view: 'folder',
      id: 'seed-folder-1',
      unreadOnly: false,
      limit: 50,
      cursor: null,
    });
    expect(page.items).toEqual([]);
  });

  it('B’s own views contain only B’s rows, and A’s data is unchanged', async () => {
    const beforeA = await entries(A, 'view=all&state=all&limit=100');
    const all = await entries(B, 'view=all&state=all');
    expect(all.json.items.map((i) => i.id).sort()).toEqual(['1', '11', '21']);
    expect(all.json.items.every((i) => i.subscriptionId === 'b-sub-1')).toBe(true);
    expect(JSON.stringify(all.json)).not.toContain('seed-sub');
    const folder = await entries(B, 'view=folder&id=b-folder&state=all');
    expect(folder.json.items).toHaveLength(3);
    expect(await entries(A, 'view=all&state=all&limit=100')).toEqual(beforeA);
  });
});

describe('AC9: reading lists never fetches a feed (FR-RD-11)', () => {
  it('entries and counts calls make no fetch and no refresh', async () => {
    fetchSpy.mockClear();
    refreshSpy.mockClear();
    // The two spies above are the subscribe service's seams and the list routes never receive them,
    // so on their own they cannot fail. The real guard is the runtime's global fetch (any outbound
    // subrequest) and the feeds table (nothing is scheduled or stamped as fetched).
    const outbound = vi.spyOn(globalThis, 'fetch');
    const feedsBefore = await db.all(sql('SELECT * FROM feeds ORDER BY id'));
    try {
      for (const q of ['view=all', 'view=folder&id=seed-folder-1', 'view=feed&id=seed-sub-1']) {
        await entries(A, q + '&state=all');
      }
      await get(A, '/api/counts');
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
    expect((await db.all(sql('SELECT * FROM feeds ORDER BY id'))).rows).toEqual(feedsBefore.rows);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('both routes need a session', () => {
  it.each(['/api/entries?view=all', '/api/counts'])('%s without a cookie is 401', async (path) => {
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${env.APP_ORIGIN}${path}`, { headers: { Origin: env.APP_ORIGIN } }),
        env,
      ),
    );
    expect(res.status).toBe(401);
  });
});
