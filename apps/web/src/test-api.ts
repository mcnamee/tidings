import { vi } from 'vitest';

export interface FakeApiRoute {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Answer = FakeApiRoute | ((body: unknown) => FakeApiRoute | Promise<FakeApiRoute>);

export interface FakeApi {
  /** Every request seen, in order. */
  calls: Array<{ method: string; path: string; body: unknown }>;
  /** Replace the answer for `METHOD /path`. A function answers per call. */
  set(key: string, answer: Answer): void;
}

/**
 * Installs a fake `fetch` for the SPA's API calls. Unknown routes answer 404. The default
 * session answer is "a user exists, nobody is signed in". Call `vi.unstubAllGlobals()` after.
 */
export function installFakeApi(): FakeApi {
  const routes = new Map<string, Answer>();
  const calls: FakeApi['calls'] = [];
  routes.set('GET /api/auth/session', {
    body: { user: null, setupRequired: false, mustAddPasskey: false },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const entry = routes.get(`${method} ${path}`);
      const route = typeof entry === 'function' ? await entry(body) : entry;
      if (!route) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...route.headers },
      });
    }),
  );
  return { calls, set: (key, answer) => void routes.set(key, answer) };
}
