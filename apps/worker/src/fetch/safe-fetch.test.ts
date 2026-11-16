import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch } from '@tidings/test-utils';
import { MAX_BODY_BYTES, safeFetch, type SafeFetchOptions } from './safe-fetch';

const APP_ORIGIN = 'https://tidings.mcn.am';
const FEED = 'https://example.com/feed.xml';

function setup() {
  const f = createFakeFetch();
  const opts = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    fetch: f.fetch,
    appOrigin: APP_ORIGIN,
    ...extra,
  });
  return { f, opts };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('redirects (AC2, AC3)', () => {
  it('AC2: a 301 to 127.0.0.1 is not followed', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: 'http://127.0.0.1/', status: 301 });
    f.route('http://127.0.0.1/', { body: 'secret' });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'error', code: 'blocked_address' });
    expect(f.calls.map((c) => c.url)).toEqual([FEED]);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://localhost/',
    'ftp://example.com/x',
    'https://tidings.mcn.am/api/health',
  ])('AC2: redirect to %s is refused', async (target) => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: target });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('error');
    expect(f.calls).toHaveLength(1);
  });

  it('follows a relative redirect and records the hop', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: '/new.xml', status: 301 });
    f.route('https://example.com/new.xml', { body: '<rss/>' });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.url).toBe('https://example.com/new.xml');
    expect(res.redirects).toEqual([{ from: FEED, to: 'https://example.com/new.xml', status: 301 }]);
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('AC3: 3 redirects succeed', async () => {
    const { f, opts } = setup();
    f.route('https://example.com/r0', { redirectTo: '/r1' });
    f.route('https://example.com/r1', { redirectTo: '/r2' });
    f.route('https://example.com/r2', { redirectTo: '/final' });
    f.route('https://example.com/final', { body: 'ok' });
    const res = await safeFetch('https://example.com/r0', opts());
    expect(res.kind).toBe('ok');
    expect(f.calls).toHaveLength(4);
  });

  it('AC3: a chain of 4 redirects stops after 3 with too_many_redirects', async () => {
    const { f, opts } = setup();
    for (let i = 0; i < 5; i++) {
      f.route(`https://example.com/r${i}`, { redirectTo: `/r${i + 1}` });
    }
    const res = await safeFetch('https://example.com/r0', opts());
    expect(res).toMatchObject({ kind: 'error', code: 'too_many_redirects' });
    expect(f.calls).toHaveLength(4); // the original request plus 3 followed hops
  });

  it('a redirect loop ends in too_many_redirects', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: FEED });
    expect(await safeFetch(FEED, opts())).toMatchObject({ code: 'too_many_redirects' });
  });

  it('a redirect without Location is invalid_url', async () => {
    const { f, opts } = setup();
    f.route(FEED, { status: 302 });
    expect(await safeFetch(FEED, opts())).toMatchObject({ code: 'invalid_url' });
  });
});

describe('size and time limits (AC4)', () => {
  it('MAX_BODY_BYTES is 1 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(1_048_576);
  });

  it('accepts exactly 1 MiB', async () => {
    const { f, opts } = setup();
    f.route(FEED, { body: new Uint8Array(MAX_BODY_BYTES) });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.body.byteLength).toBe(MAX_BODY_BYTES);
  });

  it('rejects 1 MiB + 1 byte as too_large', async () => {
    const { f, opts } = setup();
    f.route(FEED, { body: new Uint8Array(MAX_BODY_BYTES + 1) });
    expect(await safeFetch(FEED, opts())).toMatchObject({ kind: 'error', code: 'too_large' });
  });

  it('aborts the read once the cap is crossed (chunked, no Content-Length)', async () => {
    const { f, opts } = setup();
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024);
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'error', code: 'too_large' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // an endless stream was not drained
  });

  it('rejects early on an oversize Content-Length', async () => {
    const { f, opts } = setup();
    let pulled = 0;
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled++;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
      });
    });
    expect(await safeFetch(FEED, opts())).toMatchObject({ code: 'too_large' });
    expect(pulled).toBe(0);
  });

  it('a server that never answers times out after 10 s', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    f.route(FEED, { hang: true });
    const pending = safeFetch(FEED, opts());
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'error', code: 'timeout' });
    expect(f.calls[0]?.signal?.aborted).toBe(true);
  });

  it('a body that stalls mid-stream times out', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('<rss>'));
        },
        pull: () => new Promise(() => undefined),
      });
      return new Response(stream, { status: 200 });
    });
    const pending = safeFetch(FEED, opts());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ kind: 'error', code: 'timeout' });
  });

  it('the 10 s budget is total across redirect hops', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: 'https://example.com/b', delayMs: 6_000 });
    f.route('https://example.com/b', { body: 'x', delayMs: 6_000 });
    const pending = safeFetch(FEED, opts());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ code: 'timeout' });
  });

  it('a network error is network_error, not timeout', async () => {
    const { f, opts } = setup();
    f.route(FEED, { error: new TypeError('connection reset') });
    expect(await safeFetch(FEED, opts())).toMatchObject({
      kind: 'error',
      code: 'network_error',
      message: 'connection reset',
    });
  });
});

