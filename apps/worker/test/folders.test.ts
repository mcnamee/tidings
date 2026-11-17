import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, Folder, Subscription, SubscriptionsResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { sql } from '../src/db';
import { PARKED_AT } from '../src/refresh';
import { count, db, resetData, seedFeed } from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-014: folders and subscription management (spec 8.4, FR-FO-1..5, FR-SU-5, FR-SU-6, 10.8).
// The whole API runs for real in workerd against local D1; nothing is faked.

const NOW = 1_760_000_000;
const app = createApp({ clock: () => NOW * 1000 });
let tokens: Record<string, string>;

async function call(user: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({
    Origin: env.APP_ORIGIN,
    Cookie: `${SESSION_COOKIE}=${tokens[user]}`,
  });
  if (method !== 'GET') headers.set('Content-Type', 'application/json'); // spec 10.3
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
const folderNames = async (user: string) =>
  ((await call(user, 'GET', '/api/folders')).json as { items: Folder[] }).items.map((f) => f.name);
const subs = async (user: string) =>
  ((await call(user, 'GET', '/api/subscriptions')).json as SubscriptionsResponse).items;

async function addUser(id: string) {
  await seedUser(id);
  tokens[id] = await seedSession(id, { now: NOW });
}

async function makeFolder(user: string, name: string): Promise<Folder> {
  const { res, json } = await call(user, 'POST', '/api/folders', { name });
  expect(res.status).toBe(201);
  return json as Folder;
}

/** A feed with `n` articles linked to `user`, subscribed as `<user>-<feedId>`. */
async function seedSub(user: string, n = 0, url?: string): Promise<{ id: string; feedId: number }> {
  const feedId = await seedFeed({ subscribers: [user], ...(url ? { url } : {}) });
  for (let i = 0; i < n; i++) {
    const r = await db.run(
      sql(
        `INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at) VALUES (?, ?, ?, ?)`,
        feedId,
        `g${i}`,
        NOW - i,
        NOW,
      ),
    );
    await db.run(
      sql(
        'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at) VALUES (?, ?, ?, ?)',
        user,
        Number(r.last_row_id),
        feedId,
        NOW - i,
      ),
    );
  }
  return { id: `${user}-${feedId}`, feedId };
}

beforeEach(async () => {
  await resetData();
  tokens = {};
  await addUser('u1');
});

describe('AC1: create a folder; the list is alphabetical, case-insensitive', () => {
  it('201 with { id, name }, and GET /api/folders sorts case-insensitively', async () => {
    const { res, json } = await call('u1', 'POST', '/api/folders', { name: 'Tech' });
    expect(res.status).toBe(201);
    expect(json).toEqual({ id: expect.any(String), name: 'Tech' });
    await makeFolder('u1', 'banana');
    await makeFolder('u1', 'Apple');
    await makeFolder('u1', 'cherry');
    expect(await folderNames('u1')).toEqual(['Apple', 'banana', 'cherry', 'Tech']);
  });

  it('trims the name', async () => {
    expect((await makeFolder('u1', '  News  ')).name).toBe('News');
  });
});

describe('AC2: a duplicate name is 409 conflict, case-insensitively', () => {
  it('"tech" after "Tech" is 409 conflict and creates nothing', async () => {
    await makeFolder('u1', 'Tech');
    const { res, json } = await call('u1', 'POST', '/api/folders', { name: 'tech' });
    expect(res.status).toBe(409);
    expect(code(json)).toBe('conflict');
    expect(await folderNames('u1')).toEqual(['Tech']);
  });

  it('another user may use the same name', async () => {
    await addUser('u2');
    await makeFolder('u1', 'Tech');
    await makeFolder('u2', 'Tech');
  });

  it('renaming onto another folder’s name (any case) is 409; renaming to a new case of itself is fine', async () => {
    await makeFolder('u1', 'Tech');
    const news = await makeFolder('u1', 'News');
    const clash = await call('u1', 'PATCH', `/api/folders/${news.id}`, { name: 'TECH' });
    expect(clash.res.status).toBe(409);
    expect(code(clash.json)).toBe('conflict');
    const own = await call('u1', 'PATCH', `/api/folders/${news.id}`, { name: 'NEWS' });
    expect(own.res.status).toBe(200);
    expect(own.json).toEqual({ id: news.id, name: 'NEWS' });
  });
});

describe('AC3: name length 1 to 64', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['65 characters', 'x'.repeat(65)],
  ])('%s is 400 validation_failed on create and rename', async (_label, name) => {
    const folder = await makeFolder('u1', 'Keep');
    const create = await call('u1', 'POST', '/api/folders', { name });
    expect(create.res.status).toBe(400);
    expect(code(create.json)).toBe('validation_failed');
    const rename = await call('u1', 'PATCH', `/api/folders/${folder.id}`, { name });
    expect(rename.res.status).toBe(400);
    expect(await folderNames('u1')).toEqual(['Keep']);
  });

  it('1 and 64 characters are accepted; a missing or non-string name is 400', async () => {
    expect((await call('u1', 'POST', '/api/folders', { name: 'x' })).res.status).toBe(201);
    expect((await call('u1', 'POST', '/api/folders', { name: 'y'.repeat(64) })).res.status).toBe(
      201,
    );
    expect((await call('u1', 'POST', '/api/folders', {})).res.status).toBe(400);
    expect((await call('u1', 'POST', '/api/folders', { name: 5 })).res.status).toBe(400);
  });
});

