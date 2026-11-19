import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiError, EntriesResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { Db, listEntries, setRead, sql } from '../src/db';
import {
  DAILY_ENTRY_CAP,
  DAILY_TOKEN_CAP,
  EMBED_BATCH,
  EMBED_MAX_TRIES,
  runEmbedPending,
  type Embedder,
} from '../src/recommend/embed';
import { runProfiles } from '../src/recommend/profile';
import { listRecommended } from '../src/recommend/rank';
import { DIMS, decodeProfile, encodeEmbedding, cosine, normalise } from '../src/recommend/vector';
import { seedSession, seedUser } from './support/seed';

// TID-067 (ADR 0018, spec 6, 7, 8.5, 9) against local D1 on the seeded dataset: user A =
// 'seed-user' owns entries 1 to 500 in 10 feeds (folder 1 = feeds 1-3); user B owns 1, 11 and 21.
// Workers AI is not available locally, so every embedder here is a fake.
const A = 'seed-user';
const B = 'user-b';
const BASE = 1_760_000_000;
const NOW = BASE + 10_000;
const NOW_MS = NOW * 1000;
const DAY = 86_400;
const db = new Db(env.DB);
const run = (s: string, ...p: (string | number | null)[]) => db.run(sql(s, ...p));
const all = async <T>(s: string, ...p: (string | number | null)[]) =>
  (await db.all<T>(sql(s, ...p))).rows;
const tokens: Record<string, string> = {};

function vec(seed: number): number[] {
  let x = seed;
  return Array.from({ length: DIMS }, () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648 - 0.5;
  });
}
const mix = (base: number[], other: number[], w: number) =>
  base.map((b, i) => b + w * (other[i] as number));
const TOPIC_X = vec(1000);
const TOPIC_Y = vec(2000);
/** Entries whose id is a multiple of 3 are about topic X, the rest about topic Y. */
const isX = (id: number) => id % 3 === 0;
const entryVec = (id: number) => mix(isX(id) ? TOPIC_X : TOPIC_Y, vec(id), 0.3);

/** A fake model: a deterministic vector per text; records every call. */
function fakeEmbedder(calls: string[][] = []): Embedder {
  return async (texts) => {
    calls.push(texts);
    return texts.map((t) => vec([...t].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 100_003, 7)));
  };
}
const failing: Embedder = async () => {
  throw new Error('AI down');
};

const app = createApp({ clock: () => NOW_MS });
async function get(user: string, qs: string, application = app, environment = env) {
  const res = await application.fetch(
    new Request(`${environment.APP_ORIGIN}/api/entries?${qs}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${tokens[user]}` },
    }),
    environment,
  );
  return { res, json: (await res.json()) as EntriesResponse & ApiError };
}

