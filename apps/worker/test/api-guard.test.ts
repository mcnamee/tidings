import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, type FixedClock } from '@tidings/test-utils';
import { createApp } from '../src/api/app';
import {
  apiGuard,
  isPublicRoute,
  securityHeaders,
  type ApiRateLimiter,
  type AppEnv,
} from '../src/api/security';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  createHarness,
  resetAuthTables,
  runLogin,
  runSetup,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { ISOLATION_CASES } from './support/isolation-cases';
import { concretePath, ROUTE_TABLE } from './support/route-table';
import { countRows, seedSession, seedUser, sessionRow } from './support/seed';

// TID-008: the API security middleware (spec 8.1, 10.2, 10.3, 10.4, 10.7), exercised through the
// real guard on a probe route, and through the real app for the auth routes.

let clock: FixedClock;
const nowSec = () => Math.floor(clock.now() / 1000);

/** The real guard in front of a probe route that answers with the session's user. */
function probeApp(apiRateLimit?: ApiRateLimiter) {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders);
  app.use('*', apiGuard({ clock: () => clock.now(), apiRateLimit }));
  app.all('/api/probe', (c) => c.json({ userId: c.get('session').user.id }));
  return app;
}

interface ProbeInit {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}

function probe(app: ReturnType<typeof probeApp>, init: ProbeInit = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Cookie', `${SESSION_COOKIE}=${init.token}`);
  return Promise.resolve(
    app.fetch(
      new Request(`${env.APP_ORIGIN}/api/probe`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
      }),
      env,
    ),
  );
}

const JSON_SAME_ORIGIN = { Origin: '', 'Content-Type': 'application/json' };
function sameOriginJson(extra: Record<string, string> = {}) {
  return { ...JSON_SAME_ORIGIN, Origin: env.APP_ORIGIN, ...extra };
}

let h: Harness;
beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
  clock = h.clock;
});

describe('AC3: sliding expiry', () => {
  beforeEach(async () => {
    await seedUser('u1');
  });

  it('with 23 or more days left, a request writes nothing and sets no cookie', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() + 23 * 86400 });
    const res = await probe(probeApp(), { token });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await sessionRow(token))?.expires_at).toBe(nowSec() + 23 * 86400);

    const fresh = await seedSession('u1', { now: nowSec() }); // 30 days left
    expect((await probe(probeApp(), { token: fresh })).status).toBe(200);
    expect((await sessionRow(fresh))?.expires_at).toBe(nowSec() + 30 * 86400);
  });

  it('really issues no UPDATE: a statement spy sees only the one SELECT', async () => {
    const token = await seedSession('u1', { now: nowSec() });
    const statements: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((q: string) => {
      statements.push(q);
      return real(q);
    });
    try {
      expect((await probe(probeApp(), { token })).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT/);
  });

  it('with fewer than 23 days left, the next request extends expires_at to now + 30 days', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() + 23 * 86400 - 1 });
    const res = await probe(probeApp(), { token });
    expect(res.status).toBe(200);
    expect((await sessionRow(token))?.expires_at).toBe(nowSec() + 30 * 86400);
    // The browser's cookie slides with the row.
    const cookie = setCookies(res)[SESSION_COOKIE];
    expect(cookie?.value).toBe(token);
    expect(cookie?.attrs).toMatchObject({
      'max-age': String(30 * 86400),
      samesite: 'Lax',
      path: '/',
      httponly: '',
      secure: '',
    });
  });

  it('plays out over time on a fixed clock: one write a week, never an early expiry', async () => {
    const token = await seedSession('u1', { now: nowSec() });
    const start = nowSec();
    // Day 6: 24 days left, no write.
    clock.advance(6 * DAY);
    await probe(probeApp(), { token });
    expect((await sessionRow(token))?.expires_at).toBe(start + 30 * 86400);
    // Day 8: 22 days left, extended to day 38.
    clock.advance(2 * DAY);
    await probe(probeApp(), { token });
    expect((await sessionRow(token))?.expires_at).toBe(start + 38 * 86400);
    // Day 37: still valid (the extension held); extended again to day 67.
    clock.advance(29 * DAY);
    expect((await probe(probeApp(), { token })).status).toBe(200);
    expect((await sessionRow(token))?.expires_at).toBe(start + 67 * 86400);
  });

  it('never extends past the 180-day absolute cap', async () => {
    const token = await seedSession('u1', {
      now: nowSec(),
      expiresAt: nowSec() + 5 * 86400,
      absoluteExpiresAt: nowSec() + 10 * 86400,
    });
    const res = await probe(probeApp(), { token });
    expect(res.status).toBe(200);
    expect((await sessionRow(token))?.expires_at).toBe(nowSec() + 10 * 86400);
    expect(setCookies(res)[SESSION_COOKIE]?.attrs['max-age']).toBe(String(10 * 86400));
  });

  it('GET /api/auth/session slides the session too (opening the app is use)', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() + 10 * 86400 });
    const res = await h.call('GET', '/api/auth/session', { cookies: { [SESSION_COOKIE]: token } });
    expect(res.status).toBe(200);
    expect((await sessionRow(token))?.expires_at).toBe(nowSec() + 30 * 86400);
    expect(setCookies(res)[SESSION_COOKIE]?.attrs['max-age']).toBe(String(30 * 86400));
  });

  it('parallel requests extend the session once', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() + 86400 });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => probe(probeApp(), { token })),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const renewed = responses.filter((r) => r.headers.getSetCookie().length > 0);
    expect(renewed).toHaveLength(1);
  });
});

