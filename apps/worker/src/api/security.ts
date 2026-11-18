import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../../env';
import { setSessionCookie } from '../auth/cookies';
import { Db, type Clock } from '../db';
import { resolveSession, SESSION_COOKIE, type ResolvedSession } from '../auth/session';
import { fail } from './respond';

/** Hono environment for the whole API: bindings plus what the middleware puts on the context. */
export interface AppEnv {
  Bindings: Env;
  Variables: { session: ResolvedSession };
}

/** The part of the Workers Rate Limiting binding we use. Tests inject a stub. */
export interface ApiRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Spec 8.1 and 8.3: the routes that need no session. Everything else under `/api` requires one,
 * *including paths no handler exists for*, so a route added later is protected by default and
 * cannot be made public by forgetting to register a guard.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/health',
  'HEAD /api/health',
  'GET /api/auth/session',
  'POST /api/auth/setup/options',
  'POST /api/auth/setup/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/recover',
  'POST /api/auth/email/request',
  'POST /api/auth/email/verify',
]);

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`);
}

/** ADR 0016 / TID-053 AC11. Renaming a passkey (PATCH) stays allowed. */
export function requiresPasskeyReauth(method: string, path: string): boolean {
  if (method === 'POST') {
    return (
      path === '/api/auth/passkeys/options' ||
      path === '/api/auth/passkeys/verify' ||
      path === '/api/auth/recovery-codes'
    );
  }
  return method === 'DELETE' && /^\/api\/auth\/passkeys\/[^/]+$/.test(path);
}

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

/**
 * Spec 10.3. Both must hold: `Origin` equals `APP_ORIGIN` (or, when `Origin` is absent,
 * `Sec-Fetch-Site` is `same-origin`), and the body is declared as `application/json`, which
 * makes any cross-site attempt need a CORS preflight we never approve.
 */
export function passesCsrfCheck(headers: Headers, appOrigin: string): boolean {
  const origin = headers.get('Origin');
  if (origin !== null) {
    if (origin !== appOrigin) return false;
  } else if (headers.get('Sec-Fetch-Site') !== 'same-origin') {
    return false;
  }
  const type = (headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

/** Spec 8.1 / 10.4: set on every API response, including errors and short-circuits. No CORS headers, ever. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
};

/** CSRF check for the public mutating routes (setup, login, recover), before anything is written. */
function csrfFailed(c: Context<AppEnv>): Response {
  return fail(c, 403, 'csrf_failed', 'Request rejected');
}

export interface GuardDeps {
  clock: Clock;
  apiRateLimit?: ApiRateLimiter | undefined;
}

/**
 * The gatekeeper for `/api/*`:
 *
 * - Public routes: CSRF check on mutating ones, nothing else.
 * - Everything else: a valid session (`401 unauthenticated`), then CSRF on mutating methods
 *   (`403 csrf_failed`), then the per-user `API_RL` backstop (`429 rate_limited`).
 *
 * A request with no session is answered 401 before the CSRF check on purpose: it has no
 * authority to forge, and a uniform 401 tells a prober nothing about which routes exist.
 */
export function apiGuard(deps: GuardDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const mutating = isMutating(method);

    if (isPublicRoute(method, c.req.path)) {
      if (mutating && !passesCsrfCheck(c.req.raw.headers, c.env.APP_ORIGIN)) return csrfFailed(c);
      await next();
      return;
    }

    const token = getCookie(c, SESSION_COOKIE);
    const session = await resolveSession(new Db(c.env.DB), token, deps.clock);
    if (!session || !token) return fail(c, 401, 'unauthenticated', 'Sign in to continue');
    if (session.renewedMaxAge !== null) setSessionCookie(c, token, session.renewedMaxAge);

    if (mutating && !passesCsrfCheck(c.req.raw.headers, c.env.APP_ORIGIN)) return csrfFailed(c);

    // ADR 0016: a session made from an emailed link can't change how you sign in.
    if (session.authMethod === 'email' && requiresPasskeyReauth(method, c.req.path)) {
      return fail(c, 403, 'reauth_required', 'Sign in with a passkey to do this');
    }

    const limiter = deps.apiRateLimit ?? c.env.API_RL;
    if (limiter) {
      let allowed = true;
      try {
        allowed = (await limiter.limit({ key: `user:${session.user.id}` })).success;
      } catch (err) {
        // A backstop must not take the API down with it: fail open, and say so in the log.
        console.error('API_RL binding failed', err instanceof Error ? err.name : 'error');
      }
      if (!allowed) {
        c.header('Retry-After', '60');
        return fail(c, 429, 'rate_limited', 'Too many requests');
      }
    }

    c.set('session', session);
    await next();
  };
}
