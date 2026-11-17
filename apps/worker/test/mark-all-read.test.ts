import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiError, MarkAllReadResponse, ReadStateResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, markAllRead, sql } from '../src/db';
import { seedSession, seedUser } from './support/seed';

// TID-020 (FR-RD-9, spec 8.5, 9.4, 10.8). The real API against local D1 on the seeded dataset
// (apps/worker/scripts/seed.mjs): user A = 'seed-user' owns entries 1 to 500 (every 4th is read),
// published at or before BASE; feeds 4-6 are in seed-folder-2, feed 1 is seed-sub-1. User B has
// entries 1, 11 and 21 only. User C has 2,000 unread entries (published BASE-1 down to BASE-2000)
// for the write-budget and Undo-limit tests.

const A = 'seed-user';
const B = 'user-b';
const C = 'user-c';
const BASE = 1_760_000_000;
const NOW = BASE + 10_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const AS_OF = iso(BASE);
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));
const tokens: Record<string, string> = {};
const app = createApp({ clock: () => NOW * 1000 });

async function call(user: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
  });
  if (method !== 'GET') headers.set('Content-Type', 'application/json');
  const res = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  return { res, json: text ? (JSON.parse(text) as unknown) : null };
}
const markAll = (user: string, body: unknown) =>
  call(user, 'POST', '/api/entries/mark-all-read', body);
const code = (json: unknown) => (json as ApiError).error.code;
const numeric = (ids: string[] | null) => (ids ?? []).map(Number).sort((a, b) => a - b);

/** IDs of a user's unread entries, limited by a SQL condition on user_entries. */
async function unread(user: string, where = '1 = 1', ...p: (string | number)[]) {
  const { rows } = await db.all<{ entry_id: number }>(
    sql(
      'SELECT entry_id FROM user_entries WHERE user_id = ? AND is_read = 0 AND ' +
        where +
        ' ORDER BY entry_id',
      user,
      ...p,
    ),
  );
  return rows.map((r) => r.entry_id);
}
const FOLDER2 = 'feed_id IN (4, 5, 6)';
const resetC = () =>
  run('UPDATE user_entries SET is_read = 0, read_at = NULL WHERE user_id = ?', C);

beforeAll(async () => {
  for (const line of env.SEED_SQL.split('\n')) if (line.trim()) await env.DB.exec(line);
  await seedUser(B);
  await seedUser(C);
  for (const [id, user] of [
    ['b-sub-1', B],
    ['c-sub-1', C],
  ] as const) {
    await run(
      'INSERT INTO subscriptions (id, user_id, feed_id, title_override, created_at) VALUES (?, ?, 1, NULL, ?)',
      id,
      user,
      BASE,
    );
  }
  for (const i of [1, 11, 21]) {
    await run(
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 1, ?, 0)',
      B,
      i,
      BASE - 1000 + i,
    );
  }
  const gen = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) ';
  await run(
    gen +
      "INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at) SELECT 10000 + i, 1, 'c-guid-' || i, 'https://feed1.example.com/c/' || i, 'C ' || i, ? - i, ? FROM n",
    BASE,
    BASE,
  );
  await run(
    gen +
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) SELECT ?, 10000 + i, 1, ? - i, 0 FROM n',
    C,
    BASE,
  );
  tokens[A] = await seedSession(A, { now: BASE });
  tokens[B] = await seedSession(B, { now: BASE });
  tokens[C] = await seedSession(C, { now: BASE });
});

