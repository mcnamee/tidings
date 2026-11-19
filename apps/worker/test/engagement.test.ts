import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, EngagementResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, recordEngagement, sql } from '../src/db';
import { runMaintenance } from '../src/maintenance';
import { seedSession, seedUser } from './support/seed';

// TID-066 (ADR 0018, spec 8.5, 9.4, 10.8) against local D1 on the seeded dataset: user A =
// 'seed-user' owns entries 1 to 500; user B has entries 1, 11 and 21 only.
const A = 'seed-user';
const B = 'user-b';
const BASE = 1_760_000_000;
const NOW = BASE + 10_000;
const DAY = 86_400;
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));
const tokens: Record<string, string> = {};
const app = createApp({ clock: () => NOW * 1000 });

async function post(user: string, path: string, body?: unknown, application = app) {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
    'Content-Type': 'application/json',
  });
  const res = await application.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  return { res, json: text ? (JSON.parse(text) as unknown) : null };
}
const signal = (user: string, id: number | string, kind: unknown) =>
  post(user, `/api/entries/${id}/engagement`, { kind });

interface Row {
  user_id: string;
  entry_id: number;
  feed_id: number;
  title: string | null;
  url: string | null;
  url_key: string | null;
  opened_at: number | null;
  clicked_at: number | null;
  last_at: number;
}
const rows = async (where = '1 = 1') =>
  (await db.all<Row>(sql(`SELECT * FROM engagement WHERE ${where} ORDER BY user_id, entry_id`)))
    .rows;
const clear = () => env.DB.exec('DELETE FROM engagement');

beforeAll(async () => {
  for (const line of env.SEED_SQL.split('\n')) if (line.trim()) await env.DB.exec(line);
  await seedUser(B);
  await run(
    'INSERT INTO subscriptions (id, user_id, feed_id, title_override, created_at) VALUES (?, ?, 1, NULL, ?)',
    'b-sub-1',
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
  tokens[A] = await seedSession(A, { now: BASE });
  tokens[B] = await seedSession(B, { now: BASE });
});

/** `n` fresh entries (ids first+1 ..) of feed 1, linked to A, recent enough for BASE. */
async function seedEntries(first: number, n: number) {
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
     INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at)
     SELECT ? + i, 1, 'x-' || (? + i), 'https://x.example/' || i, 'X ' || i, ?, ? FROM n`,
    first,
    first,
    BASE,
    BASE,
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
     INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read)
     SELECT ?, ? + i, 1, ?, 0 FROM n`,
    A,
    first,
    BASE,
  );
}

// Maintenance deletes expired sessions, so every test gets fresh ones.
beforeEach(async () => {
  tokens[A] = await seedSession(A, { now: BASE });
  tokens[B] = await seedSession(B, { now: BASE });
});