describe('AC4: move a subscription to a folder and back to "no folder"', () => {
  it('PATCH folderId sets it, null clears it, and GET /api/subscriptions shows both', async () => {
    const { id } = await seedSub('u1');
    const tech = await makeFolder('u1', 'Tech');
    const moved = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { folderId: tech.id });
    expect(moved.res.status).toBe(200);
    expect((moved.json as Subscription).folderId).toBe(tech.id);
    expect((await subs('u1'))[0]?.folderId).toBe(tech.id);

    const back = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { folderId: null });
    expect((back.json as Subscription).folderId).toBeNull();
    expect((await subs('u1'))[0]?.folderId).toBeNull();
  });

  it('a folder that does not exist is 404 not_found and the subscription is unchanged', async () => {
    const { id } = await seedSub('u1');
    const { res, json } = await call('u1', 'PATCH', `/api/subscriptions/${id}`, {
      folderId: 'nope',
    });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
  });
});

describe('AC5: rename a subscription; clearing restores the feed title', () => {
  it('sets a custom title, and null, blank or whitespace restore the feed’s title', async () => {
    const { id } = await seedSub('u1');
    await db.run(sql("UPDATE feeds SET title = 'Feed Title'"));
    const set = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: '  My Blog ' });
    expect(set.json).toMatchObject({ title: 'My Blog', customTitle: 'My Blog' });
    expect((await subs('u1'))[0]).toMatchObject({ title: 'My Blog' });

    for (const cleared of [null, '', '   ']) {
      await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: 'My Blog' });
      const res = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: cleared });
      expect(res.json).toMatchObject({ title: 'Feed Title', customTitle: null });
    }
  });

  it('a title over 200 characters is 400; an empty body is 400; omitted fields stay as they are', async () => {
    const { id } = await seedSub('u1');
    const tech = await makeFolder('u1', 'Tech');
    await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: 'Mine', folderId: tech.id });
    expect(
      (await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: 'x'.repeat(201) })).res
        .status,
    ).toBe(400);
    expect((await call('u1', 'PATCH', `/api/subscriptions/${id}`, {})).res.status).toBe(400);
    const onlyTitle = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: 'Other' });
    expect(onlyTitle.json).toMatchObject({ title: 'Other', folderId: tech.id });
  });
});

describe('AC6: deleting a folder keeps its subscriptions at the top level', () => {
  it('a folder with 5 subscriptions: 204, the folder is gone, all 5 remain with folderId null', async () => {
    const tech = await makeFolder('u1', 'Tech');
    const other = await makeFolder('u1', 'Other');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedSub('u1', 1)).id);
    const stays = (await seedSub('u1')).id;
    for (const id of ids)
      await call('u1', 'PATCH', `/api/subscriptions/${id}`, { folderId: tech.id });
    await call('u1', 'PATCH', `/api/subscriptions/${stays}`, { folderId: other.id });

    const { res } = await call('u1', 'DELETE', `/api/folders/${tech.id}`);
    expect(res.status).toBe(204);
    expect(await folderNames('u1')).toEqual(['Other']);
    const after = await subs('u1');
    expect(after).toHaveLength(6);
    expect(after.filter((s) => ids.includes(s.id)).map((s) => s.folderId)).toEqual(
      Array(5).fill(null),
    );
    expect(after.find((s) => s.id === stays)?.folderId).toBe(other.id);
    expect(await count('user_entries', 'user_id = ?', 'u1')).toBe(5); // article state untouched
  });

  it('a second delete is 404 not_found', async () => {
    const tech = await makeFolder('u1', 'Tech');
    await call('u1', 'DELETE', `/api/folders/${tech.id}`);
    expect((await call('u1', 'DELETE', `/api/folders/${tech.id}`)).res.status).toBe(404);
  });
});

