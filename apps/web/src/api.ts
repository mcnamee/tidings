import type { ApiError, ErrorCode, HealthResponse } from '@tidings/shared';

export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchFn('/api/health');
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return (await res.json()) as HealthResponse;
}

/** auth-common.md 2.3: a request that takes longer than this is treated as a network error. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The server answered with an error status. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | null,
    /** `Retry-After` in seconds, when the server sent a usable one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`API ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiRequestError';
  }
}

/** No answer at all: offline, DNS, connection reset, or the request timed out. */
export class NetworkError extends Error {
  constructor() {
    super('network error');
    this.name = 'NetworkError';
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

let onUnauthenticated: (() => void) | null = null;

/**
 * Called when any request is answered `401 unauthenticated` (the session ended or was revoked,
 * TID-008 AC4/AC13). The app uses it to drop the signed-in state; it never touches the cache.
 */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

export interface RequestOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  opts: RequestOptions,
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const init: RequestInit = { method, signal, credentials: 'same-origin' };
  // Spec 10.3: every mutating request declares JSON, even one with no body, or the Worker refuses it.
  if (method !== 'GET') init.headers = { 'Content-Type': 'application/json' };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(path, init);
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let code: ErrorCode | null = null;
    try {
      code = ((await res.json()) as ApiError).error.code;
    } catch {
      // not JSON (a proxy error page, say): the status alone decides
    }
    if (res.status === 401 && code === 'unauthenticated') onUnauthenticated?.();
    throw new ApiRequestError(res.status, code, parseRetryAfter(res.headers.get('Retry-After')));
  }
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetworkError();
  }
}

export const apiGet = <T>(path: string, opts: RequestOptions = {}) =>
  request<T>('GET', path, undefined, opts);
export const apiPost = <T>(path: string, body: unknown, opts: RequestOptions = {}) =>
  request<T>('POST', path, body, opts);
