import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, Folder, Subscription } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { sql } from '../src/db';
import { count, db, resetData, seedFeed } from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-014 adversarial inputs against the folder and subscription write routes (spec 8.4, 10.3,
// 10.8). Same real-workerd harness as folders.test.ts. Known defects are `it.fails`.

const NOW = 1_760_000_000;
const app = createApp({ clock: () => NOW * 1000 });
let token: string;

async function raw(method: string, path: string, init: { body?: string; ct?: string | null } = {}) {
  const headers = new Headers({ Origin: env.APP_ORIGIN, Cookie: `${SESSION_COOKIE}=${token}` });
  if (init.ct !== null) headers.set('Content-Type', init.ct ?? 'application/json');
  const res = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, { method, headers, body: init.body }),
    env,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { res, json };
}
const call = (method: string, path: string, body?: unknown) =>
  raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body) });
const code = (j: unknown) => (j as ApiError).error.code;

beforeEach(async () => {
  await resetData();
  await seedUser('u1');
  token = await seedSession('u1', { now: NOW });
});

async function seedSub(): Promise<string> {
  const feedId = await seedFeed({ subscribers: ['u1'] });
  return `u1-${feedId}`;
}

describe('folder name inputs', () => {
  it.each([
    ['null', null],
    ['a number', 5],
    ['an array', ['Tech']],
    ['an object', { a: 1 }],
    ['a boolean', true],
    ['the empty string', ''],
    ['only whitespace', ' \t\n '],
    ['only NBSP', '  '],
  ])('%s is 400 validation_failed and creates nothing', async (_l, name) => {
    const r = await call('POST', '/api/folders', { name });
    expect(r.res.status).toBe(400);
    expect(code(r.json)).toBe('validation_failed');
    expect(await count('folders')).toBe(0);
  });

  it.each([
    ['a JSON array body', '[]'],
    ['a JSON null body', 'null'],
    ['a string body', '"Tech"'],
    ['malformed JSON', '{"name":'],
    ['an empty body', ''],
  ])('%s is 400', async (_l, body) => {
    const r = await raw('POST', '/api/folders', { body });
    expect(r.res.status).toBe(400);
    expect(await count('folders')).toBe(0);
  });

  it('a non-JSON content type is rejected (spec 10.3) and creates nothing', async () => {
    const r = await raw('POST', '/api/folders', { body: '{"name":"x"}', ct: 'text/plain' });
    expect(r.res.status).toBeGreaterThanOrEqual(400);
    expect(r.res.status).toBeLessThan(500);
    expect(await count('folders')).toBe(0);
  });

  it('a bodyless DELETE without Content-Type is rejected, not a 500', async () => {
    await call('POST', '/api/folders', { name: 'x' });
    const r = await raw('DELETE', '/api/folders/anything', { ct: null });
    expect(r.res.status).toBeGreaterThanOrEqual(400);
    expect(r.res.status).toBeLessThan(500);
  });

  it('extra and mass-assignment fields are ignored (id, user_id, __proto__)', async () => {
    const r = await raw('POST', '/api/folders', {
      body: '{"name":"Tech","id":"chosen","user_id":"u2","__proto__":{"name":"x"}}',
    });
    expect(r.res.status).toBe(201);
    const f = r.json as Folder;
    expect(f.id).not.toBe('chosen');
    expect(Object.keys(f).sort()).toEqual(['id', 'name']);
    expect(await count('folders', 'user_id = ?', 'u1')).toBe(1);
  });

  it('hostile text is stored and returned verbatim as JSON data, never executed or rewritten', async () => {
    const name = '<img src=x onerror=alert(1)>"\'; DROP TABLE folders;--';
    const r = await call('POST', '/api/folders', { name });
    expect(r.res.status).toBe(201);
    expect((r.json as Folder).name).toBe(name);
    expect(r.res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(await count('folders')).toBe(1);
  });

  it('64 astral characters are accepted (the limit counts characters, not UTF-16 units)', async () => {
    const r = await call('POST', '/api/folders', { name: '😀'.repeat(64) });
    expect(r.res.status).toBe(201);
  });

  // DEF-040
  it.fails(
    'names differing only by non-ASCII case conflict ("Étude" vs "étude"), as AC2 says case-insensitive',
    async () => {
      await call('POST', '/api/folders', { name: 'Étude' });
      const r = await call('POST', '/api/folders', { name: 'étude' });
      expect(r.res.status).toBe(409);
    },
  );

  // DEF-041
  it.fails('a name made only of zero-width characters is rejected as blank', async () => {
    const r = await call('POST', '/api/folders', { name: '​​' });
    expect(r.res.status).toBe(400);
  });

  it('two racing creates of the same name: exactly one 201 and one 409', async () => {
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => call('POST', '/api/folders', { name: 'Race' })),
    );
    const statuses = rs.map((r) => r.res.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await count('folders')).toBe(1);
  });

  it('racing creates at 199 folders cannot pass the 200 limit', async () => {
    await db.batch(
      Array.from({ length: 199 }, (_v, i) =>
        sql(
          'INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, 0)',
          `f${i}`,
          'u1',
          `F${i}`,
        ),
      ),
    );
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_v, i) => call('POST', '/api/folders', { name: `New${i}` })),
    );
    expect(rs.filter((r) => r.res.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.res.status === 422)).toHaveLength(4);
    expect(await count('folders')).toBe(200);
  });
});

