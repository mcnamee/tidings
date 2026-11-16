/**
 * TID-010 adversarial suite (tester). Extends the engineer's tests with hostile IP and host
 * encodings, URL-parser differentials, hostile redirects, lying and compressed bodies, and
 * slow-drip responses. No test touches the network: every `fetch` is an injected fake, and an
 * unrouted URL throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch } from '@tidings/test-utils';
import { checkUrl } from './address';
import { MAX_BODY_BYTES, safeFetch, type SafeFetchOptions } from './safe-fetch';

const APP_ORIGIN = 'https://tidings.mcn.am';
const FEED = 'https://example.com/feed.xml';

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const f = createFakeFetch();
  const opts = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    fetch: f.fetch,
    appOrigin: APP_ORIGIN,
    ...extra,
  });
  return { f, opts };
}

/** A fetch that records the exact string it was handed, to compare against what was validated. */
function recordingFetch(respond: (url: string) => Response | Promise<Response>) {
  const inputs: string[] = [];
  const fetchFn = async (input: string): Promise<Response> => {
    inputs.push(String(input));
    return respond(String(input));
  };
  return { inputs, fetchFn };
}

describe('hostile IP and host encodings are refused with zero fetch calls', () => {
  const HOSTILE: string[] = [
    // IPv4 mixed radix and padding
    'http://0x7f.0.0.1/',
    'http://0177.0.0.01/',
    'http://127.000.000.001/',
    'http://0x7f.1/',
    'http://017700000001/',
    'http://2130706433./',
    'http://0x0/',
    'http://0x7f000001:8080/',
    'http://0xa9fea9fe/', // 169.254.169.254 as one hex number
    'http://2852039166/', // 169.254.169.254 as one decimal number
    'http://0251.0376.0251.0376/', // 169.254.169.254 in octal
    'http://100.100.100.200/', // Alibaba metadata, inside CGNAT
    'http://192.0.0.192/', // Oracle metadata, IETF protocol block
    // IPv6 forms
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/', // IPv4-compatible
    'http://[::7f00:1]/',
    'http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/',
    'http://[::ffff:0:127.0.0.1]/', // SIIT ::ffff:0:0/96
    'http://[::ffff:0:7f00:1]/',
    'http://[::ffff:0:0]/',
    'http://[64:ff9b::127.0.0.1]/', // NAT64
    'http://[64:ff9b:1::1]/',
    'http://[2001::1]/', // Teredo prefix
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo with embedded 192.0.2.45
    'http://[2002:a9fe:a9fe::]/', // 6to4 of 169.254.169.254
    'http://[2002:c0a8:101::]/', // 6to4 of 192.168.1.1
    'http://[2002:7f00:1::1]/',
    'http://[2001:db8::1]/',
    'http://[fe80::1]/',
    'http://[febf::1]/', // top of fe80::/10
    'http://[fec0::1]/', // site-local
    'http://[fd00:ec2::254]/', // AWS IPv6 metadata
    'http://[fc00::1]/',
    'http://[ff02::1]/',
    'http://[::1]:8080/',
    'http://[100::1]/', // discard prefix
    // Hostnames
    'http://localhost../',
    'http://localhost.../',
    'http://LoCaLhOsT/',
    'http://localhost%2e/',
    'http://%6c%6f%63%61%6c%68%6f%73%74/', // percent-encoded
    'http://%31%32%37.0.0.1/',
    'http://127。0。0。1/', // ideographic full stop
    'http://127．0．0．1/', // fullwidth full stop
    'http://①②⑦.0.0.1/', // circled digits
    'http://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/', // circled-letter "localhost"
    'http://ｌｏｃａｌｈｏｓｔ/', // fullwidth "localhost"
    'http://foo.localhost/',
    'http://foo.local./',
    'http://metadata.google.internal/',
    'http://metadata/',
    'http://instance-data/',
    'http://TIDINGS.MCN.AM:8443/', // the app itself, other port
    'http://tidings。mcn。am/', // the app itself, ideographic dots
    'http://ｔｉｄｉｎｇｓ.mcn.am/', // the app itself, fullwidth
    // Parser-differential shapes (authority is whatever the WHATWG parser says it is)
    'http://127.0.0.1\\@example.com/',
    'http://foo@127.0.0.1/',
    'http://:@127.0.0.1/',
    'http://example.com%2f@127.0.0.1/',
    'http:127.0.0.1',
    'http:/\\127.0.0.1',
    'http:///127.0.0.1/',
    'http://localhost\t/',
    '//127.0.0.1',
    '/relative',
    '',
    'http://',
    'http://[::1',
    'http://[fe80::1%25eth0]/', // zone ID: URL parser rejects
    'http://[fe80::1%eth0]/',
    'http://127.0.0.1%00.example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/xml,<rss/>',
    'gopher://example.com/',
    'ws://example.com/',
  ];

  it.each(HOSTILE)('%j', async (url) => {
    const f = createFakeFetch();
    const res = await safeFetch(url, { fetch: f.fetch, appOrigin: APP_ORIGIN });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(['blocked_address', 'invalid_url']).toContain(res.code);
    expect(f.calls).toHaveLength(0);
  });

  it('a 300-character label is not a security problem and is left to DNS (network_error)', async () => {
    const f = createFakeFetch();
    const url = `http://${'a'.repeat(300)}.com/`;
    f.route(() => true, { error: new TypeError('dns failure') });
    const res = await safeFetch(url, { fetch: f.fetch, appOrigin: APP_ORIGIN });
    expect(res).toMatchObject({ kind: 'error', code: 'network_error' });
  });
});

