import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterEach(() => server.reset());
afterAll(() => server.close());

const ATOM = '/feeds/atom-basic.xml';

describe('fixture server (TID-005 AC4)', () => {
  it('AC4: serves a fixture with ETag and Last-Modified', async () => {
    const res = await fetch(server.url(ATOM));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(await res.text()).toContain('<feed');
  });

  it('AC4: returns 304 for a matching If-None-Match and 200 for a stale one', async () => {
    const etag = (await fetch(server.url(ATOM))).headers.get('etag') as string;
    const hit = await fetch(server.url(ATOM), { headers: { 'If-None-Match': etag } });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe('');
    const miss = await fetch(server.url(ATOM), { headers: { 'If-None-Match': '"stale"' } });
    expect(miss.status).toBe(200);
  });

  it('AC4: returns 304 for a matching If-Modified-Since', async () => {
    const lm = (await fetch(server.url(ATOM))).headers.get('last-modified') as string;
    const res = await fetch(server.url(ATOM), { headers: { 'If-Modified-Since': lm } });
    expect(res.status).toBe(304);
  });

  it('AC4: setBody changes the ETag so the old validator no longer matches', async () => {
    const etag = (await fetch(server.url(ATOM))).headers.get('etag') as string;
    server.setBody(ATOM, '<feed xmlns="http://www.w3.org/2005/Atom"><title>changed</title></feed>');
    const res = await fetch(server.url(ATOM), { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(etag);
  });

  it.each([404, 410, 500])('AC4: can be scripted to return %i', async (status) => {
    server.script(ATOM, { status });
    expect((await fetch(server.url(ATOM))).status).toBe(status);
  });

  it('AC4: can be scripted to return 429 with Retry-After (seconds and date forms)', async () => {
    server.script(
      ATOM,
      { status: 429, retryAfter: 90, times: 1 },
      { status: 429, retryAfter: 'Wed, 11 Nov 2026 12:00:00 GMT', times: 1 },
    );
    const a = await fetch(server.url(ATOM));
    expect([a.status, a.headers.get('retry-after')]).toEqual([429, '90']);
    const b = await fetch(server.url(ATOM));
    expect([b.status, b.headers.get('retry-after')]).toEqual([
      429,
      'Wed, 11 Nov 2026 12:00:00 GMT',
    ]);
    expect((await fetch(server.url(ATOM))).status).toBe(200);
  });

  it('AC4: scripted behaviour with times falls back to the fixture afterwards', async () => {
    server.script(ATOM, { status: 500, times: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(server.url(ATOM))).status);
    expect(statuses).toEqual([500, 500, 200]);
  });

  it('AC4: redirects (301, 302, 308) and redirect chains', async () => {
    server.script('/old.xml', { redirectTo: '/feeds/atom-basic.xml', redirectStatus: 301 });
    const manual = await fetch(server.url('/old.xml'), { redirect: 'manual' });
    expect(manual.status).toBe(301);
    expect(manual.headers.get('location')).toBe(server.url(ATOM));
    const followed = await fetch(server.url('/old.xml'));
    expect(followed.status).toBe(200);

    server.script('/hop1', { redirectTo: '/hop2', redirectStatus: 308 });
    server.script('/hop2', { redirectTo: ATOM });
    const chain = await fetch(server.url('/hop1'));
    expect(chain.url).toBe(server.url(ATOM));
    expect(chain.status).toBe(200);
  });

  it('AC4: redirect loop can be scripted', async () => {
    server.script('/loop-a', { redirectTo: '/loop-b' });
    server.script('/loop-b', { redirectTo: '/loop-a' });
    await expect(fetch(server.url('/loop-a'))).rejects.toThrow();
  });

  it('AC4: slow responses honour delayMs, and hang never answers until the client aborts', async () => {
    server.script(ATOM, { delayMs: 150, times: 1 });
    const t0 = Date.now();
    expect((await fetch(server.url(ATOM))).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    server.script(ATOM, { hang: true });
    await expect(fetch(server.url(ATOM), { signal: AbortSignal.timeout(100) })).rejects.toThrow();
  });

  it('AC4: oversized bodies, with Content-Length or chunked without it', async () => {
    server.script('/big.xml', { oversizeBytes: 2_000_000 });
    const withLength = await fetch(server.url('/big.xml'));
    expect(withLength.headers.get('content-length')).toBe(
      String((await withLength.arrayBuffer()).byteLength),
    );
    expect(Number(withLength.headers.get('content-length'))).toBeGreaterThanOrEqual(1_999_000);

    server.script('/big-chunked.xml', { oversizeBytes: 1_000_000, chunked: true });
    const chunked = await fetch(server.url('/big-chunked.xml'));
    expect(chunked.headers.get('content-length')).toBeNull();
    expect((await chunked.arrayBuffer()).byteLength).toBeGreaterThanOrEqual(999_000);
  });

  it('serves generated feeds and 404s for unknown names', async () => {
    const res = await fetch(server.url('/feeds/generated/rss-small.xml'));
    expect(res.status).toBe(200);
    expect((await fetch(server.url('/feeds/generated/nope.xml'))).status).toBe(404);
    expect((await fetch(server.url('/feeds/does-not-exist.xml'))).status).toBe(404);
    expect((await fetch(server.url('/feeds/..%2f..%2fpackage.json'))).status).toBe(404);
  });

  it('records requests, including conditional headers and statuses', async () => {
    const etag = (await fetch(server.url(ATOM))).headers.get('etag') as string;
    await fetch(server.url(ATOM), {
      headers: { 'If-None-Match': etag, 'User-Agent': 'Tidings-test' },
    });
    const reqs = server.requests(ATOM);
    expect(reqs.map((r) => r.status)).toEqual([200, 304]);
    expect(reqs[1]?.headers['if-none-match']).toBe(etag);
    expect(reqs[1]?.headers['user-agent']).toBe('Tidings-test');
  });
});
