import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TOPICS,
  TOPIC_SCAN_LIMIT,
  topicIdOfSlug,
  type ApiError,
  type EntriesResponse,
  type MarkAllReadResponse,
  type User,
} from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, listEntries, sql } from '../src/db';
import { listRecommended } from '../src/recommend/rank';
import { SOURCE_MODEL, packTopics } from '../src/recommend/topics';
import { DIMS, encodeProfile, normalise } from '../src/recommend/vector';
import { seedSession, seedUser } from './support/seed';

// TID-078 (ADR 0021 section 7, spec 6.2, 8.5, 8.6): the `topic` filter on lists and mark-all-read, and the
// `topicChips` setting. User A = 'seed-user' owns entries 1 to 500 (every 4th read); user B owns 1, 11 and
// 21; user C owns 2,000 unread entries (10001 is the newest) for the scan bound.
const A = 'seed-user';
const B = 'user-b';
const C = 'user-c';
const BASE = 1_760_000_000;
const NOW = BASE + 10_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const AS_OF = iso(BASE);
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));
const all = async <T>(s: string, ...p: (string | number | null)[]) =>
  (await db.all<T>(sql(s, ...p))).rows;
const tokens: Record<string, string> = {};
const app = createApp({ clock: () => NOW * 1000 });
const ID = (slug: string) => topicIdOfSlug(slug) as number;
const tag = (...slugs: string[]) =>
  packTopics(
    slugs.map((s) => ID(s)),
    SOURCE_MODEL,
  );

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
const list = async (user: string, qs: string) => {
  const r = await call(user, 'GET', `/api/entries?${qs}`);
  return { res: r.res, body: r.json as EntriesResponse & ApiError };
};
const markAll = (user: string, body: unknown) =>
  call(user, 'POST', '/api/entries/mark-all-read', body);
const code = (json: unknown) => (json as ApiError).error.code;
const holds = (topics: number | null, id: number) => {
  const t = topics ?? 0;
  return [t & 255, (t >> 8) & 255, (t >> 16) & 255].includes(id);
};