describe('public addresses in unusual forms are still allowed (no over-blocking)', () => {
  it.each([
    'http://[::ffff:8.8.8.8]/',
    'http://[2606:4700::1111]/',
    'http://[2002:808:808::]/', // 6to4 of a public v4
    'http://example.com./',
    'http://example.com:0080/',
    'https://example.com:443/',
    'https://xn--bcher-kva.example/',
    'http://8.8.8.8/',
    'http://169.253.0.1/', // just below link-local
    'http://172.15.255.255/', // just below 172.16/12
    'http://172.32.0.1/', // just above 172.16/12
    'http://100.63.255.255/', // just below CGNAT
    'http://100.128.0.1/', // just above CGNAT
  ])('%s', (url) => {
    expect(checkUrl(url, APP_ORIGIN, []).ok).toBe(true);
  });
});

describe('what is validated is exactly what is fetched (parser differential)', () => {
  // These look like they smuggle 127.0.0.1 but the WHATWG parser puts the host at example.com.
  // Safe if, and only if, the string handed to fetch is the canonical serialisation we validated.
  it.each([
    ['http://example.com\\@127.0.0.1/', 'http://example.com/@127.0.0.1/'],
    ['http://example.com#@127.0.0.1/', 'http://example.com/#@127.0.0.1/'],
    ['http://example.com?@127.0.0.1/', 'http://example.com/?@127.0.0.1/'],
    ['http://EXAMPLE.com:0080/a b', 'http://example.com/a%20b'],
    ['http://exa\tmple.com/fe\ned', 'http://example.com/feed'],
  ])('%j is fetched as %s', async (raw, canonical) => {
    const { inputs, fetchFn } = recordingFetch(() => new Response('<rss/>'));
    const res = await safeFetch(raw, { fetch: fetchFn, appOrigin: APP_ORIGIN });
    expect(res.kind).toBe('ok');
    expect(inputs).toEqual([canonical]);
    expect(new URL(inputs[0] as string).hostname).toBe('example.com');
  });

  it('every redirect hop is fetched as its validated canonical form', async () => {
    const hops: Record<string, string> = {
      'http://example.com/a': 'https://Example.ORG:443/b c',
      'https://example.org/b%20c': 'https://example.net:0443/\td',
    };
    const { inputs, fetchFn } = recordingFetch((url) => {
      const loc = hops[url];
      if (loc) return new Response(null, { status: 302, headers: { Location: loc } });
      return new Response('<rss/>');
    });
    const res = await safeFetch('http://example.com/a', { fetch: fetchFn, appOrigin: APP_ORIGIN });
    expect(res.kind).toBe('ok');
    expect(inputs).toEqual([
      'http://example.com/a',
      'https://example.org/b%20c',
      'https://example.net/d',
    ]);
  });
});

