import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Folder, ImportOpmlRequest, ImportOpmlResponse } from '@tidings/shared';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { sql } from '../src/db';
import { createFixture, db, resetData, type Fixture } from './support/refresh-harness';
import { seedSession, seedUser } from './support/seed';

// TID-016 adversarial input to POST /api/import/opml (QA): SSRF spellings, URL spellings, hostile
// titles and folder names. The client also validates, but the API must hold on its own.

let fx: Fixture;
let token: string;

async function post(body: unknown) {
  const res = await createApp({ clock: () => fx.clock.now() }).fetch(
    new Request(`${env.APP_ORIGIN}/api/import/opml`, {
      method: 'POST',
      headers: {
        Origin: env.APP_ORIGIN,
        Cookie: `${SESSION_COOKIE}=${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { res, json: (await res.json()) as ImportOpmlResponse };
}
const one = (xmlUrl: string, title?: string, folder = '') =>
  ({
    folders: folder ? [{ name: folder, feeds: [{ xmlUrl, title }] }] : [],
    feeds: folder ? [] : [{ xmlUrl, title }],
  }) as ImportOpmlRequest;

beforeEach(async () => {
  await resetData();
  fx = createFixture();
  await seedUser('u1');
  token = await seedSession('u1', { now: Math.floor(fx.clock.now() / 1000) });
});

describe('SSRF: every imported URL goes through checkUrl', () => {
  it.each([
    'http://127.0.0.1/feed',
    'http://localhost/feed',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed',
    'http://[::ffff:127.0.0.1]/feed',
    'http://10.0.0.5/feed',
    'http://192.168.1.1/feed',
    'http://172.16.0.1/feed',
    'http://0x7f000001/feed',
    'http://2130706433/feed',
    'http://127.1/feed',
    'http://metadata.google.internal/feed',
    'http://user:pass@127.0.0.1/feed',
    'http://intranet/feed',
    'http://printer.local/feed',
  ])('%s is never subscribed', async (url) => {
    const { json } = await post(one(url));
    expect(json.created).toBe(0);
    expect(json.invalid).toHaveLength(1);
    expect(await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM feeds'))).toEqual({ n: 0 });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/xml,x',
    'file:///etc/passwd',
    'ftp://a.example.com/f',
  ])('%s is invalid_url', async (url) => {
    const { json } = await post(one(url));
    expect(json.invalid).toEqual([{ url, reason: 'invalid_url' }]);
  });
});

describe('the same feed written several ways', () => {
  it('becomes one feed row and one subscription', async () => {
    const { json } = await post({
      folders: [
        {
          name: 'A',
          feeds: ['https://Example.COM/feed', 'https://example.com:443/feed#x'].map((xmlUrl) => ({
            xmlUrl,
          })),
        },
        { name: 'B', feeds: [{ xmlUrl: 'HTTPS://example.com/feed' }] },
      ],
      feeds: [],
    });
    expect(json.created).toBe(1);
    expect(await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM feeds'))).toEqual({ n: 1 });
    expect(await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM subscriptions'))).toEqual({
      n: 1,
    });
  });
});

describe('hostile titles and folder names are stored as inert, bounded text', () => {
  it('clips a 1,500-character title to 200 and a folder name to 64, and keeps markup literal', async () => {
    const markup = '<img src=x onerror=alert(1)>';
    await post(
      one('https://a.example.com/f', markup + 'a'.repeat(1500), markup + 'b'.repeat(1500)),
    );
    const row = await db.first<{ t: string; f: string }>(
      sql(
        'SELECT s.title_override t, f.name f FROM subscriptions s JOIN folders f ON f.id = s.folder_id',
      ),
    );
    expect(row!.t.length).toBeLessThanOrEqual(200);
    expect(row!.f.length).toBeLessThanOrEqual(64);
    expect(row!.t.startsWith(markup)).toBe(true); // stored literally; React escapes on output
  });

  it('a whitespace-only folder name means no folder, and a whitespace-only title means no title', async () => {
    const { json } = await post(one('https://a.example.com/f', '   ', '   '));
    expect(json.created).toBe(1);
    expect(await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM folders'))).toEqual({ n: 0 });
    const row = await db.first<{ t: string | null }>(
      sql('SELECT title_override t FROM subscriptions'),
    );
    expect(row!.t).toBeNull();
  });

  it.fails(
    'DEF-060: a zero-width-only folder name does not create an invisible folder',
    async () => {
      await post(one('https://a.example.com/f', undefined, '​‌‍'));
      expect(await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM folders'))).toEqual({
        n: 0,
      });
    },
  );

  it.fails('DEF-060: a zero-width-only title is not stored as the custom title', async () => {
    await post(one('https://a.example.com/f', '​‌‍'));
    const row = await db.first<{ t: string | null }>(
      sql('SELECT title_override t FROM subscriptions'),
    );
    expect(row!.t).toBeNull();
  });

  it.fails('DEF-061: clipping never leaves half of a surrogate pair', async () => {
    await post(
      one('https://a.example.com/f', 'a'.repeat(199) + '\u{1F600}', 'a'.repeat(63) + '\u{1F600}'),
    );
    const row = await db.first<{ t: string; f: string }>(
      sql(
        'SELECT s.title_override t, f.name f FROM subscriptions s JOIN folders f ON f.id = s.folder_id',
      ),
    );
    expect(row!.t).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(row!.f).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('folder names that differ only in case share one folder (first spelling wins)', async () => {
    await post({
      folders: [
        { name: 'News', feeds: [{ xmlUrl: 'https://a.example.com/f' }] },
        { name: 'NEWS', feeds: [{ xmlUrl: 'https://b.example.com/f' }] },
      ],
      feeds: [],
    });
    const rows = await db.all<Folder>(sql('SELECT id, name FROM folders'));
    expect(rows.rows.map((r) => r.name)).toEqual(['News']);
  });

  it('a request with 100 distinct hostile folder names creates at most 100 folders, never more than 200 in total', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `F${i}`);
    const req = (off: number): ImportOpmlRequest => ({
      folders: names.map((n, i) => ({
        name: `${n}-${off}`,
        feeds: [{ xmlUrl: `https://h${off}-${i}.example.com/f` }],
      })),
      feeds: [],
    });
    for (const off of [0, 1, 2]) await post(req(off));
    const n = await db.first<{ n: number }>(sql('SELECT COUNT(*) n FROM folders'));
    expect(n!.n).toBeLessThanOrEqual(200);
  });
});

describe('body shape', () => {
  it('an over-long URL is reported invalid rather than failing the request, and 5,000 chars at the field limit is refused', async () => {
    const long = 'https://a.example.com/' + 'x'.repeat(3000);
    const { res, json } = await post(one(long));
    expect(res.status).toBe(200);
    expect(json.invalid).toHaveLength(1);
    expect((await post(one('https://a.example.com/' + 'x'.repeat(5000)))).res.status).toBe(400);
  });
});