describe('AC4: expired sessions are refused', () => {
  beforeEach(async () => {
    await seedUser('u1');
  });

  it('past expires_at is 401 unauthenticated, with no extension', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() - 1 });
    const res = await probe(probeApp(), { token });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue' },
    });
    expect((await sessionRow(token))?.expires_at).toBe(nowSec() - 1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('expires_at equal to now is already expired', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() });
    expect((await probe(probeApp(), { token })).status).toBe(401);
  });

  it('past absolute_expires_at is 401 even though expires_at is in the future', async () => {
    const token = await seedSession('u1', {
      now: nowSec(),
      expiresAt: nowSec() + 20 * 86400,
      absoluteExpiresAt: nowSec() - 1,
    });
    expect((await probe(probeApp(), { token })).status).toBe(401);
  });

  it('a session left unused for 30 days expires on the clock', async () => {
    const token = await seedSession('u1', { now: nowSec() });
    clock.advance(29 * DAY);
    // 1 day left: this request is use, and slides it.
    expect((await probe(probeApp(), { token })).status).toBe(200);
    clock.advance(31 * DAY);
    expect((await probe(probeApp(), { token })).status).toBe(401);
  });

  it('a session used weekly is cut off at 180 days', async () => {
    const token = await seedSession('u1', { now: nowSec() });
    for (let week = 1; week <= 25; week++) {
      clock.advance(7 * DAY);
      expect((await probe(probeApp(), { token })).status, `day ${week * 7}`).toBe(200);
    }
    clock.advance(6 * DAY); // day 181
    expect((await probe(probeApp(), { token })).status).toBe(401);
  });

  it('GET /api/auth/session reports signed out for an expired session', async () => {
    const token = await seedSession('u1', { now: nowSec(), expiresAt: nowSec() - 1 });
    const res = await h.call('GET', '/api/auth/session', { cookies: { [SESSION_COOKIE]: token } });
    expect(await res.json()).toEqual({
      user: null,
      setupRequired: false,
      mustAddPasskey: false,
      // The test environment has the email secret and one user, so the option is on.
      emailSignIn: true,
    });
  });

  it('garbage, empty and oversized cookie values are 401, not 500', async () => {
    for (const token of ['x', 'a'.repeat(5000), '%00', 'tok;evil']) {
      const res = await probe(probeApp(), { token });
      expect(res.status, token.slice(0, 20)).toBe(401);
    }
  });
});