async function embedAll(ids: number[]) {
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    await db.batch(
      chunk.map((id) =>
        sql(
          'INSERT OR REPLACE INTO entry_embeddings (entry_id, vec) VALUES (?, ?)',
          id,
          encodeEmbedding(entryVec(id)),
        ),
      ),
    );
  }
}
async function signals(user: string, ids: number[], at = NOW - 100) {
  for (const id of ids) {
    await run(
      `INSERT OR REPLACE INTO engagement (user_id, entry_id, feed_id, title, opened_at, clicked_at,
                                          last_at, embedding)
       VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
      user,
      id,
      `Title ${id}`,
      at,
      at,
      encodeEmbedding(entryVec(id)),
    );
  }
}
const xIds = Array.from({ length: 500 }, (_, i) => i + 1).filter(isX);
const yIds = Array.from({ length: 500 }, (_, i) => i + 1).filter((i) => !isX(i));

const profile = async (user: string) =>
  (
    await all<{ vec: string; signals: number; computed_at: number }>(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      user,
    )
  )[0];

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
  await embedAll(Array.from({ length: 500 }, (_, i) => i + 1));
});

describe('embed step: bounded batches, budget, failure', () => {
  async function queue(ids: number[]) {
    await env.DB.exec('DELETE FROM embed_queue');
    for (const id of ids) await run('INSERT INTO embed_queue (entry_id) VALUES (?)', id);
  }
  const deps = (embedder: Embedder) => ({ db, embedder, clock: () => NOW_MS });
  const counter = async () =>
    all<{ key: string; count: number }>("SELECT key, count FROM rate_limits WHERE key LIKE 'ai:%'");

  it('embeds at most one batch per run, newest first, in one AI call and 3 rows written per entry', async () => {
    await env.DB.exec('DELETE FROM entry_embeddings');
    await env.DB.exec('DELETE FROM rate_limits');
    await queue(Array.from({ length: 60 }, (_, i) => 100 + i));
    const calls: string[][] = [];
    const s = await runEmbedPending(deps(fakeEmbedder(calls)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(EMBED_BATCH);
    expect(s.embedded).toBe(EMBED_BATCH);
    expect((await all('SELECT entry_id FROM entry_embeddings ORDER BY entry_id DESC')).length).toBe(
      EMBED_BATCH,
    );
    const done = await all<{ entry_id: number }>('SELECT entry_id FROM entry_embeddings');
    expect(Math.min(...done.map((r) => r.entry_id))).toBe(159 - EMBED_BATCH + 1);
    expect((await all('SELECT 1 FROM embed_queue')).length).toBe(60 - EMBED_BATCH);
    // 1 vector row + 1 dequeue per entry, plus the two daily counters (rate_limits is a rowid table with a key index: 2 rows each).
    expect(s.rowsWritten).toBe(2 * EMBED_BATCH + 4);
    expect(Object.fromEntries((await counter()).map((r) => [r.key, r.count]))).toMatchObject({
      'ai:entries': EMBED_BATCH,
    });
    // The stored text is a valid 388-byte embedding.
    const one = (await all<{ vec: string }>('SELECT vec FROM entry_embeddings LIMIT 1'))[0];
    expect(one?.vec).toHaveLength(520);
  });

  it('drains a backlog over several runs and then idles without calling the model', async () => {
    const calls: string[][] = [];
    const e = fakeEmbedder(calls);
    expect((await runEmbedPending(deps(e))).embedded).toBe(25);
    expect((await runEmbedPending(deps(e))).embedded).toBe(10);
    const idle = await runEmbedPending(deps(e));
    expect(idle).toMatchObject({ embedded: 0, stopped: 'idle' });
    expect(calls).toHaveLength(2);
  });

  it('stops at the daily token or entry cap without calling the model, and resets on a new UTC day', async () => {
    await queue([200, 201]);
    const calls: string[][] = [];
    await env.DB.exec('DELETE FROM rate_limits');
    await run(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('ai:tokens', ?, ?)",
      NOW - (NOW % DAY),
      DAILY_TOKEN_CAP,
    );
    expect(await runEmbedPending(deps(fakeEmbedder(calls)))).toMatchObject({
      embedded: 0,
      stopped: 'daily_cap',
    });
    await env.DB.exec('DELETE FROM rate_limits');
    await run(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('ai:entries', ?, ?)",
      NOW - (NOW % DAY),
      DAILY_ENTRY_CAP,
    );
    expect((await runEmbedPending(deps(fakeEmbedder(calls)))).stopped).toBe('daily_cap');
    expect(calls).toHaveLength(0);
    expect((await all('SELECT 1 FROM embed_queue')).length).toBe(2);
    // Yesterday's counters do not count today.
    await env.DB.exec('DELETE FROM rate_limits');
    await run(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('ai:tokens', ?, ?)",
      NOW - (NOW % DAY) - DAY,
      DAILY_TOKEN_CAP,
    );
    expect((await runEmbedPending(deps(fakeEmbedder(calls)))).embedded).toBe(2);
    const c = Object.fromEntries((await counter()).map((r) => [r.key, r.count]));
    expect(c['ai:entries']).toBe(2); // the old day's total was replaced, not added to
    expect(c['ai:tokens']).toBeGreaterThan(0);
    expect(c['ai:tokens']).toBeLessThan(DAILY_TOKEN_CAP);
  });

  it('a failing AI call leaves the entries queued, counts the try, and parks them after three', async () => {
    await env.DB.exec('DELETE FROM entry_embeddings');
    await env.DB.exec('DELETE FROM rate_limits');
    await queue([300, 301]);
    for (let n = 1; n <= EMBED_MAX_TRIES; n++) {
      expect((await runEmbedPending(deps(failing))).stopped).toBe('ai_error');
      expect(
        (await all<{ tries: number }>('SELECT tries FROM embed_queue WHERE entry_id = 300'))[0]
          ?.tries,
      ).toBe(n);
    }
    // Parked: not selected, so the model is not called again.
    const calls: string[][] = [];
    expect((await runEmbedPending(deps(fakeEmbedder(calls)))).stopped).toBe('idle');
    expect(calls).toHaveLength(0);
    expect((await all('SELECT 1 FROM entry_embeddings')).length).toBe(0);
    expect((await all('SELECT 1 FROM rate_limits')).length).toBe(0); // a failed call costs nothing
  });

  it('a wrong-shaped answer is a failure, not a crash', async () => {
    await queue([310]);
    const bad: Embedder = async () => [];
    expect((await runEmbedPending(deps(bad))).stopped).toBe('ai_error');
  });

  it('entries with no title or summary leave the queue without an embedding', async () => {
    await run(
      "INSERT INTO entries (id, feed_id, guid_hash, published_at, fetched_at) VALUES (99001, 1, 'blank', ?, ?)",
      BASE,
      BASE,
    );
    await queue([99_001]);
    const calls: string[][] = [];
    expect(await runEmbedPending(deps(fakeEmbedder(calls)))).toMatchObject({
      embedded: 0,
      skippedEmpty: 1,
    });
    expect(calls).toHaveLength(0);
    expect((await all('SELECT 1 FROM embed_queue')).length).toBe(0);
    await run('DELETE FROM entries WHERE id = 99001');
  });

  it('an entry deleted while the AI call was in flight is skipped, not an error', async () => {
    await queue([320, 321]);
    const racing: Embedder = async (texts) => {
      await run('DELETE FROM user_entries WHERE entry_id = 320');
      await run('DELETE FROM entries WHERE id = 320');
      return fakeEmbedder()(texts);
    };
    const s = await runEmbedPending(deps(racing));
    expect(s.stopped).toBeNull();
    expect(
      (await all('SELECT entry_id FROM entry_embeddings WHERE entry_id IN (320, 321)')).length,
    ).toBe(1);
    expect((await all('SELECT 1 FROM embed_queue')).length).toBe(0);
    // Put the entry back for the later tests.
    await run(
      "INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at) VALUES (320, 1, 'restored-320', 'https://x.example/320', 'T 320', ?, ?)",
      BASE,
      BASE,
    );
    await embedAll([320, 321, ...Array.from({ length: 500 }, (_, i) => i + 1)]);
  });
});

describe('profile recompute', () => {
  it("builds each user's profile from their own signals only", async () => {
    await env.DB.exec('DELETE FROM engagement');
    await signals(A, xIds.slice(0, 25));
    await signals(B, yIds.slice(0, 25));
    const s = await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    expect(s.users).toBe(2);
    const pa = decodeProfile((await profile(A))?.vec) as Float32Array;
    const pb = decodeProfile((await profile(B))?.vec) as Float32Array;
    expect((await profile(A))?.signals).toBe(25);
    expect(cosine(pa, TOPIC_X)).toBeGreaterThan(0.9);
    expect(cosine(pa, TOPIC_Y)).toBeLessThan(0.3);
    expect(cosine(pb, TOPIC_Y)).toBeGreaterThan(0.9);
    expect(Math.hypot(...pa)).toBeCloseTo(1, 4);

    // Isolation: B's signals changing leaves A's profile byte-identical.
    const before = (await profile(A))?.vec;
    await signals(B, xIds.slice(30, 60));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    expect((await profile(A))?.vec).toBe(before);
    expect(cosine(decodeProfile((await profile(B))?.vec) as Float32Array, TOPIC_X)).toBeGreaterThan(
      0.3,
    );
  });

  it('weights by points: a clicked signal outweighs an opened one', async () => {
    await env.DB.exec('DELETE FROM engagement');
    await signals(A, [3]); // topic X, opened (1 point)
    await signals(A, [1]); // topic Y, opened
    await run(
      'UPDATE engagement SET clicked_at = ? WHERE user_id = ? AND entry_id = 3',
      NOW - 100,
      A,
    );
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    const p = decodeProfile((await profile(A))?.vec) as Float32Array;
    expect(cosine(p, TOPIC_X)).toBeGreaterThan(cosine(p, TOPIC_Y));
  });

  it("a signal without a copy takes the entry's embedding and keeps it; with no entry it is embedded from its stored title", async () => {
    await env.DB.exec('DELETE FROM engagement');
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 3, 1, ?, ?, ?)',
      A,
      'Has an entry',
      NOW - 10,
      NOW - 10,
    );
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 888001, 1, ?, ?, ?)',
      A,
      'Purged long ago',
      NOW - 10,
      NOW - 10,
    );
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 888002, 1, NULL, ?, ?)',
      A,
      NOW - 10,
      NOW - 10,
    );
    const calls: string[][] = [];
    const s = await runProfiles({ db, embedder: fakeEmbedder(calls), clock: () => NOW_MS });
    expect(s).toMatchObject({ copied: 1, reembedded: 1 });
    expect(calls).toEqual([['Purged long ago']]);
    const rows = await all<{ entry_id: number; embedding: string | null }>(
      'SELECT entry_id, embedding FROM engagement ORDER BY entry_id',
    );
    expect(rows.map((r) => r.embedding !== null)).toEqual([true, true, false]);
    expect((await profile(A))?.signals).toBe(2);
    expect((await all('SELECT 1 FROM rate_limits WHERE key = ?', 'ai:entries'))[0]).toBeDefined();
  });

  it('survives the entry purge: the profile is still built after the entries are deleted', async () => {
    await env.DB.exec('DELETE FROM engagement');
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 3, 1, ?, ?, ?)',
      A,
      'x',
      NOW - 10,
      NOW - 10,
    );
    await runProfiles({ db, embedder: null, clock: () => NOW_MS }); // copies the embedding
    await run('DELETE FROM entry_embeddings WHERE entry_id = 3');
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    expect((await profile(A))?.signals).toBe(1);
    await embedAll([3]);
  });

  it('a failing AI call leaves the profile built from what it has; no usable signal removes the profile', async () => {
    await env.DB.exec('DELETE FROM engagement');
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 888003, 1, ?, ?, ?)',
      A,
      'Needs the model',
      NOW,
      NOW,
    );
    const s = await runProfiles({ db, embedder: failing, clock: () => NOW_MS });
    expect(s).toMatchObject({ reembedded: 0, profilesDeleted: 1 });
    expect(await profile(A)).toBeUndefined();
  });

  it('respects the daily budget when re-embedding', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    await run(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('ai:tokens', ?, ?)",
      NOW - (NOW % DAY),
      DAILY_TOKEN_CAP,
    );
    const calls: string[][] = [];
    await runProfiles({ db, embedder: fakeEmbedder(calls), clock: () => NOW_MS });
    expect(calls).toHaveLength(0);
    await env.DB.exec('DELETE FROM rate_limits');
  });
});

describe('ranking', () => {
  async function ready() {
    await env.DB.exec('DELETE FROM engagement');
    await signals(A, xIds.slice(0, 25));
    await signals(B, yIds.slice(0, 25));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
  }
  const page = async (
    user: string,
    view: 'all' | 'feed' | 'folder',
    id: string | number | undefined,
    cursor: string | null,
    limit = 40,
    extra = {},
  ) => {
    const p = await profile(user);
    return listRecommended(db, user, {
      view,
      ...(id === undefined ? {} : { id }),
      limit,
      cursor,
      profile: p?.vec as string,
      now: NOW,
      ...extra,
    });
  };
  async function walk(
    user: string,
    view: 'all' | 'feed' | 'folder',
    id?: string | number,
    limit = 40,
    extra = {},
  ) {
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 60; n++) {
      const p = await page(user, view, id, cursor, limit, extra);
      ids.push(...p.items.map((i) => i.entry_id));
      cursor = p.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('did not terminate');
  }
  const unreadIds = async (user: string, view: 'all' | 'feed' | 'folder', id?: string | number) => {
    const out: number[] = [];
    let cursor: string | null = null;
    do {
      const p = await listEntries(db, user, {
        view,
        ...(id === undefined ? {} : { id }),
        unreadOnly: true,
        limit: 100,
        cursor,
      });
      out.push(...p.items.map((i) => i.entry_id));
      cursor = p.nextCursor;
    } while (cursor);
    return out;
  };

  it('puts the engaged topic first and the unrelated topic after it', async () => {
    await ready();
    const first = await page(A, 'all', undefined, null, 50);
    expect(first.items).toHaveLength(50);
    expect(first.items.every((i) => isX(i.entry_id))).toBe(true);
    // Equally similar topics: the newer entry first (ids rise with time in the seed).
    const ys = (await walk(A, 'all')).filter((id) => !isX(id));
    expect(ys.length).toBeGreaterThan(100);
  });

  it('serves every unread entry exactly once across pages: All, Feed and Folder, with and without the phase-2 tail', async () => {
    await ready();
    for (const [view, id] of [
      ['all', undefined],
      ['feed', 'seed-sub-2'],
      ['folder', 'seed-folder-1'],
    ] as const) {
      const feedId = view === 'feed' ? 2 : undefined;
      const expected = (await unreadIds(A, view, view === 'feed' ? feedId : id)).sort(
        (a, b) => a - b,
      );
      for (const extra of [{}, { candidateLimit: 60 }, { candidateLimit: 7 }]) {
        for (const limit of [13, 50]) {
          const got = await walk(A, view, view === 'feed' ? feedId : id, limit, extra);
          expect(new Set(got).size).toBe(got.length);
          expect([...got].sort((a, b) => a - b)).toEqual(expected);
        }
      }
    }
  });

  it('beyond the ranked set the list continues newest first (a phase-2 cursor is an ordinary one)', async () => {
    await ready();
    const ranked = 30;
    const got = await walk(A, 'all', undefined, 10, { candidateLimit: ranked });
    const newest = await unreadIds(A, 'all');
    // The 30 newest are ranked; everything after them is exactly the newest-first order.
    expect(new Set(got.slice(0, ranked))).toEqual(new Set(newest.slice(0, ranked)));
    expect(got.slice(ranked)).toEqual(newest.slice(ranked));
  });

  it('pagination is stable while the user reads: rows marked read mid-scroll neither repeat nor shift the rest', async () => {
    await ready();
    const first = await page(A, 'all', undefined, null, 20);
    for (const i of first.items) await setRead(db, A, i.entry_id, true, NOW);
    const ids = first.items.map((i) => i.entry_id);
    let cursor = first.nextCursor;
    const rest: number[] = [];
    while (cursor) {
      const p = await page(A, 'all', undefined, cursor, 20);
      rest.push(...p.items.map((i) => i.entry_id));
      cursor = p.nextCursor;
    }
    expect(rest.filter((id) => ids.includes(id))).toEqual([]);
    expect(new Set(rest).size).toBe(rest.length);
    const remaining = (await unreadIds(A, 'all')).length; // unread now, i.e. everything not in `first`
    expect(rest.length).toBe(remaining);
    await db.run(
      sql(
        'UPDATE user_entries SET is_read = 0 WHERE user_id = ? AND entry_id IN (SELECT value FROM json_each(?))',
        A,
        JSON.stringify(ids),
      ),
    );
  });

  it('entries without an embedding are still listed, ranked with the neutral cosine', async () => {
    await ready();
    await run(
      'DELETE FROM entry_embeddings WHERE entry_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(xIds.slice(0, 40)),
    );
    const got = await walk(A, 'all');
    expect(got.length).toBe((await unreadIds(A, 'all')).length);
    // An unembedded X entry sits below every embedded X one.
    const bare = new Set(xIds.slice(0, 40));
    const embeddedX = got.flatMap((id, i) => (isX(id) && !bare.has(id) ? [i] : []));
    const unembedded = got.flatMap((id, i) => (bare.has(id) ? [i] : []));
    expect(unembedded.length).toBeGreaterThan(0);
    expect(Math.max(...embeddedX)).toBeLessThan(Math.min(...unembedded));
    await embedAll(xIds.slice(0, 40));
  });

  it("another user's signals never affect mine: B profile on topic Y leaves A's order unchanged", async () => {
    await ready();
    const a1 = await walk(A, 'all');
    await signals(B, yIds.slice(30, 120));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    expect(await walk(A, 'all')).toEqual(a1);
    // And B only ever sees their own three entries.
    const b = await walk(B, 'all');
    expect(b.sort((x, y) => x - y)).toEqual([1, 11, 21]);
  });

  it('malformed or foreign-shaped cursors are a 400', async () => {
    await ready();
    for (const cursor of ['x', btoa('{"m":"r"}'), btoa('[1]').replace(/=/g, '')]) {
      await expect(page(A, 'all', undefined, cursor)).rejects.toThrow('Malformed cursor');
    }
  });
});

describe('GET /api/entries?sort=recommended', () => {
  const q = (extra = '') => `view=all&state=unread&limit=50&sort=recommended${extra}`;

  it('is newest first by default and says nothing about sort notes', async () => {
    const { json } = await get(A, 'view=all&state=unread&limit=5');
    expect(json.sort).toBe('newest');
    expect(json.sortNote).toBeUndefined();
  });

  it('cold start: with no profile, or under 20 signals, it is newest first with a note', async () => {
    await env.DB.exec('DELETE FROM user_profiles');
    const none = await get(A, q());
    expect(none.json).toMatchObject({ sort: 'newest', sortNote: 'cold_start' });
    const newest = await get(A, 'view=all&state=unread&limit=50');
    expect(none.json.items.map((i) => i.id)).toEqual(newest.json.items.map((i) => i.id));

    await env.DB.exec('DELETE FROM engagement');
    await signals(A, xIds.slice(0, 19));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    expect((await get(A, q())).json).toMatchObject({ sort: 'newest', sortNote: 'cold_start' });
    await signals(A, xIds.slice(19, 20));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    const ready = await get(A, q());
    expect(ready.json.sort).toBe('recommended');
    expect(ready.json.sortNote).toBeUndefined();
    expect(ready.json.items.every((i) => isX(Number(i.id)))).toBe(true);
  });

  it('works for a folder and a feed, and pages with the cursor it returns', async () => {
    const folder = await get(
      A,
      `view=folder&id=seed-folder-1&state=unread&limit=30&sort=recommended`,
    );
    expect(folder.json.sort).toBe('recommended');
    expect(folder.json.nextCursor).toBeTruthy();
    const next = await get(
      A,
      `view=folder&id=seed-folder-1&state=unread&limit=30&sort=recommended&cursor=${folder.json.nextCursor}`,
    );
    const a = folder.json.items.map((i) => i.id);
    expect(next.json.items.map((i) => i.id).filter((id) => a.includes(id))).toEqual([]);
    const feed = await get(A, `view=feed&id=seed-sub-3&state=unread&limit=30&sort=recommended`);
    expect(feed.json.sort).toBe('recommended');
    expect(feed.json.items.every((i) => i.subscriptionId === 'seed-sub-3')).toBe(true);
  });

  it('a folder or feed that is not mine is 404, and the other user never sees my entries', async () => {
    expect(
      (await get(B, `view=folder&id=seed-folder-1&state=unread&sort=recommended`)).res.status,
    ).toBe(404);
    expect((await get(B, `view=feed&id=seed-sub-2&state=unread&sort=recommended`)).res.status).toBe(
      404,
    );
    const b = await get(B, q());
    expect(b.json.items.map((i) => i.id).sort()).toEqual(['1', '11', '21']);
  });

  it('state=all is always newest first, with no note', async () => {
    const { json } = await get(A, 'view=all&state=all&limit=5&sort=recommended');
    expect(json.sort).toBe('newest');
    expect(json.sortNote).toBeUndefined();
  });

  it('without the AI binding and without a profile it says "unavailable" and lists newest first', async () => {
    await env.DB.exec('DELETE FROM user_profiles');
    const noAi = { ...env, AI: undefined } as typeof env;
    const { res, json } = await get(A, q(), app, noAi);
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ sort: 'newest', sortNote: 'unavailable' });
    expect(json.items).toHaveLength(50);
  });

  it('rejects an unknown sort and a cursor of the wrong shape', async () => {
    expect((await get(A, 'view=all&sort=hot')).res.status).toBe(400);
    expect((await get(A, 'view=all&state=unread&cursor=bad')).res.status).toBe(400);
    // A recommended cursor presented to the newest-first list is malformed there.
    await signals(A, xIds.slice(0, 25));
    await runProfiles({ db, embedder: null, clock: () => NOW_MS });
    const first = await get(A, q('&limit=10'));
    expect(first.json.nextCursor).toBeTruthy();
    expect((await get(A, `view=all&state=unread&cursor=${first.json.nextCursor}`)).res.status).toBe(
      400,
    );
  });

  it('PATCH /api/me accepts listSort and nothing else new', async () => {
    const patch = (settings: unknown) =>
      app.fetch(
        new Request(`${env.APP_ORIGIN}/api/me`, {
          method: 'PATCH',
          headers: {
            Origin: env.APP_ORIGIN,
            Cookie: `${SESSION_COOKIE}=${tokens[A]}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ settings }),
        }),
        env,
      );
    expect((await patch({ listSort: 'recommended' })).status).toBe(200);
    expect((await patch({ listSort: 'hot' })).status).toBe(400);
    expect((await patch({ listSort: 'newest' })).status).toBe(200);
  });
});

