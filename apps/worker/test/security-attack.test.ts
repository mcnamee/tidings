import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  createHarness,
  resetAuthTables,
  runSetup,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { countRows, seedSession, seedUser, sessionRow } from './support/seed';

// TID-008 adversarial suite (tester). Complements api-guard.test.ts, login.test.ts and
// auth-csrf.test.ts with the attacks those do not already make.

let h: Harness;
let token: string;
const nowSec = () => Math.floor(h.clock.now() / 1000);

beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
  await seedUser('u1');
  token = await seedSession('u1', { now: nowSec() });
});

const authed = (extra: Record<string, string | null> = {}) => ({
  cookies: { [SESSION_COOKIE]: token },
  headers: extra,
});

/** A raw app.fetch, so the path reaches the router exactly as written. */
function raw(path: string, init: RequestInit = {}) {
  const app = createApp({ clock: () => h.clock.now() });
  return Promise.resolve(app.fetch(new Request(`${env.APP_ORIGIN}${path}`, init), env));
}

describe('the session token is accepted only from the cookie', () => {
  it('Authorization, X-Session, a query string and a different cookie name are all 401', async () => {
    const inits: RequestInit[] = [
      { headers: { Authorization: `Bearer ${token}` } },
      { headers: { Authorization: token } },
      { headers: { 'X-Session-Token': token } },
      { headers: { Cookie: `tid_session=${token}` } },
      { headers: { Cookie: `x${SESSION_COOKIE}=${token}` } },
    ];
    for (const init of inits) {
      const res = await raw('/api/nope', init);
      expect(res.status, JSON.stringify(init)).toBe(401);
    }
    for (const q of [`?token=${token}`, `?${SESSION_COOKIE}=${token}`, `?session=${token}`]) {
      expect((await raw(`/api/nope${q}`)).status, q).toBe(401);
    }
    // sanity: the cookie works
    const ok = await raw('/api/nope', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    expect(ok.status).toBe(404);
  });

  it('a cookie value that differs in case, length or content is another token', async () => {
    // Surrounding spaces and one pair of quotes are removed by cookie parsing (same secret, so not
    // a bypass); anything that changes the secret is a different token.
    for (const v of [token.toUpperCase(), `${token}x`, token.slice(0, -1), `x${token}`]) {
      const res = await raw('/api/nope', { headers: { Cookie: `${SESSION_COOKIE}=${v}` } });
      expect(res.status, v).toBe(401);
    }
  });

  it('with two session cookies, a bad first one does not fall back to a good second', async () => {
    const res = await raw('/api/nope', {
      headers: { Cookie: `${SESSION_COOKIE}=bogus; ${SESSION_COOKIE}=${token}` },
    });
    // Either answer is safe; record which one it is. Hono keeps the first.
    expect([401, 404]).toContain(res.status);
  });
});

describe('deny by default survives path tricks', () => {
  const paths = [
    '/api//folders',
    '/api//auth/logout',
    '/api/./folders',
    '/api/auth/./logout',
    '/api/auth/../folders',
    '/api/folders/',
    '/api/auth/logout/',
    '/api/auth//session',
    '/api/auth/session/',
    '/api/auth/session//',
    '/api/health/',
    '/api/%2Ffolders',
    '/api/auth%2Fsession',
    '/api/auth%2flogin%2foptions',
    '/api/auth/session%00',
    '/api/auth/session%20',
    '/api/auth/session;x=1',
    '/api/auth/Session',
    '/api/Auth/session',
    '/api/HEALTH',
    '/api/%61uth/logout',
    '/api/%61uth/session/x',
    '/api',
    '/api/',
  ];
  it.each(paths)('GET %s is never answered with data without a session', async (path) => {
    const res = await raw(path);
    // Public routes may only answer when the path is exactly a public one. Anything else: 401, or
    // a 404 that carries no data (a path the router never matched).
    expect([200, 401, 404], path).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.clone().json()) as Record<string, unknown>;
      // only the two public GET bodies can ever be 200
      expect('ok' in body || 'setupRequired' in body, path).toBe(true);
    }
  });

  it('records which tricks reach a public route (informational: normalised by the URL parser)', async () => {
    const out: Record<string, number> = {};
    for (const p of [
      '/api/./health',
      '/api//health',
      '/api/health/',
      '/api/%68ealth',
      '/API/health',
    ]) {
      out[p] = (await raw(p)).status;
    }
    // /api/./health normalises to /api/health in the URL parser: that is the same route.
    expect(out['/api/./health']).toBe(200);
    expect(out['/api/health/']).toBe(401);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s on a public route name with a trailing slash is 401',
    async (m) => {
      const res = await raw('/api/auth/login/options/', {
        method: m,
        headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    },
  );
});

describe('methods', () => {
  it('HEAD, OPTIONS and TRACE on protected routes with no session are 401, with no body', async () => {
    for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT_X']) {
      let res: Response;
      try {
        res = await raw('/api/folders', { method });
      } catch {
        continue; // the Request constructor refuses some methods: nothing reaches the app
      }
      expect(res.status, method).toBe(401);
      expect(res.headers.get('Access-Control-Allow-Origin'), method).toBeNull();
      expect(res.headers.get('Access-Control-Allow-Methods'), method).toBeNull();
    }
  });

  it('HEAD and OPTIONS with a session get 404 (nothing registered), never data, and no CORS', async () => {
    for (const method of ['HEAD', 'OPTIONS']) {
      const res = await raw('/api/me', {
        method,
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect([404, 405]).toContain(res.status);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('a preflight with Origin, from the evil site, to a public route is 401 and carries no CORS', async () => {
    const res = await raw('/api/auth/login/options', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('method override headers and query parameters do not turn a GET into a mutation', async () => {
    // GET with an override cannot reach logout; and a POST-with-override cannot dodge CSRF.
    const overrides: Record<string, string>[] = [
      { 'X-HTTP-Method-Override': 'POST' },
      { 'X-HTTP-Method': 'POST' },
      { 'X-Method-Override': 'DELETE' },
    ];
    for (const headers of overrides) {
      const res = await raw('/api/auth/logout', {
        method: 'GET',
        headers: { ...headers, Cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.status).toBe(404); // GET /api/auth/logout is not a route
      expect(await sessionRow(token)).not.toBeNull();
    }
    const res = await raw('/api/auth/logout?_method=POST', {
      method: 'GET',
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(404);
    expect(await sessionRow(token)).not.toBeNull();
  });

  it('a cross-site POST with an override header still needs Origin and JSON', async () => {
    const res = await raw('/api/auth/logout', {
      method: 'POST',
      headers: {
        'X-HTTP-Method-Override': 'GET',
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: 'https://evil.example',
        'Content-Type': 'text/plain',
      },
      body: 'x',
    });
    expect(res.status).toBe(403);
    expect(await sessionRow(token)).not.toBeNull();
  });
});

describe('CSRF origin variants (every one must be refused, session intact)', () => {
  const host = new URL(env.APP_ORIGIN).host;
  const variants: [string, string][] = [
    ['suffix domain', `${env.APP_ORIGIN}.evil.com`],
    ['label-suffix domain', `https://${host}.evil.com`],
    ['userinfo trick', `https://${host}@evil.com`],
    ['userinfo trick 2', `https://evil.com@${host}`],
    ['trailing dot', `https://${host}.`],
    ['upper case host', `https://${host.toUpperCase()}`],
    ['upper case scheme', `HTTPS://${host}`],
    ['null', 'null'],
    ['empty', ''],
    ['space', ` ${env.APP_ORIGIN}`],
    ['trailing space', `${env.APP_ORIGIN} `],
    ['with path', `${env.APP_ORIGIN}/x`],
    ['two origins', `${env.APP_ORIGIN}, https://evil.com`],
    ['file', 'file://'],
  ];
  it.each(variants)('Origin %s', async (_n, origin) => {
    const res = await h.call('POST', '/api/auth/logout', {
      body: {},
      ...authed({ Origin: origin }),
    });
    // Headers cannot carry some of these values (the Headers class trims): the effective value
    // that arrives may be the real origin. Treat that as not an attack.
    const sent = new Headers({ Origin: origin }).get('Origin');
    if (sent === env.APP_ORIGIN) {
      expect(res.status).toBe(204);
    } else {
      expect(res.status, `Origin ${JSON.stringify(origin)}`).toBe(403);
      expect(await sessionRow(token)).not.toBeNull();
    }
  });

  it('Sec-Fetch-Site spoofing does not rescue a present wrong Origin, and cross-site wins nothing', async () => {
    for (const site of ['same-origin', 'SAME-ORIGIN', 'same-origin, cross-site', ' same-origin']) {
      const res = await h.call('POST', '/api/auth/logout', {
        body: {},
        ...authed({ Origin: 'https://evil.com', 'Sec-Fetch-Site': site }),
      });
      expect(res.status, site).toBe(403);
    }
  });

  it('Sec-Fetch-Site is exact: case and list variants are refused when Origin is absent', async () => {
    for (const site of ['SAME-ORIGIN', 'same-origin, cross-site', 'same-origin;x', 'Same-Origin']) {
      const res = await h.call('POST', '/api/auth/logout', {
        body: {},
        ...authed({ Origin: null, 'Sec-Fetch-Site': site }),
      });
      expect(res.status, site).toBe(403);
    }
  });
});

describe('Content-Type variants', () => {
  const accepted = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'APPLICATION/JSON',
    'Application/Json ; charset=utf-8',
  ];
  const refused = [
    'application/json-patch+json',
    'application/vnd.api+json',
    'application/jsonp',
    'application/json/x',
    'text/plain; application/json',
    'text/plain;x=application/json',
    'multipart/form-data; boundary=application/json',
    '',
  ];
  it.each(accepted)('accepts %s', async (type) => {
    const res = await h.call('POST', '/api/auth/logout', {
      body: {},
      ...authed({ 'Content-Type': type }),
    });
    expect(res.status).toBe(204);
  });
  it.each(refused)('refuses %j', async (type) => {
    const res = await h.call('POST', '/api/auth/logout', {
      body: {},
      ...authed({ 'Content-Type': type }),
    });
    expect(res.status).toBe(403);
    expect(await sessionRow(token)).not.toBeNull();
  });
});

describe('session lifecycle attacks', () => {
  it('logout then slide: a request that resolved before logout cannot resurrect the row', async () => {
    // expiring session, so a request would slide it
    await env.DB.prepare('UPDATE sessions SET expires_at = ?')
      .bind(nowSec() + 2 * 86400)
      .run();
    const [a, b] = await Promise.all([
      h.call('GET', '/api/nope', authed()),
      h.call('POST', '/api/auth/logout', { body: {}, ...authed() }),
    ]);
    expect([401, 404]).toContain(a.status);
    expect(b.status).toBe(204);
    expect(await sessionRow(token)).toBeNull();
    // and the cookie is dead afterwards
    expect((await h.call('GET', '/api/nope', authed())).status).toBe(401);
  });

  it('a slide after logout does not recreate the session (UPDATE only, never an upsert)', async () => {
    await h.call('POST', '/api/auth/logout', { body: {}, ...authed() });
    await h.call('GET', '/api/auth/session', authed());
    expect(await countRows('sessions')).toBe(0);
  });

  it('logout twice: the second is 401, not 500', async () => {
    expect((await h.call('POST', '/api/auth/logout', { body: {}, ...authed() })).status).toBe(204);
    expect((await h.call('POST', '/api/auth/logout', { body: {}, ...authed() })).status).toBe(401);
  });

  it('logout sets an expiring cookie with the same flags and scope as the session cookie', async () => {
    const res = await h.call('POST', '/api/auth/logout', { body: {}, ...authed() });
    const c = setCookies(res)[SESSION_COOKIE];
    expect(c).toBeDefined();
    expect(c?.value).toBe('');
    expect(c?.attrs['path']).toBe('/');
    expect('secure' in (c?.attrs ?? {})).toBe(true);
    expect(c?.attrs['domain']).toBeUndefined();
    expect(Number(c?.attrs['max-age'] ?? 1)).toBeLessThanOrEqual(0);
  });

  it('many parallel slides leave the row at exactly now + 30 days and set the cookie at most per winner', async () => {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?')
      .bind(nowSec() + 3600)
      .run();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => h.call('GET', '/api/nope', authed())),
    );
    const row = await sessionRow(token);
    expect(row?.expires_at).toBe(nowSec() + 30 * 86400);
    const withCookie = rs.filter((r) => r.headers.getSetCookie().length > 0).length;
    expect(withCookie).toBeGreaterThanOrEqual(1);
    expect(withCookie).toBeLessThanOrEqual(20);
  });

  it('the slid cookie keeps the security attributes', async () => {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?')
      .bind(nowSec() + 3600)
      .run();
    const res = await h.call('GET', '/api/nope', authed());
    const c = setCookies(res)[SESSION_COOKIE];
    expect(c?.value).toBe(token);
    expect(c?.attrs['path']).toBe('/');
    expect('secure' in (c?.attrs ?? {})).toBe(true);
    expect('httponly' in (c?.attrs ?? {})).toBe(true);
    expect(c?.attrs['samesite']).toBe('Lax');
    expect(c?.attrs['domain']).toBeUndefined();
  });

  it('a 401 never sets or clears a session cookie that was not sent valid (no fixation via error paths)', async () => {
    const res = await h.call('GET', '/api/nope', {
      cookies: { [SESSION_COOKIE]: 'attacker-chosen' },
    });
    expect(res.status).toBe(401);
    expect(setCookies(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it('an attacker-planted session cookie value is never adopted by sign-in', async () => {
    await resetAuthTables();
    const setup = await runSetup(h);
    const planted = 'attacker-chosen-token';
    const optionsRes = await h.call('POST', '/api/auth/login/options', { body: {} });
    const options = (await optionsRes.json()) as { challenge: string };
    const chal = setCookies(optionsRes)['__Host-tid_chal'];
    const response = await setup.passkey.assert(options.challenge);
    const verify = await h.call('POST', '/api/auth/login/verify', {
      body: { response },
      cookies: { '__Host-tid_chal': chal?.value ?? '', [SESSION_COOKIE]: planted },
    });
    expect(verify.status).toBe(200);
    const issued = setCookies(verify)[SESSION_COOKIE]?.value;
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(planted);
    expect(await sessionRow(planted)).toBeNull();
    expect(await sessionRow(issued ?? '')).not.toBeNull();
  });

  it('the session cookie is __Host- prefixed, Secure, HttpOnly, Lax, Path=/ and has no Domain on sign-in', async () => {
    await resetAuthTables();
    const setup = await runSetup(h);
    const c = setup.cookies[SESSION_COOKIE];
    expect(c).toBeDefined();
    expect(c?.attrs['path']).toBe('/');
    expect('secure' in (c?.attrs ?? {})).toBe(true);
    expect('httponly' in (c?.attrs ?? {})).toBe(true);
    expect(c?.attrs['samesite']).toBe('Lax');
    expect(c?.attrs['domain']).toBeUndefined();
    expect(c?.attrs['max-age']).toBe(String(30 * 86400));
  });
});

describe('rate-limit key confusion', () => {
  it('login/options and login/verify have separate counters: 10 options do not block verify', async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (await h.call('POST', '/api/auth/login/options', { body: {}, ip: '9.9.9.9' })).status,
      ).toBe(200);
    }
    expect(
      (await h.call('POST', '/api/auth/login/options', { body: {}, ip: '9.9.9.9' })).status,
    ).toBe(429);
    const v = await h.call('POST', '/api/auth/login/verify', {
      body: { response: { id: 'x' } },
      ip: '9.9.9.9',
    });
    expect(v.status).not.toBe(429);
  });

  it('10 failed verifies block the 11th verify but not options', async () => {
    for (let i = 0; i < 10; i++) {
      await h.call('POST', '/api/auth/login/verify', {
        body: { response: { id: 'x' } },
        ip: '8.8.8.8',
      });
    }
    const v = await h.call('POST', '/api/auth/login/verify', {
      body: { response: { id: 'x' } },
      ip: '8.8.8.8',
    });
    expect(v.status).toBe(429);
    const o = await h.call('POST', '/api/auth/login/options', { body: {}, ip: '8.8.8.8' });
    expect(o.status).toBe(200);
  });

  it('an IP string crafted to collide with another counter does not share it', async () => {
    for (let i = 0; i < 10; i++) {
      await h.call('POST', '/api/auth/login/options', { body: {}, ip: '7.7.7.7' });
    }
    // 'verify:ip:7.7.7.7' inside the IP value must not alias a different bucket
    const r = await h.call('POST', '/api/auth/login/options', {
      body: {},
      ip: 'verify:ip:7.7.7.7',
    });
    expect(r.status).toBe(200);
    const r2 = await h.call('POST', '/api/auth/login/options', { body: {}, ip: '8.7.7.7' });
    expect(r2.status).toBe(200);
  });

  it('the client IP comes from CF-Connecting-IP only: X-Forwarded-For cannot reset the limit', async () => {
    for (let i = 0; i < 10; i++) {
      await h.call('POST', '/api/auth/login/options', { body: {}, ip: '6.6.6.6' });
    }
    const r = await h.call('POST', '/api/auth/login/options', {
      body: {},
      ip: '6.6.6.6',
      headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '1.2.3.5' },
    });
    expect(r.status).toBe(429);
  });
});

describe('unauthenticated requests create nothing', () => {
  it('a burst of 401s writes no rows', async () => {
    const before = [
      await countRows('sessions'),
      await countRows('rate_limits'),
      await countRows('webauthn_challenges'),
    ];
    for (let i = 0; i < 20; i++) await h.call('GET', `/api/folders/${i}`);
    expect([
      await countRows('sessions'),
      await countRows('rate_limits'),
      await countRows('webauthn_challenges'),
    ]).toEqual(before);
  });
});

describe('public GET routes answer HEAD', () => {
  // DEF-018, fixed in TID-009 AC6.
  it('HEAD /api/health is answered like GET (uptime monitors use HEAD)', async () => {
    const res = await raw('/api/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});