describe('AC5: sign out', () => {
  it('POST /api/auth/logout deletes the session row, clears the cookie, and the old cookie then gets 401', async () => {
    const setup = await runSetup(h);
    const login = await runLogin(h, setup.passkey);
    const token = login.sessionToken ?? '';
    expect(await sessionRow(token)).not.toBeNull();

    const res = await h.call('POST', '/api/auth/logout', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const cleared = setCookies(res)[SESSION_COOKIE];
    expect(cleared?.value).toBe('');
    expect(cleared?.attrs['max-age']).toBe('0');
    expect(cleared?.attrs).toMatchObject({ secure: '', path: '/' });
    expect(await sessionRow(token)).toBeNull();

    const again = await h.call('POST', '/api/auth/logout', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(again.status).toBe(401);
    const session = await h.call('GET', '/api/auth/session', {
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(((await session.json()) as { user: unknown }).user).toBeNull();
  });

  it('ends only this session: the owner stays signed in on another device', async () => {
    const setup = await runSetup(h);
    const a = await runLogin(h, setup.passkey);
    const b = await runLogin(h, setup.passkey);
    await h.call('POST', '/api/auth/logout', {
      body: {},
      cookies: { [SESSION_COOKIE]: a.sessionToken ?? '' },
    });
    expect(await sessionRow(a.sessionToken ?? '')).toBeNull();
    expect(await sessionRow(b.sessionToken ?? '')).not.toBeNull();
    const session = await h.call('GET', '/api/auth/session', {
      cookies: { [SESSION_COOKIE]: b.sessionToken ?? '' },
    });
    expect(((await session.json()) as { user: unknown }).user).not.toBeNull();
  });

  it('logout needs the CSRF headers like any mutation', async () => {
    await seedUser('u1');
    const token = await seedSession('u1', { now: nowSec() });
    const res = await h.call('POST', '/api/auth/logout', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await sessionRow(token)).not.toBeNull();
  });
});

describe('AC6: every route not marked Public needs a session (generated from spec 8)', () => {
  const protectedRows = ROUTE_TABLE.filter((r) => !r.public);

  it('the table covers the whole spec: no duplicates, and protected rows exist', () => {
    const keys = ROUTE_TABLE.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(protectedRows.length).toBeGreaterThan(20);
  });

  it.each(protectedRows.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s without a cookie is 401 unauthenticated',
    async (_name, row) => {
      // Both a bare request and a well-formed same-origin one: the answer is the same 401.
      const bare = await h.call(row.method, concretePath(row.path), { headers: { Origin: null } });
      expect(bare.status).toBe(401);
      expect(((await bare.json()) as { error: { code: string } }).error.code).toBe(
        'unauthenticated',
      );
      const formed = await h.call(
        row.method,
        concretePath(row.path),
        row.method === 'GET' ? {} : { body: {} },
      );
      expect(formed.status).toBe(401);
      expect(((await formed.json()) as { error: { code: string } }).error.code).toBe(
        'unauthenticated',
      );
    },
  );

  it('the code classifies exactly the table’s Public rows as public', () => {
    for (const row of ROUTE_TABLE) {
      expect(isPublicRoute(row.method, row.path), `${row.method} ${row.path}`).toBe(row.public);
    }
  });

  it('every route the app registers is in the table (a new route must be classified)', () => {
    const listed = new Set(ROUTE_TABLE.map((r) => `${r.method} ${r.path}`));
    const registered = createApp()
      .routes.filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThan(5);
    expect(registered.filter((key) => !listed.has(key))).toEqual([]);
  });

  it('a path no handler exists for is 401 without a session, 404 with one (deny by default)', async () => {
    await seedUser('u1');
    const token = await seedSession('u1', { now: nowSeconds() });
    for (const path of ['/api/nope', '/api/entries/1/secret', '/api/auth/nope', '/api/health/']) {
      expect((await h.call('GET', path)).status, path).toBe(401);
    }
    for (const path of ['/api/nope', '/api/auth/nope']) {
      const res = await h.call('GET', path, { cookies: { [SESSION_COOKIE]: token } });
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it('public routes work with no cookie', async () => {
    expect((await h.call('GET', '/api/health')).status).toBe(200);
    expect((await h.call('GET', '/api/auth/session')).status).toBe(200);
    expect((await h.call('POST', '/api/auth/login/options', { body: {} })).status).toBe(200);
  });
});

function nowSeconds() {
  return nowSec();
}

describe('AC7: CSRF on authenticated mutations', () => {
  let token: string;
  beforeEach(async () => {
    await seedUser('u1');
    token = await seedSession('u1', { now: nowSec() });
  });

  async function csrf(
    headers: Record<string, string>,
    method = 'POST',
    body: string | undefined = '{}',
  ) {
    const res = await probe(probeApp(), { method, token, headers, body });
    return res;
  }
  async function expectCsrf(res: Response) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'csrf_failed', message: 'Request rejected' },
    });
  }

  it('a same-origin JSON request passes, for every mutating method', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await csrf(sameOriginJson(), method);
      expect(res.status, method).toBe(200);
    }
  });

  it('Origin https://evil.example is refused, for every mutating method', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      await expectCsrf(await csrf(sameOriginJson({ Origin: 'https://evil.example' }), method));
    }
  });

  it('look-alike origins are refused: other scheme, port, subdomain, suffix, trailing slash, null', async () => {
    const origin = new URL(env.APP_ORIGIN);
    const lookalikes = [
      `http://${origin.host}`,
      `${origin.protocol}//${origin.hostname}:9999`,
      `${origin.protocol}//evil.${origin.host}`,
      `${origin.protocol}//${origin.host}.evil.example`,
      `${env.APP_ORIGIN}/`,
      'null',
    ].filter((o) => o !== env.APP_ORIGIN);
    for (const o of lookalikes) {
      await expectCsrf(await csrf(sameOriginJson({ Origin: o })));
    }
  });

  it('no Origin and no Sec-Fetch-Site is refused', async () => {
    await expectCsrf(await csrf({ 'Content-Type': 'application/json' }));
  });

  it('no Origin but Sec-Fetch-Site: same-origin is accepted; cross-site, same-site and none are not', async () => {
    const ok = await csrf({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    for (const site of ['cross-site', 'same-site', 'none']) {
      await expectCsrf(await csrf({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }));
    }
  });

  it('a wrong Origin is refused even when Sec-Fetch-Site says same-origin', async () => {
    await expectCsrf(
      await csrf(
        sameOriginJson({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }),
      ),
    );
  });

  it('a non-JSON Content-Type is refused: text/plain, form, multipart, missing', async () => {
    for (const type of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonx',
      'text/json',
    ]) {
      await expectCsrf(await csrf(sameOriginJson({ 'Content-Type': type })));
    }
    const noType = new Headers({ Origin: env.APP_ORIGIN });
    const res = await probeApp().fetch(
      new Request(`${env.APP_ORIGIN}/api/probe`, {
        method: 'DELETE',
        headers: { ...Object.fromEntries(noType), Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    await expectCsrf(res);
  });

  it('application/json with a charset parameter, in any case, is accepted', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON']) {
      expect((await csrf(sameOriginJson({ 'Content-Type': type }))).status, type).toBe(200);
    }
  });

  it('safe methods are not checked', async () => {
    const res = await probe(probeApp(), { token });
    expect(res.status).toBe(200);
  });

  it('a refused request changes nothing: the session is not extended and the limiter is not asked', async () => {
    const calls: string[] = [];
    const limiter: ApiRateLimiter = {
      limit: ({ key }) => {
        calls.push(key);
        return Promise.resolve({ success: true });
      },
    };
    await expectCsrf(
      await probe(probeApp(limiter), {
        method: 'POST',
        token,
        headers: sameOriginJson({ Origin: 'https://evil.example' }),
        body: '{}',
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe('AC8: API response headers', () => {
  async function expectHeaders(res: Response) {
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    await res.arrayBuffer();
  }

  it('is set on success, 401, 403, 404, 429 and the config_error and 500 short-circuits', async () => {
    await seedUser('u1');
    const token = await seedSession('u1', { now: nowSec() });
    const cookies = { [SESSION_COOKIE]: token };
    await expectHeaders(await h.call('GET', '/api/health'));
    await expectHeaders(await h.call('GET', '/api/auth/session'));
    await expectHeaders(await h.call('GET', '/api/me')); // 401
    await expectHeaders(await h.call('GET', '/api/nope', { cookies })); // 404
    await expectHeaders(
      await h.call('POST', '/api/auth/logout', {
        body: {},
        cookies,
        headers: { Origin: 'https://evil.example' },
      }),
    ); // 403
    const limited = await probe(probeApp({ limit: () => Promise.resolve({ success: false }) }), {
      token,
    });
    expect(limited.status).toBe(429);
    await expectHeaders(limited);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cfg = await createApp().fetch(new Request(`${env.APP_ORIGIN}/api/health`), {
      ...env,
      APP_ORIGIN: 'https://tidings.example.com',
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(cfg.status).toBe(500);
    await expectHeaders(cfg);
    const broken = await createApp().fetch(new Request(`${env.APP_ORIGIN}/api/auth/session`), {
      ...env,
      DB: undefined,
    } as unknown as typeof env);
    expect(broken.status).toBe(500);
    await expectHeaders(broken);
  });

  it('a cross-origin preflight gets no CORS headers and no session-free answer', async () => {
    const res = await h.call('OPTIONS' as 'GET', '/api/auth/session', {
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull();
    expect(res.status).not.toBe(200);
  });
});

describe('AC9: one user never reaches another user’s data', () => {
  it('each session resolves to its own user, and sign-out deletes only its own session', async () => {
    await seedUser('a');
    await seedUser('b');
    const tokenA = await seedSession('a', { now: nowSec() });
    const tokenB = await seedSession('b', { now: nowSec() });
    const app = probeApp();
    expect(await (await probe(app, { token: tokenA })).json()).toEqual({ userId: 'a' });
    expect(await (await probe(app, { token: tokenB })).json()).toEqual({ userId: 'b' });

    await h.call('POST', '/api/auth/logout', { body: {}, cookies: { [SESSION_COOKIE]: tokenB } });
    expect(await sessionRow(tokenB)).toBeNull();
    expect((await sessionRow(tokenA))?.user_id).toBe('a');
  });

  it('a session whose user was deleted stops working (cascade) instead of resolving to nobody', async () => {
    await seedUser('a');
    const token = await seedSession('a', { now: nowSec() });
    await env.DB.exec("DELETE FROM users WHERE id = 'a'");
    expect((await probe(probeApp(), { token })).status).toBe(401);
  });

  it('every ID input of every registered route has an isolation case, and the case’s test exists', () => {
    // Spec 10.8 and ADR 0012 (TID-013 AC11). Replaces the "no route takes an ID yet" tripwire.
    const sources = import.meta.glob('/test/*.test.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const table = new Map(ROUTE_TABLE.map((r) => [`${r.method} ${r.path}`, r]));
    const registered = createApp()
      .routes.filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`);

    const problems: string[] = [];
    for (const key of registered) {
      const row = table.get(key);
      if (!row) continue; // the AC6 test reports unlisted routes
      for (const param of row.path.matchAll(/:([A-Za-z]+)/g)) {
        if (!row.idInputs.includes(`path:${param[1]}`)) {
          problems.push(`${key}: path param :${param[1]} is not listed in idInputs`);
        }
      }
      for (const input of row.idInputs) {
        const found = ISOLATION_CASES[`${key} ${input}`];
        if (!found) {
          problems.push(`${key} ${input}: no isolation case`);
          continue;
        }
        const source = sources[`/test/${found.file}`];
        if (source === undefined || !source.includes(found.test)) {
          problems.push(`${key} ${input}: test "${found.test}" not found in ${found.file}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // The guard must be looking at something: POST /api/subscriptions takes a folderId.
    expect(registered).toContain('POST /api/subscriptions');
    expect(table.get('POST /api/subscriptions')?.idInputs).toEqual(['body:folderId']);
  });
});

describe('AC11: the API_RL per-user backstop', () => {
  let token: string;
  beforeEach(async () => {
    await seedUser('u1');
    token = await seedSession('u1', { now: nowSec() });
  });

  function stub(success: boolean | (() => Promise<{ success: boolean }>)) {
    const keys: string[] = [];
    const limiter: ApiRateLimiter = {
      limit: ({ key }) => {
        keys.push(key);
        return typeof success === 'function' ? success() : Promise.resolve({ success });
      },
    };
    return { limiter, keys };
  }

  it('asks the binding with the user ID as the key, and lets an allowed request through', async () => {
    const { limiter, keys } = stub(true);
    expect((await probe(probeApp(limiter), { token })).status).toBe(200);
    expect(keys).toEqual(['user:u1']);
  });

  it('when the binding says exceeded: 429 rate_limited with Retry-After: 60, and the handler does not run', async () => {
    const { limiter } = stub(false);
    const res = await probe(probeApp(limiter), { token });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('through the real app: an authenticated route (logout) is 429 and does not run', async () => {
    const { limiter } = stub(false);
    const limited = createHarness({ apiRateLimit: limiter });
    const res = await limited.call('POST', '/api/auth/logout', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await sessionRow(token)).not.toBeNull();
  });

  it('every session route in the table is limited, including each folder and subscription route (spec 10.7)', async () => {
    // TID-014: the guard is `app.use('*')`, so a new route is covered without opting in. This
    // proves it for every row, so a route mounted outside the guard fails here.
    const { limiter, keys } = stub(false);
    const limited = createHarness({ apiRateLimit: limiter });
    const rows = ROUTE_TABLE.filter((r) => !r.public);
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'POST /api/subscriptions',
        'GET /api/subscriptions',
        'PATCH /api/subscriptions/:id',
        'DELETE /api/subscriptions/:id',
        'GET /api/folders',
        'POST /api/folders',
        'PATCH /api/folders/:id',
        'DELETE /api/folders/:id',
      ]),
    );
    const notLimited: string[] = [];
    for (const row of rows) {
      const res = await limited.call(row.method, concretePath(row.path), {
        body: row.method === 'GET' ? undefined : {}, // spec 10.3: mutations declare JSON
        cookies: { [SESSION_COOKIE]: token },
      });
      if (res.status !== 429) notLimited.push(`${row.method} ${row.path} -> ${res.status}`);
    }
    expect(notLimited).toEqual([]);
    expect(keys).toHaveLength(rows.length);
  });

  it('is keyed per user: a limited user does not limit another', async () => {
    await seedUser('u2');
    const token2 = await seedSession('u2', { now: nowSec() });
    const limiter: ApiRateLimiter = {
      limit: ({ key }) => Promise.resolve({ success: key !== 'user:u1' }),
    };
    const app = probeApp(limiter);
    expect((await probe(app, { token })).status).toBe(429);
    expect((await probe(app, { token: token2 })).status).toBe(200);
  });

  it('auth routes never consult it: health, session, setup, login (and a request with no session)', async () => {
    const { limiter, keys } = stub(false);
    const limited = createHarness({ apiRateLimit: limiter });
    expect((await limited.call('GET', '/api/health')).status).toBe(200);
    expect((await limited.call('GET', '/api/auth/session')).status).toBe(200);
    expect((await limited.call('POST', '/api/auth/login/options', { body: {} })).status).toBe(200);
    expect((await limited.call('POST', '/api/auth/login/verify', { body: {} })).status).toBe(400);
    expect(
      (
        await limited.call('POST', '/api/auth/setup/options', {
          body: { setupToken: 'wrong', displayName: 'x' },
        })
      ).status,
    ).toBe(409); // an owner exists
    expect((await limited.call('GET', '/api/me')).status).toBe(401);
    expect(keys).toEqual([]);
  });

  it('the production binding exists, is wired, and a fresh key is allowed', async () => {
    expect(typeof env.API_RL.limit).toBe('function');
    const app = probeApp(); // no stub: uses env.API_RL
    expect((await probe(app, { token })).status).toBe(200);
  });

  it('a binding that throws fails open (it is a backstop) and logs without the exception text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { limiter } = stub(() => Promise.reject(new Error('secret detail')));
    expect((await probe(probeApp(limiter), { token })).status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
  });
});

describe('AC12: unhandled exceptions', () => {
  it('return 500 internal with a fixed message and none of the exception text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await createApp().fetch(new Request(`${env.APP_ORIGIN}/api/auth/session`), {
      ...env,
      DB: {
        prepare() {
          throw new Error('SQLITE_ERROR: no such table: secrets /srv/db.sqlite');
        },
      },
    } as unknown as typeof env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
    expect(log).toHaveBeenCalled();
  });
});

describe('sessions and users in other tables are untouched by guard traffic', () => {
  it('a refused request writes no rows', async () => {
    await resetAuthTables();
    await probe(probeApp(), { token: 'nope' });
    expect(await countRows('sessions')).toBe(0);
    expect(await countRows('rate_limits')).toBe(0);
  });
});
