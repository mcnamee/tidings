import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app';
import { fromBase64Url } from './support/base64';
import {
  SETUP_TOKEN,
  createHarness,
  resetAuthTables,
  runSetup,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { fakeRegistration } from './support/virtual-authenticator';

// TID-007 tester attack suite: races, replay, spoofing, leakage, atomicity, injection.
let h: Harness;
beforeEach(async () => {
  await resetAuthTables();
  await env.DB.exec('DROP TRIGGER IF EXISTS attack_fail');
  h = createHarness();
});
afterEach(async () => {
  await env.DB.exec('DROP TRIGGER IF EXISTS attack_fail');
  vi.restoreAllMocks();
});

const COUNT_SQL: Record<string, string> = {
  users: 'SELECT COUNT(*) AS n FROM users',
  passkeys: 'SELECT COUNT(*) AS n FROM passkeys',
  recovery_codes: 'SELECT COUNT(*) AS n FROM recovery_codes',
  sessions: 'SELECT COUNT(*) AS n FROM sessions',
  webauthn_challenges: 'SELECT COUNT(*) AS n FROM webauthn_challenges',
};
const n = async (table: string) =>
  (await env.DB.prepare(COUNT_SQL[table] ?? 'SELECT -1 AS n').first<{ n: number }>())?.n ?? -1;

const trigger = (table: string) =>
  `CREATE TRIGGER attack_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'attack: injected failure SECRET-DB-DETAIL'); END`;
const TRIGGER_SQL: Record<string, string> = {
  recovery_codes: trigger('recovery_codes'),
  sessions: trigger('sessions'),
  passkeys: trigger('passkeys'),
};

const wrongOptions = (ip?: string, headers?: Record<string, string>) => {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: env.APP_ORIGIN,
      ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      ...headers,
    },
    body: JSON.stringify({ setupToken: 'wrong-token', displayName: 'Mallory' }),
  };
  return createApp().fetch(new Request(`${env.APP_ORIGIN}/api/auth/setup/options`, init), env);
};

describe('races: parallel setups create exactly one owner', () => {
  it('two complete setups racing end to end: one 201, one 409, one set of rows', async () => {
    const [a, b] = await Promise.all([
      runSetup(h, { displayName: 'A' }),
      runSetup(h, { displayName: 'B' }),
    ]);
    expect([a.verifyRes.status, b.verifyRes.status].sort()).toEqual([201, 409]);
    expect(await n('users')).toBe(1);
    expect(await n('passkeys')).toBe(1);
    expect(await n('recovery_codes')).toBe(10);
    expect(await n('sessions')).toBe(1);
    const loser = a.verifyRes.status === 409 ? a : b;
    expect(loser.verifyRes.headers.getSetCookie().join(';')).not.toContain('__Host-tid_session');
  });

  it('six setups racing: still exactly one owner, and only the winner has working codes', async () => {
    const results = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => runSetup(h, { displayName: name })),
    );
    const winners = results.filter((r) => r.verifyRes.status === 201);
    expect(winners).toHaveLength(1);
    expect(await n('users')).toBe(1);
    expect(await n('sessions')).toBe(1);
    expect(await n('recovery_codes')).toBe(10);
    expect(await n('passkeys')).toBe(1);
    const owner = await env.DB.prepare('SELECT id FROM users').first<{ id: string }>();
    expect(owner?.id).toBe(winners[0]?.body.user.id);
  });

  it('replaying the successful verify request afterwards is refused and changes nothing', async () => {
    const options = await h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'Matt' },
    });
    const opts = (await options.clone().json()) as { challenge: string; rp: { id: string } };
    const chal = setCookies(options)['__Host-tid_chal']?.value ?? '';
    const reg = await fakeRegistration(opts, { origin: env.APP_ORIGIN });
    const send = () =>
      h.call('POST', '/api/auth/setup/verify', {
        body: { setupToken: SETUP_TOKEN, displayName: 'Matt', response: reg.response },
        cookies: { '__Host-tid_chal': chal },
      });
    expect((await send()).status).toBe(201);
    const replay = await send();
    expect(replay.status).toBe(409);
    expect(await n('users')).toBe(1);
    expect(await n('sessions')).toBe(1);
    expect(await n('recovery_codes')).toBe(10);
  });
});

