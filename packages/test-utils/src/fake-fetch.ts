/**
 * An injectable `fetch` for tests. It never touches the network: a request with no matching route
 * throws, so a missed mock fails loudly instead of leaking out. Works in Node and in workerd.
 *
 *   const f = createFakeFetch();
 *   f.serveFeed('https://example.test/feed.xml', xml, { etag: '"v1"' });
 *   f.route('https://example.test/gone.xml', { status: 410 });
 *   await refresh({ fetch: f.fetch, now: clock.now });
 *   expect(f.calls).toHaveLength(1);
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  /** `Retry-After` header shorthand. */
  retryAfter?: number | string;
  /** Redirect shorthand: sets Location (and status 302 unless given). */
  redirectTo?: string;
  /** Wait before responding. Honours the request's AbortSignal, so a fetcher timeout fires. */
  delayMs?: number;
  /** Reject the fetch with this error (DNS failure, connection reset, ...). */
  error?: Error;
  /** Never settle until the request is aborted (a hung connection). */
  hang?: boolean;
}

export type Responder =
  | FakeResponseInit
  | ((req: Request) => FakeResponseInit | Response | Promise<FakeResponseInit | Response>);
export type Matcher = string | RegExp | ((url: URL, req: Request) => boolean);

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  signal: AbortSignal | null;
  redirect: 'follow' | 'error' | 'manual';
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Calls whose URL equals `url` exactly. */
  callsTo(url: string): RecordedCall[];
  /**
   * Register a route. Routes added later win. `times` limits how often it answers
   * (then the next-most-recent matching route is used).
   */
  route(match: Matcher, responder: Responder, options?: { times?: number }): void;
  /**
   * Serve a feed with a stable ETag/Last-Modified and correct conditional GET handling:
   * a matching `If-None-Match` or `If-Modified-Since` gets a bodyless 304.
   * Returns a handle to change the body (new ETag) between refreshes.
   */
  serveFeed(
    url: string,
    xml: string,
    options?: { etag?: string; lastModified?: string; contentType?: string },
  ): { update(xml: string, etag?: string): void };
  reset(): void;
}

interface Route {
  match: Matcher;
  responder: Responder;
  remaining: number;
}

function matches(m: Matcher, url: URL, req: Request): boolean {
  if (typeof m === 'string') return url.toString() === new URL(m).toString();
  if (m instanceof RegExp) return m.test(url.toString());
  return m(url, req);
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number | null, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = ms === null ? undefined : setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function createFakeFetch(): FakeFetch {
  const routes: Route[] = [];
  const calls: RecordedCall[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push({
      url: url.toString(),
      method: req.method,
      headers: new Headers(req.headers),
      signal: init?.signal ?? (input instanceof Request ? input.signal : null),
      redirect: req.redirect as RecordedCall['redirect'],
    });

    let route: Route | undefined;
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i] as Route;
      if (r.remaining > 0 && matches(r.match, url, req)) {
        route = r;
        break;
      }
    }
    if (!route) {
      throw new Error(
        `fakeFetch: no route for ${req.method} ${url.toString()} (network is disabled in tests)`,
      );
    }
    route.remaining -= 1;

    const result =
      typeof route.responder === 'function' ? await route.responder(req) : route.responder;
    if (result instanceof Response) return result;

    const signal = calls[calls.length - 1]?.signal ?? null;
    if (result.hang) await sleep(null, signal);
    if (result.delayMs) await sleep(result.delayMs, signal);
    if (result.error) throw result.error;

    const headers = new Headers(result.headers);
    if (result.retryAfter !== undefined) headers.set('Retry-After', String(result.retryAfter));
    let status = result.status ?? 200;
    if (result.redirectTo) {
      headers.set('Location', new URL(result.redirectTo, url).toString());
      status = result.status ?? 302;
    }
    const nullBody = status === 204 || status === 304 || (status >= 300 && status < 400);
    return new Response(nullBody ? null : (result.body ?? null), { status, headers });
  };

  return {
    fetch: fetchImpl,
    calls,
    callsTo: (url) => calls.filter((c) => c.url === new URL(url).toString()),
    route(match, responder, options) {
      routes.push({ match, responder, remaining: options?.times ?? Infinity });
    },
    serveFeed(url, xml, options = {}) {
      let current = { xml, etag: options.etag ?? '"v1"' };
      const lastModified = options.lastModified ?? 'Tue, 10 Nov 2026 12:00:00 GMT';
      routes.push({
        match: url,
        remaining: Infinity,
        responder: (req) => {
          const inm = req.headers.get('if-none-match');
          const ims = req.headers.get('if-modified-since');
          const validators = { ETag: current.etag, 'Last-Modified': lastModified };
          if (inm ? inm.split(',').some((v) => v.trim() === current.etag) : ims === lastModified) {
            return { status: 304, headers: validators };
          }
          return {
            status: 200,
            headers: {
              ...validators,
              'Content-Type': options.contentType ?? 'application/xml; charset=utf-8',
            },
            body: current.xml,
          };
        },
      });
      return {
        update(nextXml, etag) {
          current = { xml: nextXml, etag: etag ?? `"v${Math.abs(hash(nextXml))}"` };
        },
      };
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