describe('hostile redirects', () => {
  async function redirectTo(location: string, status = 302) {
    const { f, opts } = setup();
    f.route(FEED, { status, headers: { Location: location } });
    const res = await safeFetch(FEED, opts());
    return { res, f };
  }

  it.each([
    '//127.0.0.1/', // protocol-relative
    '//127.0.0.1:8080/x',
    '//[::1]/',
    '///127.0.0.1/', // three slashes
    '\\\\127.0.0.1\\x', // backslashes
    '/\\127.0.0.1/',
    ' http://127.0.0.1/ ', // surrounding whitespace
    'http://127.0.0.1/\r\n',
    '\thttp://169.254.169.254/latest/meta-data',
    'http://0x7f000001/',
    'http://[::ffff:7f00:1]/',
    'http://localhost./',
    'http://tidings.mcn.am/api/health',
    'http://example.com:22/',
    'http://user:pw@example.com/',
  ])('refuses a redirect to %j and never fetches it', async (location) => {
    const { res, f } = await redirectTo(location);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(['blocked_address', 'invalid_url']).toContain(res.code);
    expect(f.calls.map((c) => c.url)).toEqual([FEED]);
  });

  it.each([
    'data:text/xml,<rss/>',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:1',
    'gopher://x/',
  ])('refuses a redirect to %s as invalid_url', async (location) => {
    const { res, f } = await redirectTo(location);
    expect(res).toMatchObject({ kind: 'error', code: 'invalid_url' });
    expect(f.calls).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])('%i is followed with a bodiless GET', async (status) => {
    const { f, opts } = setup();
    f.route(FEED, { status, headers: { Location: 'https://example.org/feed' } });
    f.route('https://example.org/feed', { body: '<rss/>' });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it.each([300, 305, 306])('%i is not treated as a redirect', async (status) => {
    const { f, opts } = setup();
    f.route(FEED, { status, headers: { Location: 'http://127.0.0.1/' } });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'http_error', status });
    expect(f.calls).toHaveLength(1);
  });

  it('two Location headers are joined by the Headers API and cannot smuggle a second target', async () => {
    const { f, opts } = setup();
    f.route(FEED, () => {
      const h = new Headers();
      h.append('Location', 'https://example.org/ok');
      h.append('Location', 'http://127.0.0.1/');
      return new Response(null, { status: 302, headers: h });
    });
    f.route(/./, { body: '<rss/>' });
    await safeFetch(FEED, opts());
    expect(
      f.calls.some((c) => c.url.includes('127.0.0.1') && new URL(c.url).hostname === '127.0.0.1'),
    ).toBe(false);
    for (const c of f.calls) expect(new URL(c.url).hostname).not.toBe('127.0.0.1');
  });

  it('a public to public to private chain is stopped at the private hop', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: 'https://a.example.org/' });
    f.route('https://a.example.org/', { redirectTo: 'https://b.example.org/' });
    f.route('https://b.example.org/', { redirectTo: 'http://169.254.169.254/latest/meta-data' });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'error', code: 'blocked_address' });
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual([
      'example.com',
      'a.example.org',
      'b.example.org',
    ]);
  });

  it('a redirect to a relative path with dot segments stays on the same public host', async () => {
    const { f, opts } = setup();
    f.route(FEED, { status: 301, headers: { Location: '../../x/../y.xml' } });
    f.route('https://example.com/y.xml', { body: '<rss/>' });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'ok', url: 'https://example.com/y.xml' });
  });

  it('a redirect to the same URL cannot loop forever', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: FEED });
    const res = await safeFetch(FEED, opts());
    expect(res).toMatchObject({ kind: 'error', code: 'too_many_redirects' });
    expect(f.calls).toHaveLength(4);
  });

  it('redirects never carry the test allow-list to a non-listed port or host', async () => {
    const f = createFakeFetch();
    const local = 'http://localhost:8788';
    f.route('http://127.0.0.1:8790/feed', { redirectTo: 'http://127.0.0.1:8791/secret' });
    f.route('http://127.0.0.1:8791/secret', { body: 'secret' });
    const res = await safeFetch('http://127.0.0.1:8790/feed', {
      fetch: f.fetch,
      appOrigin: local,
      allowHosts: ['127.0.0.1:8790'],
    });
    expect(res).toMatchObject({ kind: 'error', code: 'blocked_address' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('body size: lying, compressed and slow servers', () => {
  it('a body that lies about Content-Length (small header, big body) is still capped', async () => {
    const { f, opts } = setup();
    f.route(FEED, {
      body: new Uint8Array(MAX_BODY_BYTES + 1),
      headers: { 'Content-Length': '10' },
    });
    expect(await safeFetch(FEED, opts())).toMatchObject({ kind: 'error', code: 'too_large' });
  });

  it.each(['abc', '-1', '1e3', '', '5, 5', 'NaN', 'Infinity'])(
    'an unusable Content-Length %j never disables the streaming cap',
    async (cl) => {
      const { f, opts } = setup();
      f.route(FEED, () => {
        // Response() would reject some of these on construction in strict runtimes; build via Headers.
        const headers = new Headers();
        try {
          headers.set('Content-Length', cl);
        } catch {
          /* header refused by the runtime: nothing to test for this value */
        }
        return new Response(new Uint8Array(MAX_BODY_BYTES + 1), { status: 200, headers });
      });
      const res = await safeFetch(FEED, opts());
      expect(res).toMatchObject({ kind: 'error', code: 'too_large' });
    },
  );

  it('a Content-Length of exactly the cap with a matching body is accepted', async () => {
    const { f, opts } = setup();
    f.route(FEED, {
      body: new Uint8Array(MAX_BODY_BYTES),
      headers: { 'Content-Length': String(MAX_BODY_BYTES) },
    });
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
  });

  // Decision: the cap applies to DECODED bytes. workerd's fetch() decodes gzip/deflate/br
  // transparently, so `res.body` is already the decoded stream; counting it bounds memory and CPU
  // against decompression bombs. Content-Length (wire size) is only an early-out. The fake below
  // mimics the runtime by piping the compressed bytes through DecompressionStream.
  async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function decodedResponse(compressed: Uint8Array): Response {
    const body = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Length': String(compressed.byteLength),
      },
    });
  }

  it('a gzip bomb (tiny on the wire, 8 MiB decoded) is cut off at the decoded cap', async () => {
    const compressed = await gzip(new Uint8Array(8 * 1024 * 1024));
    expect(compressed.byteLength).toBeLessThan(64 * 1024); // really tiny on the wire
    const { f, opts } = setup();
    f.route(FEED, () => decodedResponse(compressed));
    expect(await safeFetch(FEED, opts())).toMatchObject({ kind: 'error', code: 'too_large' });
  });

  it('gzip content under the decoded cap returns the decoded bytes and their hash', async () => {
    const plain = new TextEncoder().encode('<rss>'.repeat(100_000)); // 500 KB
    const compressed = await gzip(plain);
    const { f, opts } = setup();
    f.route(FEED, () => decodedResponse(compressed));
    const res = await safeFetch(FEED, opts());
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.body.byteLength).toBe(plain.byteLength);
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', plain));
      expect(res.sha256).toBe([...d].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
  });

  it('a slow drip (1 byte per second) is stopped by the 10 s total timeout', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    let sent = 0;
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            await new Promise((r) => setTimeout(r, 1_000));
            sent++;
            c.enqueue(new Uint8Array([60]));
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    });
    const pending = safeFetch(FEED, opts());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ kind: 'error', code: 'timeout' });
    expect(sent).toBeLessThanOrEqual(10);
  });

  it('a drip that finishes just inside the budget succeeds (timeout is not early)', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    f.route(FEED, () => {
      let n = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            await new Promise((r) => setTimeout(r, 1_000));
            c.enqueue(new Uint8Array([60]));
            if (++n === 9) c.close();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    });
    const pending = safeFetch(FEED, opts());
    await vi.advanceTimersByTimeAsync(9_500);
    const res = await pending;
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.body.byteLength).toBe(9);
  });

  it('a stalled redirect body cannot hold the fetcher past the budget', async () => {
    vi.useFakeTimers();
    const { f, opts } = setup();
    f.route(FEED, () => {
      const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
      return new Response(stream, { status: 302, headers: { Location: 'https://example.org/' } });
    });
    f.route('https://example.org/', { body: '<rss/>' });
    const pending = safeFetch(FEED, opts());
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending; // a hang would fail by test timeout
    expect(['ok', 'error']).toContain(res.kind);
  });
});