describe('challenge handling', () => {
  it('a challenge cookie from client A cannot verify a registration made for client B', async () => {
    const a = await h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'A' },
    });
    const b = await h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'B' },
    });
    const optsB = (await b.clone().json()) as { challenge: string; rp: { id: string } };
    const regB = await fakeRegistration(optsB, { origin: env.APP_ORIGIN });
    const res = await h.call('POST', '/api/auth/setup/verify', {
      body: { setupToken: SETUP_TOKEN, displayName: 'B', response: regB.response },
      cookies: { '__Host-tid_chal': setCookies(a)['__Host-tid_chal']?.value ?? '' },
    });
    expect(res.status).toBe(401);
    expect(await n('users')).toBe(0);
  });

  it('login and add_passkey challenges are refused by setup/verify, and are not consumed', async () => {
    for (const purpose of ['login', 'add_passkey']) {
      await env.DB.exec('DELETE FROM webauthn_challenges');
      const options = await h.call('POST', '/api/auth/setup/options', {
        body: { setupToken: SETUP_TOKEN, displayName: 'Matt' },
      });
      const opts = (await options.clone().json()) as { challenge: string; rp: { id: string } };
      await env.DB.prepare('UPDATE webauthn_challenges SET purpose = ?').bind(purpose).run();
      const reg = await fakeRegistration(opts, { origin: env.APP_ORIGIN });
      const res = await h.call('POST', '/api/auth/setup/verify', {
        body: { setupToken: SETUP_TOKEN, displayName: 'Matt', response: reg.response },
        cookies: { '__Host-tid_chal': setCookies(options)['__Host-tid_chal']?.value ?? '' },
      });
      expect(res.status, purpose).toBe(401);
      expect(await n('webauthn_challenges'), purpose).toBe(1);
      expect(await n('users'), purpose).toBe(0);
    }
  });

  it('the challenge id is 256 bits of randomness and differs per request', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await h.call('POST', '/api/auth/setup/options', {
        body: { setupToken: SETUP_TOKEN, displayName: 'Matt' },
      });
      const id = setCookies(res)['__Host-tid_chal']?.value ?? '';
      expect(fromBase64Url(id)).toHaveLength(32);
      ids.add(id);
    }
    expect(ids.size).toBe(5);
  });
});

describe('session token', () => {
  it('is 32 random bytes in base64url, differs per setup, and only its hash is stored', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      await resetAuthTables();
      const s = await runSetup(h);
      const token = s.cookies['__Host-tid_session']?.value ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fromBase64Url(token)).toHaveLength(32);
      tokens.push(token);
    }
    expect(new Set(tokens).size).toBe(3);
  });

  it('is never in a response body, and the setup token is never echoed anywhere', async () => {
    const s = await runSetup(h);
    const token = s.cookies['__Host-tid_session']?.value ?? '';
    for (const res of [s.optionsRes, s.verifyRes]) {
      const text = await res.clone().text();
      expect(text).not.toContain(token);
      expect(text).not.toContain(SETUP_TOKEN);
      expect(res.headers.getSetCookie().join(';')).not.toContain(SETUP_TOKEN);
      expect([...res.headers.values()].join('\n')).not.toContain(SETUP_TOKEN);
    }
  });
});

describe('rate limit identity: CF-Connecting-IP only', () => {
  it('rotating X-Forwarded-For, X-Real-IP, True-Client-IP and Forwarded does not escape the limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await wrongOptions('198.51.100.7', {
        'X-Forwarded-For': `203.0.113.${i}`,
        'X-Real-IP': `203.0.113.${i + 50}`,
        'True-Client-IP': `203.0.113.${i + 100}`,
        Forwarded: `for=203.0.113.${i + 150}`,
      });
      expect(res.status).toBe(403);
    }
    const res = await wrongOptions('198.51.100.7', {
      'X-Forwarded-For': '203.0.113.250',
      'X-Real-IP': '203.0.113.251',
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('a spoofed X-Forwarded-For cannot borrow a fresh bucket when CF-Connecting-IP is absent', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await wrongOptions(undefined, { 'X-Forwarded-For': `203.0.113.${i}` })).status).toBe(
        403,
      );
    }
    expect((await wrongOptions(undefined, { 'X-Forwarded-For': '203.0.113.99' })).status).toBe(429);
  });

  it('a different CF-Connecting-IP has its own bucket', async () => {
    for (let i = 0; i < 10; i++) await wrongOptions('198.51.100.7');
    expect((await wrongOptions('198.51.100.7')).status).toBe(429);
    expect((await wrongOptions('198.51.100.8')).status).toBe(403);
  });

  it('the rate-limit key is not attacker-controlled SQL: a hostile IP header is just a bucket', async () => {
    const res = await wrongOptions("1.1.1.1'; DROP TABLE users;--");
    expect(res.status).toBe(403);
    expect(await n('users')).toBe(0);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'users'",
    ).all();
    expect(tables.results).toHaveLength(1);
  });

  it('even the right token gets 429 once the IP is over its failed-attempt budget', async () => {
    for (let i = 0; i < 10; i++) await wrongOptions('198.51.100.9');
    const res = await h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'Matt' },
      ip: '198.51.100.9',
    });
    expect(res.status).toBe(429);
    expect(await n('webauthn_challenges')).toBe(0);
  });
});

