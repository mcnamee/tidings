import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { TOPIC_SCAN_LIMIT, topicIdOfSlug, type TopicCounts } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, sql, unreadTopicCounts } from '../src/db';
import { SOURCE_MODEL, packTopics } from '../src/recommend/topics';
import { seedSession, seedUser } from './support/seed';

// TID-078 amendment (ADR 0021 amendment 3, spec 8.5): GET /api/counts/topics. User A = 'seed-user' owns
// entries 1 to 500 (every 4th read); user B owns 1, 11 and 21; user C owns 2,000 unread entries.
const A = 'seed-user';
const B = 'user-b';
const C = 'user-c';
const BASE = 1_760_000_000;
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));
const tokens: Record<string, string> = {};
const app = createApp({ clock: () => (BASE + 10_000) * 1000 });
const ID = (slug: string) => topicIdOfSlug(slug) as number;
const tag = (...slugs: string[]) =>
  packTopics(
    slugs.map((s) => ID(s)),
    SOURCE_MODEL,
  );

async function get(user: string | null) {
  const headers = new Headers({ Origin: env.APP_ORIGIN });
  if (user) headers.set('Cookie', `${SESSION_COOKIE}=${tokens[user]}`);
  const res = await app.fetch(new Request(`${env.APP_ORIGIN}/api/counts/topics`, { headers }), env);
  return { res, json: (await res.json()) as TopicCounts };
}

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
  for (const u of [A, B, C]) tokens[u] = await seedSession(u, { now: BASE });
  await run('UPDATE entries SET topics = ? WHERE id <= 500 AND id % 10 = 0', tag('ai'));
  await run(
    'UPDATE entries SET topics = ? WHERE id <= 500 AND id % 15 = 0',
    tag('formula-1', 'ai'),
  );
  await run(
    'UPDATE entries SET topics = ? WHERE id <= 500 AND id % 11 = 0',
    packTopics([], SOURCE_MODEL),
  );
});

describe('GET /api/counts/topics', () => {
  it('needs a session', async () => {
    const headers = new Headers({ Origin: env.APP_ORIGIN });
    const res = await app.fetch(
      new Request(`${env.APP_ORIGIN}/api/counts/topics`, { headers }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('counts unread articles per topic, an article with two topics once under each', async () => {
    const rows = (
      await db.all<{ entry_id: number; topics: number | null }>(
        sql(
          'SELECT ue.entry_id, e.topics FROM user_entries ue JOIN entries e ON e.id = ue.entry_id WHERE ue.user_id = ? AND ue.is_read = 0',
          A,
        ),
      )
    ).rows;
    const want = (slug: string) =>
      rows.filter((r) => {
        const t = r.topics ?? 0;
        return [t & 255, (t >> 8) & 255, (t >> 16) & 255].includes(ID(slug));
      }).length;
    const { res, json } = await get(A);
    expect(res.status).toBe(200);
    expect(json.topics['ai']).toBe(want('ai'));
    expect(json.topics['formula-1']).toBe(want('formula-1'));
    expect(want('ai')).toBeGreaterThan(10);
    // No unread article carries these: they are absent, not 0.
    expect(Object.keys(json.topics).sort()).toEqual(['ai', 'formula-1']);
  });

  it('drops an article from its topics once it is read', async () => {
    const before = (await get(A)).json.topics['formula-1'] as number;
    await run(
      'UPDATE user_entries SET is_read = 1 WHERE user_id = ? AND entry_id = (SELECT MIN(entry_id) FROM user_entries WHERE user_id = ? AND is_read = 0 AND entry_id % 15 = 0)',
      A,
      A,
    );
    const after = (await get(A)).json.topics['formula-1'] as number;
    expect(before - after).toBe(1);
  });

  it('is scoped to the caller', async () => {
    // B holds 1, 11 and 21 and none is tagged with a topic, however many A's are.
    expect((await get(B)).json.topics).toEqual({});
    // An entry only B holds, tagged osint.
    await run(
      "INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at, topics) VALUES (9001, 1, 'b-only', 'https://feed1.example.com/b', 'B only', ?, ?, ?)",
      BASE,
      BASE,
      tag('osint'),
    );
    await run(
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, 9001, 1, ?, 0)',
      B,
      BASE,
    );
    expect((await get(B)).json.topics).toEqual({ osint: 1 });
    expect((await get(A)).json.topics['osint']).toBeUndefined();
  });

  it('reads a bounded number of rows however many unread articles there are', async () => {
    await run('UPDATE entries SET topics = ? WHERE id > 10000', tag('osint'));
    const { counts, rowsRead } = await unreadTopicCounts(db, C);
    // 2,000 unread, all tagged: only the newest TOPIC_SCAN_LIMIT are counted, at about 2 reads each.
    expect(counts.topics['osint']).toBe(TOPIC_SCAN_LIMIT);
    expect(rowsRead).toBeLessThanOrEqual(2 * TOPIC_SCAN_LIMIT + 10);
    expect(rowsRead).toBeGreaterThan(TOPIC_SCAN_LIMIT);
  });
});