describe('AC7: unsubscribe removes the subscription and the user’s article state', () => {
  it('204; the user’s user_entries for that feed go, other feeds’ stay', async () => {
    const a = await seedSub('u1', 4);
    const b = await seedSub('u1', 3);
    const { res } = await call('u1', 'DELETE', `/api/subscriptions/${a.id}`);
    expect(res.status).toBe(204);
    expect((await subs('u1')).map((s) => s.id)).toEqual([b.id]);
    expect(await count('user_entries', 'user_id = ? AND feed_id = ?', 'u1', a.feedId)).toBe(0);
    expect(await count('user_entries', 'user_id = ? AND feed_id = ?', 'u1', b.feedId)).toBe(3);
    expect(await count('entries', 'feed_id = ?', a.feedId)).toBe(4); // shared articles stay
  });

  it('the last subscriber parks the feed; another subscriber keeps it scheduled and their entries', async () => {
    await addUser('u2');
    const feedId = await seedFeed({ subscribers: ['u1', 'u2'], nextFetchAt: 12345 });
    const r = await db.run(
      sql(
        'INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at) VALUES (?, ?, 1, 1)',
        feedId,
        'g',
      ),
    );
    for (const u of ['u1', 'u2']) {
      await db.run(
        sql(
          'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at) VALUES (?, ?, ?, 1)',
          u,
          Number(r.last_row_id),
          feedId,
        ),
      );
    }
    const next = () =>
      db.first<{ next_fetch_at: number }>(
        sql('SELECT next_fetch_at FROM feeds WHERE id = ?', feedId),
      );

    expect((await call('u1', 'DELETE', `/api/subscriptions/u1-${feedId}`)).res.status).toBe(204);
    expect((await next())?.next_fetch_at).toBe(12345);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(1);

    expect((await call('u2', 'DELETE', `/api/subscriptions/u2-${feedId}`)).res.status).toBe(204);
    expect((await next())?.next_fetch_at).toBe(PARKED_AT);
    expect(await count('feeds', 'id = ?', feedId)).toBe(1);
  });

  it('an unknown ID is 404 not_found', async () => {
    const { res, json } = await call('u1', 'DELETE', '/api/subscriptions/nope');
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
  });
});

describe('AC8: at most 200 folders per user', () => {
  it('the 201st is 422 limit_reached; another user is unaffected; deleting one frees a slot', async () => {
    const stmts = Array.from({ length: 200 }, (_v, i) =>
      sql(
        'INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, 0)',
        `f${i}`,
        'u1',
        `F${i}`,
      ),
    );
    await db.batch(stmts);
    const over = await call('u1', 'POST', '/api/folders', { name: 'One more' });
    expect(over.res.status).toBe(422);
    expect(code(over.json)).toBe('limit_reached');
    expect(await count('folders', 'user_id = ?', 'u1')).toBe(200);

    await addUser('u2');
    expect((await call('u2', 'POST', '/api/folders', { name: 'Mine' })).res.status).toBe(201);

    await call('u1', 'DELETE', '/api/folders/f0');
    expect((await call('u1', 'POST', '/api/folders', { name: 'One more' })).res.status).toBe(201);
  });
});