describe('POST /api/entries/mark-all-read: request checks', () => {
  it('rejects a missing or bad before, a missing id, a bad view and unknown keys with 400', async () => {
    const before = await unread(A);
    for (const body of [
      { view: 'all' },
      { view: 'all', before: 'yesterday' },
      { view: 'all', before: 123 },
      { view: 'folder', before: AS_OF },
      { view: 'feed', before: AS_OF },
      { view: 'starred', before: AS_OF },
      { view: 'all', before: AS_OF, isRead: false },
    ]) {
      const { res, json } = await markAll(A, body);
      expect(res.status).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
    expect(await unread(A)).toEqual(before);
  });
});

describe('isolation (ADR 0012)', () => {
  it('B posting A’s folder or subscription ID gets 404 not_found, and nothing changes; B’s view=all marks only B’s entries', async () => {
    const aBefore = await unread(A);
    const missing = await markAll(B, { view: 'folder', id: 'no-such-folder', before: AS_OF });
    expect(missing.res.status).toBe(404);
    for (const body of [
      { view: 'folder', id: 'seed-folder-2', before: AS_OF },
      { view: 'feed', id: 'seed-sub-4', before: AS_OF },
    ]) {
      const r = await markAll(B, body);
      expect(r.res.status).toBe(404);
      expect(code(r.json)).toBe('not_found');
      expect(r.json).toEqual(missing.json);
    }
    expect(await unread(A)).toEqual(aBefore);

    // Entries 1, 11 and 21 are in both libraries: B's call must not touch A's copies.
    const own = await markAll(B, { view: 'all', before: AS_OF });
    expect((own.json as MarkAllReadResponse).updated).toBe(3);
    expect(await unread(B)).toEqual([]);
    expect(await unread(A)).toEqual(aBefore);
  });
});

describe('AC1, AC2, AC5: what is marked', () => {
  it('AC1, AC2, AC5: a folder view marks only its unread entries published at or before the watermark', async () => {
    const before = BASE - 6000;
    const inScope = await unread(A, FOLDER2 + ' AND published_at <= ?', before);
    const later = await unread(A, FOLDER2 + ' AND published_at > ?', before);
    const others = await unread(A, 'NOT (' + FOLDER2 + ')');
    expect(inScope.length).toBeGreaterThan(20);
    expect(later.length).toBeGreaterThan(0);

    const { res, json } = await markAll(A, {
      view: 'folder',
      id: 'seed-folder-2',
      before: iso(before),
    });
    expect(res.status).toBe(200);
    const body = json as MarkAllReadResponse;
    expect(body.updated).toBe(inScope.length);
    expect(numeric(body.entryIds)).toEqual(inScope);
    expect(await unread(A, FOLDER2)).toEqual(later); // AC2: published after the watermark
    expect(await unread(A, 'NOT (' + FOLDER2 + ')')).toEqual(others); // AC1, AC5: other views
    const read = await db.first<{ read_at: number }>(
      sql(
        'SELECT read_at FROM user_entries WHERE user_id = ? AND entry_id = ?',
        A,
        inScope[0] ?? 0,
      ),
    );
    expect(read?.read_at).toBe(NOW);
  });

  it('AC1: a feed view marks only that subscription’s feed', async () => {
    const feed1 = await unread(A, 'feed_id = 1');
    const rest = await unread(A, 'feed_id <> 1');
    const { json } = await markAll(A, { view: 'feed', id: 'seed-sub-1', before: AS_OF });
    expect((json as MarkAllReadResponse).updated).toBe(feed1.length);
    expect(await unread(A, 'feed_id = 1')).toEqual([]);
    expect(await unread(A, 'feed_id <> 1')).toEqual(rest);
  });

  it('AC4: the returned IDs are exactly what Undo needs, and a repeat changes nothing', async () => {
    const before = await unread(A);
    const done = (await markAll(A, { view: 'all', before: AS_OF })).json as MarkAllReadResponse;
    expect(done.updated).toBe(before.length);
    expect(numeric(done.entryIds)).toEqual(before);
    expect(await unread(A)).toEqual([]);

    expect((await markAll(A, { view: 'all', before: AS_OF })).json).toEqual({
      updated: 0,
      entryIds: [],
    });

    // Undo is the batch mark-unread endpoint with those IDs: exactly those entries come back.
    const undo = await call(A, 'POST', '/api/entries/read-state', {
      entryIds: done.entryIds,
      isRead: false,
    });
    expect((undo.json as ReadStateResponse).updated).toBe(before.length);
    expect(await unread(A)).toEqual(before);
  });
});

describe('AC4, AC6: large batches', () => {
  it('AC6: 2,000 unread entries are marked by one statement writing at most 2,000 x 3 rows', async () => {
    const first = await markAllRead(db, C, 'all', undefined, BASE, NOW);
    expect(first.entryIds).toHaveLength(2000);
    expect(Number(first.meta.rows_written)).toBeGreaterThan(0);
    expect(Number(first.meta.rows_written)).toBeLessThanOrEqual(2000 * 3);
    const repeat = await markAllRead(db, C, 'all', undefined, BASE, NOW);
    expect(repeat.entryIds).toHaveLength(0);
    expect(Number(repeat.meta.rows_written)).toBe(0);

    // The route runs that same statement: one request changes all 2,000.
    await resetC();
    const { res, json } = await markAll(C, { view: 'all', before: AS_OF });
    expect(res.status).toBe(200);
    expect((json as MarkAllReadResponse).updated).toBe(2000);
    expect(await unread(C)).toEqual([]);
  });

  it('AC4: exactly 1,000 changed still returns the IDs; 1,001 returns null (no Undo)', async () => {
    await resetC();
    // C's entry i is published at BASE - i, so this watermark takes i = 1001 to 2000.
    const thousand = (await markAll(C, { view: 'all', before: iso(BASE - 1001) }))
      .json as MarkAllReadResponse;
    expect(thousand.updated).toBe(1000);
    expect(thousand.entryIds).toHaveLength(1000);

    await resetC();
    const more = (await markAll(C, { view: 'all', before: iso(BASE - 1000) }))
      .json as MarkAllReadResponse;
    expect(more.updated).toBe(1001);
    expect(more.entryIds).toBeNull();
  });
});
