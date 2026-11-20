/**
 * SSRF-safe fetcher (spec §10.6, §7.3 step 1, §7.4). Everything server-side that fetches a
 * user-supplied URL goes through `safeFetch`. `fetch` is injected via options.
 */
import { checkUrl } from './address';
import { isLocalDevOrigin } from './config';

export const MAX_BODY_BYTES = 1_048_576; // ADR 0006
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;

export const ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetchOptions {
  fetch: FetchFn;
  appOrigin: string;
  /** Test-only allow-list; ignored unless `appOrigin` is http://localhost:* (defence in depth). */
  allowHosts?: readonly string[];
  etag?: string | null;
  lastModified?: string | null;
  maxBodyBytes?: number;
  /**
   * TID-071: with this set, a body longer than `maxBodyBytes` is cut there (the stream is cancelled)
   * and returned as `ok` with `truncated: true`, instead of failing with `too_large`.
   */
  truncate?: boolean;
  /** Replaces the feed `Accept` header (page fetches ask for HTML). */
  accept?: string;
  maxRedirects?: number;
  timeoutMs?: number;
}

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'network_error';

export interface Hop {
  from: string;
  to: string;
  status: number;
}

interface Base {
  /** URL of the final response (after redirects). */
  url: string;
  redirects: Hop[];
}

export type SafeFetchResult =
  | (Base & {
      kind: 'ok';
      status: number;
      headers: Headers;
      body: Uint8Array;
      /** Lower-case hex SHA-256 of `body`, computed while streaming. */
      sha256: string;
      /** True when `truncate` cut the body at `maxBodyBytes`. */
      truncated: boolean;
    })
  | (Base & { kind: 'not_modified'; status: 304; headers: Headers })
  | (Base & { kind: 'http_error'; status: number; headers: Headers })
  | (Partial<Base> & { kind: 'error'; code: SafeFetchErrorCode; message: string });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class Aborted extends Error {}

type Guard = <T>(p: Promise<T>) => Promise<T>;

function fail(
  code: SafeFetchErrorCode,
  message: string,
  extra: Partial<Base> = {},
): SafeFetchResult {
  return { kind: 'error', code, message, ...extra };
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const drop = () => undefined;

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const allow = isLocalDevOrigin(opts.appOrigin) ? (opts.allowHosts ?? []) : [];

  // Only these headers are ever sent, on every hop: no cookies, no auth, nothing user-controlled.
  const headers: Record<string, string> = {
    'User-Agent': `Tidings/1.0 (+${opts.appOrigin})`,
    Accept: opts.accept ?? ACCEPT_HEADER,
  };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

  // Validate before arming the timer or touching the network.
  let current = checkUrl(rawUrl, opts.appOrigin, allow);
  if (!current.ok) return fail(current.code ?? 'invalid_url', current.message ?? 'Blocked');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Aborted('aborted')), {
      once: true,
    });
  });
  aborted.catch(drop);
  const guard: Guard = (p) => {
    p.catch(drop);
    return Promise.race([p, aborted]);
  };

  const redirects: Hop[] = [];
  try {
    for (;;) {
      const url = (current.url as URL).toString();
      const res = await guard(
        opts.fetch(url, { method: 'GET', redirect: 'manual', headers, signal: controller.signal }),
      );

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(drop);
        const location = res.headers.get('Location');
        if (!location) return fail('invalid_url', 'Redirect without Location', { url, redirects });
        if (redirects.length >= maxRedirects) {
          return fail('too_many_redirects', `More than ${maxRedirects} redirects`, {
            url,
            redirects,
          });
        }
        let target: string;
        try {
          target = new URL(location, url).toString();
        } catch {
          return fail('invalid_url', 'Bad redirect Location', { url, redirects });
        }
        const next = checkUrl(target, opts.appOrigin, allow);
        if (!next.ok) {
          return fail(next.code ?? 'blocked_address', next.message ?? 'Blocked redirect', {
            url,
            redirects,
          });
        }
        redirects.push({ from: url, to: target, status: res.status });
        current = next;
        continue;
      }

      const base = { url, redirects };
      if (res.status === 304) {
        await res.body?.cancel().catch(drop);
        return { kind: 'not_modified', status: 304, headers: res.headers, ...base };
      }
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(drop);
        return { kind: 'http_error', status: res.status, headers: res.headers, ...base };
      }

      const declared = Number(res.headers.get('Content-Length'));
      if (!opts.truncate && Number.isFinite(declared) && declared > maxBody) {
        await res.body?.cancel().catch(drop);
        return fail('too_large', `Content-Length ${declared} exceeds ${maxBody}`, base);
      }

      const read = await readBody(res, maxBody, guard, opts.truncate === true);
      if (read === 'too_large') return fail('too_large', `Body exceeds ${maxBody} bytes`, base);
      return { kind: 'ok', status: res.status, headers: res.headers, ...read, ...base };
    }
  } catch (err) {
    if (timedOut) return fail('timeout', `No complete response within ${timeoutMs} ms`);
    return fail('network_error', err instanceof Error ? err.message : 'Fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(
  res: Response,
  max: number,
  guard: Guard,
  truncate: boolean,
): Promise<'too_large' | { body: Uint8Array; sha256: string; truncated: boolean }> {
  if (!res.body) {
    const empty = new Uint8Array(0);
    return { body: empty, sha256: await sha256Of(empty), truncated: false };
  }
  const reader = res.body.getReader();
  const digestStream =
    typeof crypto.DigestStream === 'function' ? new crypto.DigestStream('SHA-256') : null;
  digestStream?.digest.catch(drop); // an aborted read rejects `digest`; nobody awaits it then
  const digestWriter = digestStream?.getWriter();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await guard(reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > max && truncate) {
        // Keep exactly `max` bytes and stop reading; the rest is never downloaded or decoded.
        const keep = value.byteLength - (total - max);
        chunks.push(value.subarray(0, keep));
        total = max;
        await reader.cancel().catch(drop);
        await digestWriter?.abort().catch(drop);
        const cut = joinChunks(chunks, total);
        return { body: cut, sha256: await sha256Of(cut), truncated: true };
      }
      if (total > max) {
        await reader.cancel().catch(drop);
        await digestWriter?.abort().catch(drop);
        return 'too_large';
      }
      chunks.push(value);
      await digestWriter?.write(value);
    }
  } catch (err) {
    await reader.cancel().catch(drop);
    await digestWriter?.abort().catch(drop);
    throw err;
  }
  const body = joinChunks(chunks, total);
  if (digestStream && digestWriter) {
    await digestWriter.close();
    return { body, sha256: hex(await digestStream.digest), truncated: false };
  }
  return { body, sha256: await sha256Of(body), truncated: false };
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return body;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