describe('per-user isolation for the new routes (spec 10.8, ADR 0012)', () => {
  let fa: Folder;
  let sa: { id: string; feedId: number };
  let sb: { id: string; feedId: number };

  beforeEach(async () => {
    await addUser('u2');
    fa = await makeFolder('u1', 'Tech');
    sa = await seedSub('u1', 2);
    await call('u1', 'PATCH', `/api/subscriptions/${sa.id}`, { folderId: fa.id, title: 'A name' });
    sb = await seedSub('u2', 1);
  });

  async function snapshot(user: string) {
    const q = (table: string, order: string) =>
      db
        .all(sql(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY ${order}`, user))
        .then((r) => r.rows);
    return {
      folders: await q('folders', 'id'),
      subscriptions: await q('subscriptions', 'id'),
      userEntries: await q('user_entries', 'entry_id'),
      feeds: (await db.all(sql('SELECT * FROM feeds ORDER BY id'))).rows,
    };
  }

  it('B renaming A’s folder gets 404 not_found, and A’s folder is unchanged', async () => {
    const before = await snapshot('u1');
    const { res, json } = await call('u2', 'PATCH', `/api/folders/${fa.id}`, { name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await snapshot('u1')).toEqual(before);
    expect(await folderNames('u2')).toEqual([]);
    // Same answer as an ID that does not exist.
    const nope = await call('u2', 'PATCH', '/api/folders/nope', { name: 'Hijacked' });
    expect(nope.json).toEqual(json);
  });

  it('B deleting A’s folder gets 404 not_found, and A’s folder and subscriptions are unchanged', async () => {
    const before = await snapshot('u1');
    const { res, json } = await call('u2', 'DELETE', `/api/folders/${fa.id}`);
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await snapshot('u1')).toEqual(before);
  });

  it('B editing A’s subscription gets 404 not_found, and A’s subscription is unchanged', async () => {
    const before = await snapshot('u1');
    const { res, json } = await call('u2', 'PATCH', `/api/subscriptions/${sa.id}`, {
      title: 'Hijacked',
      folderId: null,
    });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await snapshot('u1')).toEqual(before);
  });

  it('B moving their own subscription into A’s folder gets 404 not_found, and nothing changes', async () => {
    const before = { a: await snapshot('u1'), b: await snapshot('u2') };
    const { res, json } = await call('u2', 'PATCH', `/api/subscriptions/${sb.id}`, {
      folderId: fa.id,
    });
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect({ a: await snapshot('u1'), b: await snapshot('u2') }).toEqual(before);
    const nope = await call('u2', 'PATCH', `/api/subscriptions/${sb.id}`, { folderId: 'nope' });
    expect(nope.json).toEqual(json);
  });

  it('B unsubscribing with A’s subscription ID gets 404 not_found, and A’s subscription and entries are unchanged', async () => {
    const before = await snapshot('u1');
    const { res, json } = await call('u2', 'DELETE', `/api/subscriptions/${sa.id}`);
    expect(res.status).toBe(404);
    expect(code(json)).toBe('not_found');
    expect(await snapshot('u1')).toEqual(before);
    expect(await count('user_entries', 'user_id = ?', 'u2')).toBe(1);
  });

  it('B’s unsubscribe from a feed A shares leaves A’s subscription, entries and schedule alone', async () => {
    const feedId = await seedFeed({ subscribers: ['u1', 'u2'], nextFetchAt: 777 });
    await call('u2', 'DELETE', `/api/subscriptions/u2-${feedId}`);
    expect(await count('subscriptions', 'user_id = ? AND feed_id = ?', 'u1', feedId)).toBe(1);
    const row = await db.first<{ next_fetch_at: number }>(
      sql('SELECT next_fetch_at FROM feeds WHERE id = ?', feedId),
    );
    expect(row?.next_fetch_at).toBe(777);
  });

  it('B’s folder and subscription lists never contain A’s', async () => {
    expect(await folderNames('u2')).toEqual([]);
    expect((await subs('u2')).map((s) => s.id)).toEqual([sb.id]);
  });
});

describe('health.warning comes from feeds.warning_code (TID-046, fixed message)', () => {
  it('is the fixed new_item_cap message when set, and null otherwise', async () => {
    const { id, feedId } = await seedSub('u1');
    expect((await subs('u1'))[0]?.health.warning).toBeNull();
    await db.run(sql("UPDATE feeds SET warning_code = 'new_item_cap' WHERE id = ?", feedId));
    const warning = (await subs('u1'))[0]?.health.warning;
    expect(warning).toMatch(/too many new items/);
    const patched = await call('u1', 'PATCH', `/api/subscriptions/${id}`, { title: 'x' });
    expect((patched.json as Subscription).health.warning).toBe(warning);
  });
});