describe('queueing and retention', () => {
  it('a new subscription queues the linked entries that have no embedding yet', async () => {
    const { createSubscription } = await import('../src/db/subscriptions');
    await env.DB.exec('DELETE FROM embed_queue');
    await env.DB.exec(
      'DELETE FROM entry_embeddings WHERE entry_id IN (SELECT id FROM entries WHERE feed_id = 11)',
    );
    await run(
      "INSERT OR IGNORE INTO feeds (id, url, title, next_fetch_at, state, created_at) VALUES (11, 'https://feed11.example.com/rss', 'Feed 11', ?, 'ok', ?)",
      BASE,
      BASE,
    );
    for (let i = 1; i <= 3; i++) {
      await run(
        'INSERT INTO entries (id, feed_id, guid_hash, url, title, published_at, fetched_at) VALUES (?, 11, ?, ?, ?, ?, ?)',
        70_000 + i,
        `g11-${i}`,
        `https://feed11.example.com/${i}`,
        `Eleven ${i}`,
        BASE - i,
        BASE,
      );
    }
    await createSubscription(db, {
      subscriptionId: 'b-sub-11',
      userId: B,
      feedUrl: 'https://feed11.example.com/rss',
      folderId: null,
      titleOverride: null,
      now: NOW,
      jitterS: 0,
      limit: 100,
    });
    const q = await all<{ entry_id: number }>('SELECT entry_id FROM embed_queue ORDER BY entry_id');
    expect(q.map((r) => r.entry_id)).toEqual([70_001, 70_002, 70_003]);
  });

  it('maintenance drops embeddings of recently purged entries, once, and keeps the rest', async () => {
    const { runMaintenance } = await import('../src/maintenance');
    await run(
      'UPDATE entries SET content_html = NULL, summary = NULL, purged_at = ? WHERE id IN (5, 6)',
      NOW - DAY,
    );
    await embedAll([5, 6, 7]);
    // 03:17 UTC run so the daily steps happen.
    const at = (NOW - (NOW % DAY) + DAY + 3 * 3600 + 17 * 60) * 1000;
    const s = await runMaintenance({ db, clock: () => at, log: () => {} });
    expect(s.embeddingsDeleted).toBe(2);
    expect(
      (await all('SELECT entry_id FROM entry_embeddings WHERE entry_id IN (5, 6, 7)')).map(
        (r: unknown) => (r as { entry_id: number }).entry_id,
      ),
    ).toEqual([7]);
    expect((await runMaintenance({ db, clock: () => at, log: () => {} })).embeddingsDeleted).toBe(
      0,
    );
  });

  it('deleting an entry removes its embedding and queue row; deleting a user removes the profile', async () => {
    await run('DELETE FROM user_entries WHERE entry_id = 7');
    await run('INSERT OR IGNORE INTO embed_queue (entry_id) VALUES (7)');
    await run('DELETE FROM entries WHERE id = 7');
    expect((await all('SELECT 1 FROM entry_embeddings WHERE entry_id = 7')).length).toBe(0);
    expect((await all('SELECT 1 FROM embed_queue WHERE entry_id = 7')).length).toBe(0);
    await run(
      "INSERT INTO users (id, display_name, role, created_at) VALUES ('gone', 'g', 'member', 0)",
    );
    await run(
      "INSERT INTO user_profiles (user_id, vec, signals, computed_at) VALUES ('gone', 'x', 1, 0)",
    );
    await run("DELETE FROM users WHERE id = 'gone'");
    expect((await all("SELECT 1 FROM user_profiles WHERE user_id = 'gone'")).length).toBe(0);
  });
});

