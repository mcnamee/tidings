import { describe, expect, it } from 'vitest';
import { createFakeFetch, createFixedClock, DAY, FIXED_NOW } from './index';

describe('fixed clock', () => {
  it('starts at the fixed instant and only moves when told to', () => {
    const c = createFixedClock();
    expect(c.now()).toBe(FIXED_NOW);
    expect(c.iso()).toBe('2026-11-10T12:00:00.000Z');
    c.advance(DAY);
    expect(c.iso()).toBe('2026-11-11T12:00:00.000Z');
    c.set('2026-03-29T01:59:59Z');
    expect(c.date().getUTCHours()).toBe(1);
  });

  it('rejects invalid times', () => {
    expect(() => createFixedClock('nonsense')).toThrow();
    expect(() => createFixedClock().set('nonsense')).toThrow();
  });
});

describe('fake fetch', () => {
  it('throws for unmatched URLs instead of using the network', async () => {
    const f = createFakeFetch();
    await expect(f.fetch('https://unmocked.example.test/')).rejects.toThrow(/no route/);
  });

  it('records calls and answers scripted statuses with Retry-After', async () => {
    const f = createFakeFetch();
    f.route('https://a.example.test/feed', { status: 429, retryAfter: 120 });
    const res = await f.fetch('https://a.example.test/feed', {
      headers: { 'User-Agent': 'Tidings' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.headers.get('user-agent')).toBe('Tidings');
  });

  it('serveFeed honours If-None-Match and If-Modified-Since with a 304', async () => {
    const f = createFakeFetch();
    const feed = f.serveFeed('https://a.example.test/feed', '<rss/>', { etag: '"abc"' });
    const first = await f.fetch('https://a.example.test/feed');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('<rss/>');

    const byEtag = await f.fetch('https://a.example.test/feed', {
      headers: { 'If-None-Match': '"abc"' },
    });
    expect(byEtag.status).toBe(304);
    expect(await byEtag.text()).toBe('');

    const byDate = await f.fetch('https://a.example.test/feed', {
      headers: { 'If-Modified-Since': 'Tue, 10 Nov 2026 12:00:00 GMT' },
    });
    expect(byDate.status).toBe(304);

    feed.update('<rss>changed</rss>');
    const stale = await f.fetch('https://a.example.test/feed', {
      headers: { 'If-None-Match': '"abc"' },
    });
    expect(stale.status).toBe(200);
  });

  it('produces redirects, network errors and respects timeouts via AbortSignal', async () => {
    const f = createFakeFetch();
    f.route('https://a.example.test/old', { redirectTo: '/new', status: 301 });
    const r = await f.fetch('https://a.example.test/old', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://a.example.test/new');

    f.route('https://a.example.test/down', { error: new TypeError('connection reset') });
    await expect(f.fetch('https://a.example.test/down')).rejects.toThrow('connection reset');

    f.route('https://a.example.test/slow', { hang: true });
    await expect(
      f.fetch('https://a.example.test/slow', { signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow();
  });

  it('limits a route with times, then falls back to the earlier one', async () => {
    const f = createFakeFetch();
    f.route('https://a.example.test/x', { status: 200, body: 'ok' });
    f.route('https://a.example.test/x', { status: 500 }, { times: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await f.fetch('https://a.example.test/x')).status);
    expect(statuses).toEqual([500, 500, 200]);
  });
});