/** Walks every page of a topic list, as the SPA does, until `nextCursor` is null. */
async function walk(user: string, qs: string, limit = 50) {
  const ids: string[] = [];
  const pages: EntriesResponse[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const { res, body } = await list(
      user,
      `${qs}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(res.status).toBe(200);
    pages.push(body);
    ids.push(...body.items.map((i) => i.id));
    cursor = body.nextCursor;
    if (cursor === null) return { ids, pages };
  }
  throw new Error('did not end');
}

/** What the filter must return, computed without the filter: the user's entries whose tag holds the topic. */
async function expected(user: string, topicId: number, unreadOnly: boolean) {
  const rows = await all<{ entry_id: number; topics: number | null }>(
    `SELECT ue.entry_id, e.topics FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
     WHERE ue.user_id = ? ${unreadOnly ? 'AND ue.is_read = 0' : ''}
     ORDER BY ue.published_at DESC, ue.entry_id DESC`,
    user,
  );
  return rows.filter((r) => holds(r.topics, topicId)).map((r) => String(r.entry_id));
}
const unread = async (user: string, topicSlug?: string) => {
  const rows = await all<{ entry_id: number; topics: number | null }>(
    'SELECT ue.entry_id, e.topics FROM user_entries ue JOIN entries e ON e.id = ue.entry_id WHERE ue.user_id = ? AND ue.is_read = 0 ORDER BY ue.entry_id',
    user,
  );
  return rows
    .filter((r) => topicSlug === undefined || holds(r.topics, ID(topicSlug)))
    .map((r) => r.entry_id);
};

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
  // A: ai on every 10th entry, formula-1 on every 7th, a three-topic tag (ai in the 3rd slot) on every
  // 15th that has neither, "tagged, no topic" on every 11th; the rest are untagged (NULL).
  await run(
    'UPDATE entries SET topics = ? WHERE id <= 500 AND id % 15 = 0',
    tag('uk-politics', 'formula-1', 'ai'),
  );
  await run('UPDATE entries SET topics = ? WHERE id <= 500 AND id % 10 = 0', tag('ai'));
  await run('UPDATE entries SET topics = ? WHERE id <= 500 AND id % 7 = 0', tag('formula-1'));
  await run(
    'UPDATE entries SET topics = ? WHERE id <= 500 AND id % 11 = 0',
    packTopics([], SOURCE_MODEL),
  );
});

describe('GET /api/entries?topic=', () => {
  it('lists only the topic, in any of its 3 slots, for both states, newest first, across pages', async () => {
    for (const unreadOnly of [true, false]) {
      const want = await expected(A, ID('ai'), unreadOnly);
      expect(want.length).toBeGreaterThan(20);
      const got = await walk(A, `view=all&topic=ai&state=${unreadOnly ? 'unread' : 'all'}`, 10);
      expect(got.ids).toEqual(want);
    }
    const { body } = await list(A, 'view=all&topic=formula-1&state=all&limit=100');
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.topics).toContain('formula-1');
    // An entry tagged only in the third slot is found.
    const third = await list(A, 'view=all&topic=ai&state=all&limit=100');
    expect(third.body.items.some((i) => i.id === '15' || i.id === '45')).toBe(true);
  });

  it('is 400 validation_failed for a folder or feed view, an unknown topic and a badly formed one', async () => {
    for (const qs of [
      'view=folder&id=seed-folder-1&topic=ai',
      'view=feed&id=seed-sub-1&topic=ai',
      'view=all&topic=nope',
      'view=all&topic=',
      'view=all&topic=13',
      'view=all&topic=AI',
    ]) {
      const { res, body } = await list(A, qs);
      expect(res.status, qs).toBe(400);
      expect(code(body)).toBe('validation_failed');
    }
  });

  it('is scoped to the caller: B sees only B’s entries, never entries that only A holds', async () => {
    // B holds 1, 11 and 21, none tagged ai, while A holds plenty that are.
    const none = await list(B, 'view=all&topic=ai&state=all');
    expect(none.body.items).toEqual([]);
    expect(none.body.nextCursor).toBeNull();
    await run('UPDATE entries SET topics = ? WHERE id = 11', tag('ai'));
    const mine = await list(B, 'view=all&topic=ai&state=all');
    expect(mine.body.items.map((i) => i.id)).toEqual(['11']);
    // Entry 11 is in both libraries, and the shared tag shows for both; nothing else of A's leaks.
    expect(
      (await list(A, 'view=all&topic=ai&state=all&limit=100')).body.items.length,
    ).toBeGreaterThan(40);
    await run('UPDATE entries SET topics = NULL WHERE id = 11');
  });

  it('returns a short or empty page with a cursor when the scan limit comes first, and null only at the end', async () => {
    // C holds 2,000 unread entries; three of them, 1,500 deep, are tagged.
    await run('UPDATE entries SET topics = NULL WHERE id > 10000');
    await run('UPDATE entries SET topics = ? WHERE id IN (11500, 11501, 11502)', tag('osint'));
    const first = await list(C, 'view=all&topic=osint&state=unread&limit=50');
    expect(first.body.items).toEqual([]);
    expect(first.body.nextCursor).not.toBeNull();
    const rest = await walk(C, 'view=all&topic=osint&state=unread');
    expect(rest.ids).toEqual(['11500', '11501', '11502']);
    expect(rest.pages).toHaveLength(2);
    expect(rest.pages[1]?.nextCursor).toBeNull();
    // No match anywhere: the scan covers everything, then the cursor is null.
    const none = await walk(C, 'view=all&topic=sport&state=unread');
    expect(none.ids).toEqual([]);
    expect(none.pages).toHaveLength(2);
    // A list that ends exactly inside one scan has no cursor and no extra empty page.
    const short = await walk(A, 'view=all&topic=ai&state=unread');
    expect(short.pages).toHaveLength(1);
    expect(short.pages[0]?.nextCursor).toBeNull();
  });

  it('reads at most the scan limit of index rows twice, plus the rows it keeps (bounded work)', async () => {
    expect(TOPIC_SCAN_LIMIT).toBe(1000);
    const empty = await listEntries(db, C, {
      view: 'all',
      unreadOnly: true,
      limit: 50,
      topic: 'sport',
    });
    expect(empty.items).toEqual([]);
    // The scan reads 1,000 index rows and 1,000 entries, the cursor lookup up to 1,000 more index rows.
    expect(Number(empty.meta.rows_read ?? 0)).toBeLessThanOrEqual(3 * TOPIC_SCAN_LIMIT + 10);
    // A full page stops early and never looks for the edge.
    await run('UPDATE entries SET topics = ? WHERE id BETWEEN 10001 AND 10200', tag('osint'));
    const full = await listEntries(db, C, {
      view: 'all',
      unreadOnly: true,
      limit: 20,
      topic: 'osint',
    });
    expect(full.items).toHaveLength(20);
    expect(Number(full.meta.rows_read ?? 0)).toBeLessThan(200);
    await run('UPDATE entries SET topics = NULL WHERE id > 10000');
  });

  it('works with sort=recommended: the same entries, nothing twice, none missing', async () => {
    const vec = encodeProfile(normalise(Array.from({ length: DIMS }, (_, i) => Math.sin(i + 1))));
    await run(
      'INSERT OR REPLACE INTO user_profiles (user_id, vec, signals, computed_at) VALUES (?, ?, 50, ?)',
      A,
      vec,
      NOW,
    );
    const want = await unread(A, 'formula-1');
    expect(want.length).toBeGreaterThan(20);
    // Through the API (default candidate cap), and through the ranker with a tiny cap so phase 2 runs.
    const viaApi = await walk(A, 'view=all&topic=formula-1&state=unread&sort=recommended', 10);
    expect(viaApi.pages[0]?.sort).toBe('recommended');
    expect(viaApi.ids.map(Number).sort((a, b) => a - b)).toEqual(want);
    expect(new Set(viaApi.ids).size).toBe(viaApi.ids.length);

    const ids: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const page: Awaited<ReturnType<typeof listRecommended>> = await listRecommended(db, A, {
        view: 'all',
        limit: 6,
        cursor,
        topic: 'formula-1',
        profile: vec,
        now: NOW,
        candidateLimit: 8,
      });
      ids.push(...page.items.map((r) => r.entry_id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(ids.slice().sort((a, b) => a - b)).toEqual(want);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('with sort=recommended and a scan that stops short of the end, phase 2 carries on below it', async () => {
    const vec = encodeProfile(normalise(Array.from({ length: DIMS }, (_, i) => Math.cos(i + 1))));
    await run('UPDATE entries SET topics = NULL WHERE id > 10000');
    await run(
      'UPDATE entries SET topics = ? WHERE id IN (10005, 10990, 11500, 11999)',
      tag('osint'),
    );
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: Awaited<ReturnType<typeof listRecommended>> = await listRecommended(db, C, {
        view: 'all',
        limit: 50,
        cursor,
        topic: 'osint',
        profile: vec,
        now: NOW,
      });
      ids.push(...page.items.map((r) => r.entry_id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(ids.slice().sort((a, b) => a - b)).toEqual([10005, 10990, 11500, 11999]);
    expect(new Set(ids).size).toBe(4);
    await run('UPDATE entries SET topics = NULL WHERE id > 10000');
  });
});

describe('POST /api/entries/mark-all-read with a topic', () => {
  it('marks only that topic’s unread entries at or before the watermark and leaves the rest unread', async () => {
    const before = await unread(A);
    const ai = await unread(A, 'ai');
    expect(ai.length).toBeGreaterThan(10);
    const { res, json } = await markAll(A, { view: 'all', topic: 'ai', before: AS_OF });
    expect(res.status).toBe(200);
    const body = json as MarkAllReadResponse;
    expect(body.updated).toBe(ai.length);
    expect((body.entryIds ?? []).map(Number).sort((a, b) => a - b)).toEqual(ai);
    expect(await unread(A)).toEqual(before.filter((id) => !ai.includes(id)));
    expect(await unread(A, 'ai')).toEqual([]);
    const again = await markAll(A, { view: 'all', topic: 'ai', before: AS_OF });
    expect((again.json as MarkAllReadResponse).updated).toBe(0);
  });

  it('honours before: later entries of the topic stay unread', async () => {
    const f1 = await all<{ entry_id: number; published_at: number }>(
      `SELECT ue.entry_id, ue.published_at FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
       WHERE ue.user_id = ? AND ue.is_read = 0 AND (e.topics & 255) = ? ORDER BY ue.published_at`,
      A,
      ID('formula-1'),
    );
    expect(f1.length).toBeGreaterThan(10);
    const cut = (f1[Math.floor(f1.length / 2)] as { published_at: number }).published_at;
    const early = f1.filter((r) => r.published_at <= cut).map((r) => r.entry_id);
    const { json } = await markAll(A, { view: 'all', topic: 'formula-1', before: iso(cut) });
    expect((json as MarkAllReadResponse).updated).toBe(early.length);
    expect((await unread(A, 'formula-1')).length).toBe(f1.length - early.length);
  });

  it('is scoped to the caller: B marking a topic leaves A’s entries alone', async () => {
    await run('UPDATE entries SET topics = ? WHERE id IN (1, 11, 21)', tag('uk-politics'));
    const aBefore = await unread(A);
    const { json } = await markAll(B, { view: 'all', topic: 'uk-politics', before: AS_OF });
    expect((json as MarkAllReadResponse).updated).toBe(3);
    expect(await unread(A)).toEqual(aBefore);
  });

  it('is 400 for a folder or feed view, an unknown topic, and a non-string topic', async () => {
    for (const body of [
      { view: 'folder', id: 'seed-folder-1', topic: 'ai', before: AS_OF },
      { view: 'feed', id: 'seed-sub-1', topic: 'ai', before: AS_OF },
      { view: 'all', topic: 'nope', before: AS_OF },
      { view: 'all', topic: 13, before: AS_OF },
    ]) {
      const { res, json } = await markAll(A, body);
      expect(res.status).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
  });
});

describe('PATCH /api/me topicChips', () => {
  const patch = (user: string, topicChips: unknown) =>
    call(user, 'PATCH', '/api/me', { settings: { topicChips } });
  const chipsOf = async (user: string) =>
    ((await call(user, 'GET', '/api/me')).json as User).settings.topicChips;

  it('stores the ordered list whole, so a reorder replaces it, and an empty list clears it', async () => {
    const a = await patch(A, ['ai', 'formula-1', 'uk-politics']);
    expect(a.res.status).toBe(200);
    expect((a.json as User).settings.topicChips).toEqual(['ai', 'formula-1', 'uk-politics']);
    const b = await patch(A, ['uk-politics', 'ai']);
    expect((b.json as User).settings.topicChips).toEqual(['uk-politics', 'ai']);
    expect(await chipsOf(A)).toEqual(['uk-politics', 'ai']);
    const c = await patch(A, []);
    expect((c.json as User).settings.topicChips).toEqual([]);
  });

  it('accepts all 28 active topics, and rejects unknown, repeated, too many and badly typed values with 400', async () => {
    const every = TOPICS.map((t) => t.slug);
    expect(every).toHaveLength(28);
    expect((await patch(A, every)).res.status).toBe(200);
    await patch(A, ['ai']);
    for (const bad of [
      ['ai', 'nope'],
      ['ai', 'ai'],
      [...every, 'ai'],
      ['AI'],
      [13],
      'ai',
      null,
      [''],
    ]) {
      const { res, json } = await patch(A, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(code(json)).toBe('validation_failed');
    }
    expect(await chipsOf(A)).toEqual(['ai']);
  });

  it('returns a stored list without an ID that is no longer an active topic', async () => {
    await run(
      "UPDATE users SET settings_json = json_set(settings_json, '$.topicChips', json(?)) WHERE id = ?",
      JSON.stringify(['ai', 'retired-topic', 'formula-1']),
      B,
    );
    expect(await chipsOf(B)).toEqual(['ai', 'formula-1']);
    const session = await call(B, 'GET', '/api/auth/session');
    expect((session.json as { user: User }).user.settings.topicChips).toEqual(['ai', 'formula-1']);
  });

  it('keeps one user’s chips out of another’s', async () => {
    await patch(A, ['osint']);
    expect(await chipsOf(C)).toBeUndefined();
  });
});
