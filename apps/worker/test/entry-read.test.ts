import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiError, EntrySummary, ReadStateResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, setRead, setReadMany, sql } from '../src/db';
import { seedSession, seedUser } from './support/seed';

// TID-019 (spec 8.5, 9.4, 10.8). The real API against local D1 on the seeded dataset
// (apps/worker/scripts/seed.mjs): user A = 'seed-user' owns entries 1 to 500 (every 4th is read).
// User B is added here with entries 1, 11 and 21 only.

const A = 'seed-user';
const B = 'user-b';
const BASE = 1_760_000_000;
const NOW = BASE + 10_000;
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
const code = (json: unknown) => (json as ApiError).error.code;
const state = async (user: string, id: number) =>
  db.first<{ is_read: number; read_at: number | null }>(
    sql('SELECT is_read, read_at FROM user_entries WHERE user_id = ? AND entry_id = ?', user, id),
  );

beforeAll(async () => {
  for (const line of env.SEED_SQL.split('\n')) if (line.trim()) await env.DB.exec(line);
  await seedUser(B);
  await run(
    "INSERT INTO subscriptions (id, user_id, feed_id, title_override, created_at) VALUES ('b-sub-1', ?, 1, NULL, ?)",
    B,
    BASE,
  );
  for (const i of [1, 11, 21]) {
    await run(
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 1, ?, 0)',
      B,
      i,
      BASE - 1000 + i,
    );
  }
  await run("UPDATE entries SET content_html = '<p>Hello <b>world</b></p>' WHERE id = 2");
  tokens[A] = await seedSession(A, { now: BASE });
  tokens[B] = await seedSession(B, { now: BASE });
});

describe('GET /api/entries/:id', () => {
  it('returns the entry with its raw content, feed title and read state', async () => {
    const { res, json } = await call(A, 'GET', '/api/entries/2');
    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      id: '2',
      title: 'Entry 2',
      author: 'Author 2',
      feedTitle: 'Feed 2',
      contentHtml: '<p>Hello <b>world</b></p>',
      isRead: false,
    });
  });

  it('AC9: B asking for A’s entry gets 404 not_found, identical to a missing or malformed ID', async () => {
    const mine = await call(B, 'GET', '/api/entries/2'); // A has it, B does not
    const missing = await call(B, 'GET', '/api/entries/999999');
    const junk = await call(B, 'GET', '/api/entries/abc');
    for (const r of [mine, missing, junk]) {
      expect(r.res.status).toBe(404);
      expect(code(r.json)).toBe('not_found');
    }
    expect(mine.json).toEqual(missing.json);
    // B's own entry works, and A's copy is separate.
    expect((await call(B, 'GET', '/api/entries/1')).res.status).toBe(200);
  });
});