describe('guard cannot be switched on from options alone', () => {
  it.each([
    'https://localhost:8788', // https is not the dev origin
    'http://localhost.evil.com',
    'http://localhost@evil.com',
    'http://evil.com@localhost',
    'http://127.0.0.1:8788', // loopback IP is not the literal name localhost
    'http://localhost.:8788',
    'not a url',
    '',
  ])('allowHosts is ignored when appOrigin is %j', async (origin) => {
    const f = createFakeFetch();
    f.route(/./, { body: '<rss/>' });
    const res = await safeFetch('http://127.0.0.1:8790/feed', {
      fetch: f.fetch,
      appOrigin: origin,
      allowHosts: ['127.0.0.1:8790'],
    });
    expect(res.kind).toBe('error');
    expect(f.calls).toHaveLength(0);
  });

  it('credentials are refused even for an allow-listed host', async () => {
    const f = createFakeFetch();
    const res = await safeFetch('http://user:pw@127.0.0.1:8790/feed', {
      fetch: f.fetch,
      appOrigin: 'http://localhost:8788',
      allowHosts: ['127.0.0.1:8790'],
    });
    expect(res).toMatchObject({ kind: 'error', code: 'invalid_url' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('request hygiene on every hop', () => {
  it('sends only accept, user-agent and the two validators across a three-hop chain', async () => {
    const { f, opts } = setup();
    f.route(FEED, { redirectTo: 'https://a.example.org/' });
    f.route('https://a.example.org/', { redirectTo: 'https://b.example.org/' });
    f.route('https://b.example.org/', { redirectTo: 'https://c.example.org/' });
    f.route('https://c.example.org/', { body: '<rss/>' });
    await safeFetch(FEED, opts({ etag: '"e"', lastModified: 'Tue, 10 Nov 2026 12:00:00 GMT' }));
    expect(f.calls).toHaveLength(4);
    for (const c of f.calls) {
      expect([...c.headers.keys()].sort()).toEqual(
        ['accept', 'if-modified-since', 'if-none-match', 'user-agent'].sort(),
      );
      expect(c.method).toBe('GET');
    }
  });

  it('a validator containing CR/LF cannot inject a header: the request fails, nothing leaks', async () => {
    // Real fetch rejects invalid header values. Model that with a strict fake.
    const calls: string[] = [];
    const strict = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push(input);
      new Headers(init?.headers); // throws TypeError on CR/LF in the value
      return new Response('<rss/>');
    };
    const res = await safeFetch(FEED, {
      fetch: strict,
      appOrigin: APP_ORIGIN,
      etag: '"x"\r\nCookie: stolen=1',
    });
    expect(res).toMatchObject({ kind: 'error', code: 'network_error' });
  });
});