describe('POST /api/entries/:id/engagement', () => {
  it('stores one row per user and entry with the copied fields, and points are derived', async () => {
    await clear();
    const src = await env.DB.prepare(
      'SELECT feed_id, title, url, url_key FROM entries WHERE id = 5',
    ).first<{
      feed_id: number;
      title: string | null;
      url: string | null;
      url_key: string | null;
    }>();
    const open = await signal(A, 5, 'open');
    expect(open.res.status).toBe(200);
    expect((open.json as EngagementResponse).recorded).toBe(true);
    let [row] = await rows();
    expect(row).toMatchObject({
      user_id: A,
      entry_id: 5,
      feed_id: src?.feed_id,
      title: src?.title,
      url: src?.url,
      url_key: src?.url_key,
      opened_at: NOW,
      clicked_at: null,
      last_at: NOW,
    });
    // Points: open 1, click 2, each once, so opened and clicked is 3.
    const points = () =>
      env.DB.prepare(
        'SELECT (opened_at IS NOT NULL) * 1 + (clicked_at IS NOT NULL) * 2 AS p FROM engagement WHERE entry_id = 5',
      ).first<{ p: number }>();
    expect((await points())?.p).toBe(1);
    const click = await signal(A, 5, 'click');
    expect((click.json as EngagementResponse).recorded).toBe(true);
    [row] = await rows();
    expect(row).toMatchObject({ opened_at: NOW, clicked_at: NOW });
    expect((await points())?.p).toBe(3);
    expect(await rows()).toHaveLength(1);
  });

  it('a click on its own is 2 points', async () => {
    await clear();
    await signal(A, 6, 'click');
    const [row] = await rows();
    expect(row).toMatchObject({ opened_at: null, clicked_at: NOW });
  });

  it('is idempotent per kind: a repeat adds no row and does not move the first timestamp', async () => {
    await clear();
    const later = createApp({ clock: () => (NOW + 500) * 1000 });
    await signal(A, 7, 'open');
    const again = await post(A, '/api/entries/7/engagement', { kind: 'open' }, later);
    expect(again.res.status).toBe(200);
    expect((again.json as EngagementResponse).recorded).toBe(false);
    await post(A, '/api/entries/7/engagement', { kind: 'click' }, later);
    await post(A, '/api/entries/7/engagement', { kind: 'click' }, later);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ opened_at: NOW, clicked_at: NOW + 500, last_at: NOW + 500 });
  });

  it('writes at most one row per signal, and none for a repeat (spec 9.4)', async () => {
    await clear();
    const w = async (id: number, kind: 'open' | 'click') =>
      (await recordEngagement(db, A, id, kind, NOW))?.meta.rows_written;
    // TID-067: the row plus its `engagement_user_last` index row = 2 for an insert and for the click
    // that updates `last_at` (measured locally; D1 may bill the moved index entry as one more, so
    // spec 9.4 budgets 3 for a click).
    expect(await w(8, 'open')).toBe(2);
    expect(await w(8, 'open')).toBe(0);
    expect(await w(8, 'click')).toBe(2);
    expect(await w(8, 'click')).toBe(0);
    expect(await w(9, 'click')).toBe(2);
  });

  it('B signalling A’s entry gets 404 not_found, and nothing is written', async () => {
    await clear();
    for (const kind of ['open', 'click']) {
      const { res, json } = await signal(B, 2, kind);
      expect(res.status).toBe(404);
      expect((json as ApiError).error.code).toBe('not_found');
    }
    expect(await rows()).toHaveLength(0);
    // B's own entry works, and is stored under B.
    expect((await signal(B, 11, 'open')).res.status).toBe(200);
    expect((await rows()).map((r) => [r.user_id, r.entry_id])).toEqual([[B, 11]]);
  });

  it('answers 404 for an unknown or non-numeric entry, and 401 without a session', async () => {
    await clear();
    for (const id of ['999999', 'abc', '1.5', '-1']) {
      expect((await signal(A, id, 'open')).res.status).toBe(404);
    }
    const res = await app.fetch(
      new Request(`${env.APP_ORIGIN}/api/entries/5/engagement`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'open' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it('has a strict body: a bad kind, extra keys, a missing body and non-JSON are 400', async () => {
    await clear();
    for (const body of [
      { kind: 'view' },
      { kind: 'OPEN' },
      { kind: 1 },
      {},
      { kind: 'open', points: 99 },
      { kind: 'open', extra: true },
      [],
      'not json{',
    ]) {
      const { res, json } = await post(A, '/api/entries/5/engagement', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((json as ApiError).error.code).toBe('validation_failed');
    }
    expect(await rows()).toHaveLength(0);
  });

  it('is rate limited like other writes: a denied limiter gives 429 and writes nothing', async () => {
    await clear();
    const limited = createApp({
      clock: () => NOW * 1000,
      apiRateLimit: { limit: () => Promise.resolve({ success: false }) },
    });
    const { res } = await post(A, '/api/entries/5/engagement', { kind: 'open' }, limited);
    expect(res.status).toBe(429);
    expect(await rows()).toHaveLength(0);
  });

  it('does not change read state, and mark-read paths send no signal', async () => {
    await clear();
    await run('UPDATE user_entries SET is_read = 0 WHERE user_id = ? AND entry_id = 12', A);
    await signal(A, 12, 'open');
    const ue = await env.DB.prepare(
      'SELECT is_read FROM user_entries WHERE user_id = ? AND entry_id = 12',
    )
      .bind(A)
      .first<{ is_read: number }>();
    expect(ue?.is_read).toBe(0);
    await clear();
    await post(A, '/api/entries/read-state', { entryIds: ['13', '14'], isRead: true });
    await post(A, '/api/entries/mark-all-read', {
      view: 'all',
      before: new Date(BASE * 1000).toISOString(),
    });
    await env.DB.prepare('UPDATE user_entries SET is_read = 1 WHERE entry_id = 15').run();
    expect(await rows()).toHaveLength(0);
  });
});

describe('retention and purge (ADR 0018)', () => {
  const T0317 = Date.UTC(2026, 10, 20, 3, 17, 0) / 1000;
  const T1200 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
  const maintain = (at: number) => runMaintenance({ db, clock: () => at * 1000, log: () => {} });
  const put = (entry: number, lastAt: number, user = A) =>
    run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, url, url_key, opened_at, clicked_at, last_at) VALUES (?, ?, 1, ?, NULL, NULL, ?, NULL, ?)',
      user,
      entry,
      `t${entry}`,
      lastAt,
      lastAt,
    );

  it('the daily run deletes signals older than 180 days and keeps newer ones', async () => {
    await clear();
    await put(100, T0317 - 181 * DAY);
    await put(101, T0317 - 179 * DAY);
    await put(102, T0317 - 400 * DAY, B);
    const s = await maintain(T0317);
    expect(s.engagementDeleted).toBe(2);
    expect((await rows()).map((r) => r.entry_id)).toEqual([101]);
    expect((await maintain(T0317)).engagementDeleted).toBe(0); // idempotent
  });

  it('the retention clock is the latest signal, not the first', async () => {
    await clear();
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, opened_at, clicked_at, last_at) VALUES (?, 103, 1, ?, ?, ?)',
      A,
      T0317 - 200 * DAY,
      T0317 - 10 * DAY,
      T0317 - 10 * DAY,
    );
    expect((await maintain(T0317)).engagementDeleted).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('an hourly (not 03:17) run leaves the table alone', async () => {
    await clear();
    await put(104, T1200 - 300 * DAY);
    expect((await maintain(T1200)).engagementDeleted).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('a run is bounded to 500 rows and catches up on the next', async () => {
    await clear();
    await run(
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600) ' +
        'INSERT INTO engagement (user_id, entry_id, feed_id, opened_at, last_at) SELECT ?, 20000 + i, 1, ?, ? FROM n',
      A,
      T0317 - 300 * DAY,
      T0317 - 300 * DAY,
    );
    expect((await maintain(T0317)).engagementDeleted).toBe(500);
    expect((await maintain(T0317)).engagementDeleted).toBe(100);
    expect(await rows()).toHaveLength(0);
  });

  it('survives the entry purge: user_entries gone, content purged, tombstone deleted', async () => {
    await clear();
    await seedEntries(92_000, 1);
    await run(
      'UPDATE entries SET title = ?, url = ? WHERE id = 92001',
      'Kept title',
      'https://k.example/30',
    );
    await signal(A, 92_001, 'open');
    await run('UPDATE engagement SET last_at = ?', T0317 - 10 * DAY); // recent for the sweep
    await run('DELETE FROM user_entries WHERE entry_id = 92001 AND user_id = ?', A);
    await run(
      'UPDATE entries SET content_html = NULL, summary = NULL, purged_at = ? WHERE id = 92001',
      T0317 - 200 * DAY,
    );
    await maintain(T0317); // tombstone past 180 days: the entries row goes
    const gone = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE id = 92001').first<{
      n: number;
    }>();
    expect(gone?.n).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({
      user_id: A,
      entry_id: 92_001,
      title: 'Kept title',
      url: 'https://k.example/30',
    });
  });
});

describe('migration 0007 on a populated 0006 database', () => {
  it('creates the table without touching existing rows, and re-running changes nothing', async () => {
    const m7 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0007'));
    if (!m7) throw new Error('0007 migration not found');
    await env.DB.exec('DROP TABLE engagement');
    await seedEntries(91_000, 120);
    const snap = async () =>
      JSON.stringify([
        (await env.DB.prepare('SELECT * FROM entries ORDER BY id').all()).results,
        (await env.DB.prepare('SELECT * FROM user_entries ORDER BY user_id, entry_id').all())
          .results,
        (await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results,
      ]);
    const before = await snap();
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM entries').first<{ n: number }>())?.n,
    ).toBeGreaterThanOrEqual(120);

    await applyD1Migrations(env.DB, [{ name: '0007_rerun', queries: m7.queries }]);

    expect(await snap()).toBe(before);
    const cols = (
      await env.DB.prepare('SELECT name FROM pragma_table_info(?)').bind('engagement').all<{
        name: string;
      }>()
    ).results.map((c) => c.name);
    expect(cols).toEqual([
      'user_id',
      'entry_id',
      'feed_id',
      'title',
      'url',
      'url_key',
      'opened_at',
      'clicked_at',
      'last_at',
    ]);
    expect(await rows()).toHaveLength(0);
    // Re-running 0007 recreated the table as it was then: bring it to the 0008 shape again (TID-067).
    await env.DB.exec('ALTER TABLE engagement ADD COLUMN embedding TEXT');
    await env.DB.exec('CREATE INDEX engagement_user_last ON engagement(user_id, last_at)');
    // Works straight away on the migrated database.
    expect((await signal(A, 91_001, 'open')).res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });
});