describe('PATCH /api/entries/:id', () => {
  it('AC2, AC4: marks read, then unread, and returns the summary', async () => {
    const read = await call(A, 'PATCH', '/api/entries/1', { isRead: true });
    expect(read.res.status).toBe(200);
    expect((read.json as EntrySummary).isRead).toBe(true);
    expect(await state(A, 1)).toEqual({ is_read: 1, read_at: NOW });

    const unread = await call(A, 'PATCH', '/api/entries/1', { isRead: false });
    expect((unread.json as EntrySummary).isRead).toBe(false);
    expect(await state(A, 1)).toEqual({ is_read: 0, read_at: null });
  });

  it('writes at most 3 rows for one change and nothing for a repeat (spec 9.4)', async () => {
    const first = await setRead(db, A, 2, true, NOW);
    expect(first.changes).toBe(1);
    expect(Number(first.rows_written)).toBeLessThanOrEqual(3);
    const again = await setRead(db, A, 2, true, NOW + 5);
    expect(again.changes).toBe(0);
    expect(Number(again.rows_written)).toBe(0);
    expect((await state(A, 2))?.read_at).toBe(NOW); // the repeat did not move read_at
    await setRead(db, A, 2, false, NOW);
  });

  it('rejects a body that is not { isRead: boolean }, including isStarred until M2', async () => {
    for (const body of [
      {},
      { isRead: 'yes' },
      { isStarred: true },
      { isRead: true, isStarred: true },
    ]) {
      const { res, json } = await call(A, 'PATCH', '/api/entries/3', body);
      expect(res.status).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
    expect((await state(A, 3))?.is_read).toBe(0);
  });

  it('AC9: B changing A’s entry gets 404 not_found, and A’s entry is unchanged', async () => {
    const { res, json } = await call(B, 'PATCH', '/api/entries/5', { isRead: true });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect((await state(A, 5))?.is_read).toBe(0);
    // Entry 1 is in both libraries: B's change does not touch A's copy.
    await call(B, 'PATCH', '/api/entries/1', { isRead: true });
    expect((await state(B, 1))?.is_read).toBe(1);
    expect((await state(A, 1))?.is_read).toBe(0);
  });
});

describe('POST /api/entries/read-state', () => {
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));

  it('AC10: 1,001 IDs is 400 validation_failed and changes nothing', async () => {
    const { res, json } = await call(A, 'POST', '/api/entries/read-state', {
      entryIds: ids(1, 1001),
      isRead: true,
    });
    expect(res.status).toBe(400);
    expect(code(json)).toBe('validation_failed');
    expect((await state(A, 1))?.is_read).toBe(0);
  });

  it('AC10: empty, non-string and missing fields are 400', async () => {
    for (const body of [
      { entryIds: [], isRead: true },
      { entryIds: [1], isRead: true },
      { entryIds: ['1'] },
      { isRead: true },
    ]) {
      const { res } = await call(A, 'POST', '/api/entries/read-state', body);
      expect(res.status).toBe(400);
    }
  });

  it('marks and unmarks a batch, counting only entries that changed', async () => {
    const set = await call(A, 'POST', '/api/entries/read-state', {
      entryIds: ['6', '7', '8', 'not-an-id'], // 8 is already read; junk is ignored
      isRead: true,
    });
    expect((set.json as ReadStateResponse).updated).toBe(2);
    expect((await state(A, 6))?.is_read).toBe(1);
    const unset = await call(A, 'POST', '/api/entries/read-state', {
      entryIds: ['6', '7'],
      isRead: false,
    });
    expect((unset.json as ReadStateResponse).updated).toBe(2);
    expect(((await state(A, 6)) ?? {}).read_at).toBeNull();
  });

  it('AC10: 1,000 IDs in one call is accepted, and costs at most 3 rows written per change', async () => {
    const unread = (
      await db.all<{ entry_id: number }>(
        sql('SELECT entry_id FROM user_entries WHERE user_id = ? AND is_read = 0', A),
      )
    ).rows.map((r) => r.entry_id);
    expect(unread.length).toBeGreaterThan(300);

    const { res, json } = await call(A, 'POST', '/api/entries/read-state', {
      entryIds: ids(1, 1000),
      isRead: true,
    });
    expect(res.status).toBe(200);
    expect((json as ReadStateResponse).updated).toBe(unread.length);

    // Put them back, measuring the write cost of the same statement the route runs.
    const { updated, meta } = await setReadMany(db, A, unread, false, NOW);
    expect(updated).toBe(unread.length);
    expect(Number(meta.rows_written)).toBeLessThanOrEqual(unread.length * 3);
    const { meta: again } = await setReadMany(db, A, unread, false, NOW);
    expect(Number(again.rows_written)).toBe(0);
    expect(await state(A, unread[0] ?? 0)).toEqual({ is_read: 0, read_at: null });
  });

  it('AC10: with another user’s IDs in the list, only mine change', async () => {
    // B owns 1, 11, 21. Entry 5 is only A's.
    const { res, json } = await call(B, 'POST', '/api/entries/read-state', {
      entryIds: ['11', '5', '9', '21'],
      isRead: true,
    });
    expect(res.status).toBe(200);
    expect((json as ReadStateResponse).updated).toBe(2); // 11 and 21 only
    expect((await state(A, 5))?.is_read).toBe(0);
    expect((await state(A, 9))?.is_read).toBe(0);
    expect((await state(A, 11))?.is_read).toBe(0);
    expect((await state(A, 21))?.is_read).toBe(0);
  });

  it('AC10: B sending only A’s IDs gets 200 with updated 0 and A’s entries are unchanged', async () => {
    const { res, json } = await call(B, 'POST', '/api/entries/read-state', {
      entryIds: ['5', '9', '13'],
      isRead: true,
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({ updated: 0 });
    for (const id of [5, 9, 13]) expect((await state(A, id))?.is_read).toBe(0);
  });
});