describe('migration 0008 on a populated 0007 database', () => {
  it('adds the tables and the column without touching existing rows; re-running the table steps changes nothing', async () => {
    const m8 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0008'));
    if (!m8) throw new Error('0008 migration not found');
    // Take the database back to its 0007 shape, then migrate it forward.
    for (const stmt of [
      'DROP INDEX engagement_user_last',
      'ALTER TABLE engagement DROP COLUMN embedding',
      'DROP TABLE user_profiles',
      'DROP TABLE embed_queue',
      'DROP TABLE entry_embeddings',
    ]) {
      await env.DB.exec(stmt);
    }
    await env.DB.exec('DELETE FROM engagement');
    await run(
      'INSERT INTO engagement (user_id, entry_id, feed_id, title, opened_at, last_at) VALUES (?, 11, 1, ?, ?, ?)',
      A,
      'Old signal',
      NOW,
      NOW,
    );
    const snap = async () =>
      JSON.stringify([
        (await env.DB.prepare('SELECT * FROM entries ORDER BY id').all()).results,
        (await env.DB.prepare('SELECT * FROM user_entries ORDER BY user_id, entry_id').all())
          .results,
        (await env.DB.prepare('SELECT * FROM engagement ORDER BY user_id, entry_id').all()).results,
      ]);
    const before = JSON.parse(await snap()) as unknown[][];
    await applyD1Migrations(env.DB, [{ name: '0008_rerun', queries: m8.queries }]);
    const after = JSON.parse(await snap()) as { embedding?: string | null }[][][];
    // Same rows; the engagement row only gains a NULL embedding.
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual((before[2] as object[]).map((r) => ({ ...r, embedding: null })));
    const tables = (
      await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['entry_embeddings', 'embed_queue', 'user_profiles']),
    );
    // Works straight away.
    expect(
      await runEmbedPending({ db, embedder: fakeEmbedder(), clock: () => NOW_MS }),
    ).toMatchObject({ stopped: 'idle' });
    expect(normalise(vec(1)).length).toBe(DIMS);
  });
});