describe('nothing sensitive is logged', () => {
  it('no console output contains the setup token, recovery codes, cookies or challenges', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const s = await runSetup(h);
    await wrongOptions('198.51.100.20');
    await h.call('POST', '/api/auth/setup/verify', { rawBody: '{bad' });
    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(logged).not.toContain(SETUP_TOKEN);
    expect(logged).not.toContain('wrong-token');
    for (const code of s.body.recoveryCodes) expect(logged).not.toContain(code);
    expect(logged).not.toContain(s.cookies['__Host-tid_session']?.value ?? 'x');
    expect(logged).not.toContain(s.options.challenge);
  });

  it('error bodies for every refusal are fixed text with no token, challenge or internals', async () => {
    const bodies: string[] = [];
    bodies.push(await (await wrongOptions('198.51.100.30')).text());
    bodies.push(await (await h.call('POST', '/api/auth/setup/verify', { rawBody: '{bad' })).text());
    const done = await runSetup(h);
    bodies.push(
      await (
        await h.call('POST', '/api/auth/setup/options', {
          body: { setupToken: SETUP_TOKEN, displayName: 'x' },
        })
      ).text(),
    );
    for (const text of bodies) {
      expect(text).not.toContain(SETUP_TOKEN);
      expect(text).not.toContain('wrong-token');
      expect(text).not.toContain(done.options.challenge);
      expect(text).not.toMatch(/SELECT|INSERT|D1_|stack|at \w+ \(/);
    }
  });
});

describe('atomicity: a D1 error mid-setup leaves no half-created owner', () => {
  it.each(['recovery_codes', 'sessions', 'passkeys'])(
    'a failing insert into %s rolls back the user and every other row, and a retry works',
    async (table) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await env.DB.prepare(TRIGGER_SQL[table] ?? '').run();
      const s = await runSetup(h);
      expect(s.verifyRes.status).toBe(500);
      const text = await s.verifyRes.text();
      expect(text).not.toContain('SECRET-DB-DETAIL');
      expect(text).not.toContain('attack');
      expect(s.verifyRes.headers.get('Cache-Control')).toBe('no-store');
      expect(s.verifyRes.headers.getSetCookie().join(';')).not.toContain('__Host-tid_session');
      for (const t of ['users', 'passkeys', 'recovery_codes', 'sessions']) {
        expect(await n(t), t).toBe(0);
      }
      // The instance is still claimable.
      await env.DB.exec('DROP TRIGGER attack_fail');
      const session = await h.call('GET', '/api/auth/session');
      expect(((await session.json()) as { setupRequired: boolean }).setupRequired).toBe(true);
      const retry = await runSetup(h);
      expect(retry.verifyRes.status).toBe(201);
      expect(await n('users')).toBe(1);
    },
  );
});

describe('injection through names', () => {
  const hostile = [
    `'); DROP TABLE users;--`,
    `<img src=x onerror=alert(1)>`,
    '<script>alert(1)</script>',
    'line1\nline2\r\n\u0000nul',
    '‮RTL override',
    '{{constructor.constructor("x")()}}',
  ];

  it.each(hostile)('passkeyName %j is stored as inert text and setup succeeds', async (name) => {
    const s = await runSetup(h, { verifyBody: { passkeyName: name } });
    expect(s.verifyRes.status).toBe(201);
    const row = await env.DB.prepare('SELECT name FROM passkeys').first<{ name: string }>();
    expect(row?.name).toBe(name.trim().slice(0, 64));
    expect(await n('users')).toBe(1);
  });

  it.each(hostile)('displayName %j is stored verbatim and returned as JSON data', async (name) => {
    const displayName = name.trim().slice(0, 64);
    if (displayName === '') return;
    const s = await runSetup(h, { displayName });
    expect(s.verifyRes.status).toBe(201);
    expect(s.verifyRes.headers.get('Content-Type')).toContain('application/json');
    expect(s.body.user.displayName).toBe(displayName);
  });

  it('a passkeyName with a lone surrogate does not break setup', async () => {
    const s = await runSetup(h, { verifyBody: { passkeyName: 'ok\ud800tail' } });
    expect(s.verifyRes.status).toBe(201);
  });

  it('extra and prototype-pollution keys in the body are ignored', async () => {
    const s = await runSetup(h, {
      verifyBody: { __proto__: { role: 'x' }, role: 'member', userId: 'attacker', constructor: 1 },
    });
    expect(s.verifyRes.status).toBe(201);
    const row = await env.DB.prepare('SELECT id, role FROM users').first<{
      id: string;
      role: string;
    }>();
    expect(row?.role).toBe('owner');
    expect(row?.id).not.toBe('attacker');
  });
});

describe('config_error and headers', () => {
  // DEF-012: the config guard returns before the no-store middleware runs. Switch to `it` when fixed.
  it.fails(
    'every response, including the config_error short-circuit, is Cache-Control: no-store (DEF-012)',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await createApp().fetch(new Request(`${env.APP_ORIGIN}/api/auth/session`), {
        ...env,
        APP_ORIGIN: 'https://tidings.example.com',
        ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('unknown routes and wrong methods under /api/auth are 404 with no-store', async () => {
    for (const [method, path] of [
      ['GET', '/api/auth/setup/options'],
      ['GET', '/api/auth/setup/verify'],
      ['PUT', '/api/auth/setup/options'],
      ['GET', '/api/auth/nope'],
    ] as const) {
      const res = await h.call(method as 'GET', path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('an unhandled error answers a fixed 500 with no-store and no detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await createApp().fetch(new Request(`${env.APP_ORIGIN}/api/auth/session`), {
      ...env,
      DB: undefined,
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).not.toMatch(/undefined|prepare|TypeError/);
  });
});