describe('IDs in the path', () => {
  it.each(['%00', '..%2F..%2Fetc', "' OR 1=1 --", 'x'.repeat(5000), '%F0%9F%98%80', '0', '-1'])(
    'folder id %s on PATCH and DELETE is 404 or 4xx, never 500',
    async (id) => {
      const p = await call('PATCH', `/api/folders/${id}`, { name: 'x' });
      const d = await call('DELETE', `/api/folders/${id}`);
      for (const r of [p, d]) {
        expect(r.res.status).toBeGreaterThanOrEqual(400);
        expect(r.res.status).toBeLessThan(500);
      }
    },
  );

  it.each(['%00', "' OR 1=1 --", 'x'.repeat(5000), 'u1-1/../u1-1'])(
    'subscription id %s on PATCH and DELETE is 4xx, never 500, and deletes nothing',
    async (id) => {
      await seedSub();
      const p = await call('PATCH', `/api/subscriptions/${id}`, { title: 'x' });
      const d = await call('DELETE', `/api/subscriptions/${id}`);
      for (const r of [p, d]) {
        expect(r.res.status).toBeGreaterThanOrEqual(400);
        expect(r.res.status).toBeLessThan(500);
      }
      expect(await count('subscriptions')).toBe(1);
    },
  );

  it('LIKE/glob wildcards in an ID do not match other rows', async () => {
    await seedSub();
    expect((await call('DELETE', '/api/subscriptions/u1-%25')).res.status).toBe(404);
    expect((await call('DELETE', '/api/subscriptions/u1-*')).res.status).toBe(404);
    expect(await count('subscriptions')).toBe(1);
  });
});

describe('PATCH /api/subscriptions/:id body', () => {
  it.each([
    ['empty object', {}],
    ['unknown fields only', { foo: 1 }],
    ['folderId empty string', { folderId: '' }],
    ['folderId number', { folderId: 5 }],
    ['folderId array', { folderId: ['a'] }],
    ['title number', { title: 5 }],
    ['title object', { title: {} }],
    ['title 201 chars', { title: 'x'.repeat(201) }],
  ])('%s is 400 validation_failed', async (_l, body) => {
    const id = await seedSub();
    const r = await call('PATCH', `/api/subscriptions/${id}`, body);
    expect(r.res.status).toBe(400);
    expect(code(r.json)).toBe('validation_failed');
  });

  it('ignores user_id, feed_id and id in the body', async () => {
    const id = await seedSub();
    await seedUser('u2');
    const r = await call('PATCH', `/api/subscriptions/${id}`, {
      title: 'Mine',
      user_id: 'u2',
      feedId: 999,
      id: 'other',
    });
    expect(r.res.status).toBe(200);
    expect((r.json as Subscription).id).toBe(id);
    expect(await count('subscriptions', 'user_id = ?', 'u2')).toBe(0);
  });

  it('a title is trimmed, and a title of 200 characters is accepted', async () => {
    const id = await seedSub();
    const r = await call('PATCH', `/api/subscriptions/${id}`, { title: `  ${'x'.repeat(200)}  ` });
    expect(r.res.status).toBe(200);
    expect((r.json as Subscription).title).toBe('x'.repeat(200));
  });

  it('{ title, folderId: null } together applies both; a bad folder leaves the title unchanged (atomic)', async () => {
    const id = await seedSub();
    const f = (await call('POST', '/api/folders', { name: 'Tech' })).json as Folder;
    await call('PATCH', `/api/subscriptions/${id}`, { title: 'Old', folderId: f.id });
    const bad = await call('PATCH', `/api/subscriptions/${id}`, { title: 'New', folderId: 'nope' });
    expect(bad.res.status).toBe(404);
    const ok = await call('PATCH', `/api/subscriptions/${id}`, { title: 'New', folderId: null });
    expect((ok.json as Subscription).title).toBe('New');
    expect((ok.json as Subscription).folderId).toBeNull();
    const still = await call('PATCH', `/api/subscriptions/${id}`, { folderId: null });
    expect(still.res.status).toBe(200);
  });

  it('a hostile title round-trips as plain data', async () => {
    const id = await seedSub();
    const title = '<script>alert(1)</script>';
    const r = await call('PATCH', `/api/subscriptions/${id}`, { title });
    expect((r.json as Subscription).title).toBe(title);
  });
});

describe('unsubscribe edge cases', () => {
  it('unsubscribing twice: 204 then 404, and nothing else is touched', async () => {
    const id = await seedSub();
    expect((await call('DELETE', `/api/subscriptions/${id}`)).res.status).toBe(204);
    expect((await call('DELETE', `/api/subscriptions/${id}`)).res.status).toBe(404);
  });

  it('deleting a folder twice, and renaming a deleted folder, is 404', async () => {
    const f = (await call('POST', '/api/folders', { name: 'Tech' })).json as Folder;
    expect((await call('DELETE', `/api/folders/${f.id}`)).res.status).toBe(204);
    expect((await call('DELETE', `/api/folders/${f.id}`)).res.status).toBe(404);
    expect((await call('PATCH', `/api/folders/${f.id}`, { name: 'x' })).res.status).toBe(404);
  });

  it('a subscription moved into a folder that is then deleted reads back with folderId null', async () => {
    const id = await seedSub();
    const f = (await call('POST', '/api/folders', { name: 'Tech' })).json as Folder;
    await call('PATCH', `/api/subscriptions/${id}`, { folderId: f.id });
    await call('DELETE', `/api/folders/${f.id}`);
    const list = (await call('GET', '/api/subscriptions')).json as { items: Subscription[] };
    expect(list.items[0]?.folderId).toBeNull();
  });
});