describe('request headers (AC5)', () => {
  it('sends validators, the Tidings User-Agent, Accept, GET and redirect: manual', async () => {
    const { f, opts } = setup();
    f.route(FEED, { status: 304 });
    const res = await safeFetch(
      FEED,
      opts({ etag: '"abc"', lastModified: 'Tue, 10 Nov 2026 12:00:00 GMT' }),
    );
    expect(res).toMatchObject({ kind: 'not_modified', status: 304 });
    const call = f.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.redirect).toBe('manual');
    expect(call?.headers.get('if-none-match')).toBe('"abc"');
    expect(call?.headers.get('if-modified-since')).toBe('Tue, 10 Nov 2026 12:00:00 GMT');
    expect(call?.headers.get('user-agent')).toBe(`Tidings/1.0 (+${APP_ORIGIN})`);
    expect(call?.headers.get('accept')).toBe(
      'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
    );
  });

  it('omits validators when none are given', async () => {
    const { f, opts } = setup();
    f.route(FEED, { body: 'x' });
    await safeFetch(FEED, opts({ etag: null, lastModified: null }));
    expect(f.calls[0]?.headers.has('if-none-match')).toBe(false);
    expect(f.calls[0]?.headers.has('if-modified-since')).toBe(false);
  });

  it('works with serveFeed conditional GET handling', async () => {
    const { f, opts } = setup();
    f.serveFeed(FEED, '<rss/>', { etag: '"v1"' });
    const first = await safeFetch(FEED, opts());
    expect(first.kind).toBe('ok');
    const second = await safeFetch(FEED, opts({ etag: '"v1"' }));
    expect(second.kind).toBe('not_modified');
  });

  it('never sends cookies or auth headers, on any hop', async () => {
    const { f, opts } = setup();
    f.route(FEED, {
      redirectTo: 'https://other.example.org/feed',
      headers: { 'Set-Cookie': 'a=b' },
    });
    f.route('https://other.example.org/feed', { body: 'x' });
    await safeFetch(FEED, opts({ etag: '"e"' }));
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      for (const h of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key']) {
        expect(call.headers.has(h)).toBe(false);
      }
      expect([...call.headers.keys()].sort()).toEqual(
        ['accept', 'if-none-match', 'user-agent'].sort(),
      );
    }
  });
});

describe('results (AC7 and status handling)', () => {
  it('AC7: 200 returns the body bytes and their SHA-256', async () => {
    const { f, opts } = setup();
    const bytes = new TextEncoder().encode('<rss>héllo</rss>');
    f.route(FEED, { body: bytes, headers: { ETag: '"x"' } });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.status).toBe(200);
    expect([...res.body]).toEqual([...bytes]);
    expect(res.sha256).toBe(await sha256Hex(bytes));
    expect(res.headers.get('etag')).toBe('"x"');
  });

  it('AC7: hash is correct across many chunks', async () => {
    const { f, opts } = setup();
    const parts = [
      new Uint8Array(70_000).fill(1),
      new Uint8Array(5).fill(2),
      new Uint8Array(3000).fill(3),
    ];
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const p of parts) c.enqueue(p);
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    expect(res.body.byteLength).toBe(all.length);
    expect(res.sha256).toBe(await sha256Hex(all));
  });

  it('an empty 200 body hashes the empty input', async () => {
    const { f, opts } = setup();
    f.route(FEED, { status: 200 });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({
      kind: 'ok',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it.each([404, 410, 429, 500, 503])('non-2xx %i is an http_error with headers', async (status) => {
    const { f, opts } = setup();
    f.route(FEED, { status, retryAfter: 120, body: 'nope' });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'http_error', status });
    if (res.kind === 'http_error') expect(res.headers.get('retry-after')).toBe('120');
  });
});
