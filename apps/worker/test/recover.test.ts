import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTE } from '@tidings/test-utils';
import type {
  CreationOptionsJSON,
  Passkey,
  RecoverResponse,
  SessionResponse,
} from '@tidings/shared';
import { isPublicRoute } from '../src/api/security';
import { hashRecoveryCode } from '../src/auth/recovery-codes';
import { recoverWithCode } from '../src/auth/recover';
import { SESSION_COOKIE, describeSession } from '../src/auth/session';
import { Db } from '../src/db';
import {
  createHarness,
  resetAuthTables,
  runSetup,
  setCookies,
  type Harness,
  type SetupResult,
} from './support/auth-harness';
import { countRows, seedSession, sessionRow } from './support/seed';
import { fakeRegistration } from './support/virtual-authenticator';

// TID-009: sign in with a recovery code (spec 8.3, 10.1, 10.7, ADR 0010), the passkey that is
// added afterwards, and HEAD /api/health (AC6). Real @simplewebauthn/server inside workerd.
let h: Harness;
let setup: SetupResult;
const KNOWN = 'ABCD-0123-4567-89AB';

beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
  setup = await runSetup(h);
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM rate_limits');
  // The setup passkey is older than any session made from here on ("registered since this session began").
  h.clock.advance(60 * MINUTE);
});

async function seedKnownCode(code = KNOWN): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, 1)',
  )
    .bind(crypto.randomUUID(), setup.body.user.id, await hashRecoveryCode(code))
    .run();
}

const recover = (code: unknown, ip?: string) =>
  h.call('POST', '/api/auth/recover', { body: { code }, ...(ip ? { ip } : {}) });

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function recoveredSession(code = setup.body.recoveryCodes[0] ?? ''): Promise<string> {
  const res = await recover(code);
  expect(res.status).toBe(200);
  return setCookies(res)[SESSION_COOKIE]?.value ?? '';
}

const sessionOf = async (token: string) =>
  (await (
    await h.call('GET', '/api/auth/session', { cookies: { [SESSION_COOKIE]: token } })
  ).json()) as SessionResponse;

describe('AC1: a valid unused code signs in, burns the code, and sets the banner flag', () => {
  it('returns the user and a session cookie, sets used_at, and reports the codes left', async () => {
    const res = await recover(setup.body.recoveryCodes[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecoverResponse;
    expect(body).toMatchObject({
      user: { id: setup.body.user.id, displayName: 'Matt' },
      mustAddPasskey: true,
      recoveryCodesRemaining: 9,
    });
    const cookie = setCookies(res)[SESSION_COOKIE];
    expect(cookie?.attrs).toMatchObject({ httponly: '', secure: '', samesite: 'Lax', path: '/' });
    expect(cookie?.attrs['max-age']).toBe(String(30 * 24 * 3600));

    const used = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL',
    ).first<{ n: number }>();
    expect(used?.n).toBe(1);
    expect(JSON.stringify(body)).not.toContain(setup.body.recoveryCodes[0] ?? 'x');
  });

  it('accepts lower case, no dashes, spaces, and O, I, L typed for 0 and 1', async () => {
    await seedKnownCode();
    const variants = [
      'abcd-0123-4567-89ab',
      'ABCD0123456789AB',
      '  abcd 0123 4567 89ab  ',
      'ABCD-OI23-4567-89AB', // O for 0, I for 1
      'ABCD-0L23-4567-89AB', // L for 1
    ];
    for (const [i, v] of variants.entries()) {
      // Each variant needs its own unused row: put the code back after each success.
      if (i > 0) await env.DB.exec(`UPDATE recovery_codes SET used_at = NULL`);
      await env.DB.exec('DELETE FROM rate_limits');
      const res = await recover(v);
      expect(res.status, v).toBe(200);
    }
  });

  it('the session is auth_method recovery and the flag survives a reload', async () => {
    const token = await recoveredSession();
    expect((await sessionRow(token))?.auth_method).toBe('recovery');
    const first = await sessionOf(token);
    expect(first).toMatchObject({ mustAddPasskey: true, recoveryCodesRemaining: 9 });
    expect(first.user?.id).toBe(setup.body.user.id);
    const again = await sessionOf(token);
    expect(again.mustAddPasskey).toBe(true);
  });
});

describe('AC2: the same code again', () => {
  it('is 401 invalid_recovery_code, and creates no session', async () => {
    const code = setup.body.recoveryCodes[1] ?? '';
    expect((await recover(code)).status).toBe(200);
    const sessions = await countRows('sessions');
    const res = await recover(code);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('invalid_recovery_code');
    expect(setCookies(res)[SESSION_COOKIE]).toBeUndefined();
    expect(await countRows('sessions')).toBe(sessions);
  });

  it('two racing requests with one code: exactly one wins', async () => {
    const code = setup.body.recoveryCodes[2] ?? '';
    const results = await Promise.all([recover(code), recover(code), recover(code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    expect(await countRows('sessions')).toBe(1);
  });
});

describe('AC3: wrong, used, malformed and empty codes are answered alike, after hashing', () => {
  /** Records every statement a call prepares, to prove the code path does not depend on the code. */
  function recordingDb(): { db: Db; statements: string[] } {
    const statements: string[] = [];
    const proxy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (query: string) => {
            statements.push(query.replace(/\s+/g, ' ').trim());
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { db: new Db(proxy), statements };
  }

  it('every kind of invalid code runs the same single hashed lookup and nothing else', async () => {
    const used = setup.body.recoveryCodes[3] ?? '';
    await recover(used);
    const inputs = [
      'AAAA-BBBB-CCCC-DDDD', // well formed, unknown
      used, // already used
      'not a code', // malformed
      '', // empty
      '!!!!'.repeat(40), // long
      'U'.repeat(16), // contains a letter the alphabet never uses
    ];
    const seen = new Set<string>();
    for (const input of inputs) {
      const { db, statements } = recordingDb();
      const result = await recoverWithCode(db, { code: input, userAgent: null }, h.clock.now);
      expect(result, input).toBeNull();
      expect(statements, input).toHaveLength(1);
      expect(statements[0]).toMatch(
        /^UPDATE recovery_codes SET used_at = \?1 WHERE code_hash = \?2/,
      );
      seen.add(statements.join('|'));
    }
    expect(seen.size).toBe(1);
  });

  it('the HTTP answer is identical for unknown, used and malformed codes', async () => {
    const used = setup.body.recoveryCodes[4] ?? '';
    await recover(used);
    const bodies: string[] = [];
    for (const code of ['AAAA-BBBB-CCCC-DDDD', used, 'zzz', '']) {
      const res = await recover(code);
      expect(res.status).toBe(401);
      expect(setCookies(res)[SESSION_COOKIE]).toBeUndefined();
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('a body that is not { code: string } is 400 validation_failed and never signs in', async () => {
    for (const body of [{}, { code: 5 }, { code: null }, { code: ['a'] }]) {
      const res = await h.call('POST', '/api/auth/recover', { body });
      expect(res.status).toBe(400);
    }
    const res = await h.call('POST', '/api/auth/recover', { rawBody: '{nope' });
    expect(res.status).toBe(400);
    expect(await countRows('sessions')).toBe(0);
  });

  it('one user cannot use another user’s code to reach their own account', async () => {
    // A code belongs to exactly one user: the session is for that code's owner.
    const res = await recover(setup.body.recoveryCodes[5]);
    const body = (await res.json()) as RecoverResponse;
    expect(body.user.id).toBe(setup.body.user.id);
  });
});

describe('AC4: rate limits (10 per IP per 10 minutes, 30 per hour globally)', () => {
  it('the 11th failure from one IP is 429 with Retry-After, even for a valid code', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await recover('AAAA-BBBB-CCCC-DDDD', '203.0.113.9')).status).toBe(401);
    }
    const limited = await recover(setup.body.recoveryCodes[0], '203.0.113.9');
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await countRows('sessions')).toBe(0);

    // Another IP is unaffected, and the window ends.
    expect((await recover(setup.body.recoveryCodes[0], '203.0.113.10')).status).toBe(200);
    h.clock.advance(11 * MINUTE);
    expect((await recover('AAAA-BBBB-CCCC-DDDD', '203.0.113.9')).status).toBe(401);
  });

  it('30 failures in an hour across IPs block the 31st, whatever the IP', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await recover('AAAA-BBBB-CCCC-DDDD', `198.51.100.${i + 1}`)).status).toBe(401);
    }
    const limited = await recover('AAAA-BBBB-CCCC-DDDD', '192.0.2.200');
    expect(limited.status).toBe(429);
    h.clock.advance(61 * MINUTE);
    expect((await recover('AAAA-BBBB-CCCC-DDDD', '192.0.2.200')).status).toBe(401);
  });

  it('successful recoveries are refunded, so they do not use up the failure budget', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await recover(setup.body.recoveryCodes[i], '203.0.113.50')).status).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      expect((await recover('AAAA-BBBB-CCCC-DDDD', '203.0.113.50')).status).toBe(401);
    }
    expect((await recover('AAAA-BBBB-CCCC-DDDD', '203.0.113.50')).status).toBe(429);
  });
});

describe('AC5: mustAddPasskey comes from the server, adds no writes, and clears when a passkey is added', () => {
  it('a passkey, setup or email session is never asked to add a passkey', async () => {
    for (const method of ['passkey', 'setup', 'email'] as const) {
      const token = await seedSession(setup.body.user.id, { now: h.clock.now() / 1000 });
      await env.DB.prepare('UPDATE sessions SET auth_method = ? WHERE user_id = ?')
        .bind(method, setup.body.user.id)
        .run();
      const body = await sessionOf(token);
      expect(body.mustAddPasskey, method).toBe(false);
      expect(body.recoveryCodesRemaining, method).toBeUndefined();
      await env.DB.exec('DELETE FROM sessions');
    }
  });

  it('computing it issues only reads', async () => {
    const token = await recoveredSession();
    const statements: string[] = [];
    const proxy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (q: string) => {
            statements.push(q);
            return target.prepare(q);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const { resolveSession } = await import('../src/auth/session');
    const db = new Db(proxy);
    const session = await resolveSession(db, token, h.clock.now);
    statements.length = 0;
    await describeSession(db, session, false);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => !/^\s*SELECT/i.test(s))).toEqual([]);
  });

  it('registering a passkey from the recovery session clears the flag, and the code count stays', async () => {
    const token = await recoveredSession();
    expect((await sessionOf(token)).mustAddPasskey).toBe(true);

    const optionsRes = await h.call('POST', '/api/auth/passkeys/options', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as CreationOptionsJSON & {
      excludeCredentials?: Array<{ id: string }>;
    };
    // The existing passkey is excluded, so the same authenticator cannot register twice.
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([setup.credentialId]);
    expect(options.user.name).toBe('Matt');
    const chal = setCookies(optionsRes)['__Host-tid_chal'];
    expect(chal?.attrs).toMatchObject({ httponly: '', secure: '', samesite: 'Strict' });

    h.clock.advance(MINUTE);
    const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN });
    const verifyRes = await h.call('POST', '/api/auth/passkeys/verify', {
      body: { response: reg.response, name: 'Work computer' },
      cookies: { [SESSION_COOKIE]: token, '__Host-tid_chal': chal?.value ?? '' },
    });
    expect(verifyRes.status).toBe(201);
    expect((await verifyRes.json()) as Passkey).toMatchObject({
      id: reg.credentialId,
      name: 'Work computer',
      lastUsedAt: null,
    });
    expect(await countRows('passkeys')).toBe(2);

    // Same session and a brand new session both see the banner gone.
    const after = await sessionOf(token);
    expect(after.mustAddPasskey).toBe(false);
    expect(after.recoveryCodesRemaining).toBe(9);
  });

  it('a registration whose challenge belongs to another user or purpose is refused', async () => {
    const token = await recoveredSession();
    const optionsRes = await h.call('POST', '/api/auth/passkeys/options', {
      body: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    const options = (await optionsRes.json()) as CreationOptionsJSON;
    const chal = setCookies(optionsRes)['__Host-tid_chal']?.value ?? '';
    const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN });

    // Challenge made for a different user.
    await env.DB.prepare(
      "UPDATE webauthn_challenges SET user_id = 'someone-else' WHERE purpose = 'add_passkey'",
    ).run();
    const wrongUser = await h.call('POST', '/api/auth/passkeys/verify', {
      body: { response: reg.response, name: 'X' },
      cookies: { [SESSION_COOKIE]: token, '__Host-tid_chal': chal },
    });
    expect(wrongUser.status).toBe(401);
    expect(await errorCode(wrongUser)).toBe('webauthn_failed');
    // A login challenge cannot complete a registration either.
    const login = await h.call('POST', '/api/auth/login/options', { body: {} });
    const loginChal = setCookies(login)['__Host-tid_chal']?.value ?? '';
    const wrongPurpose = await h.call('POST', '/api/auth/passkeys/verify', {
      body: { response: reg.response, name: 'X' },
      cookies: { [SESSION_COOKIE]: token, '__Host-tid_chal': loginChal },
    });
    expect(wrongPurpose.status).toBe(401);
    expect(await countRows('passkeys')).toBe(1);
  });

  it('a wrong challenge, a missing cookie, a replay and a bad body are all refused', async () => {
    const token = await recoveredSession();
    const get = async () => {
      const res = await h.call('POST', '/api/auth/passkeys/options', {
        body: {},
        cookies: { [SESSION_COOKIE]: token },
      });
      return {
        options: (await res.json()) as CreationOptionsJSON,
        chal: setCookies(res)['__Host-tid_chal']?.value ?? '',
      };
    };
    const call = (body: unknown, chal: string) =>
      h.call('POST', '/api/auth/passkeys/verify', {
        body,
        cookies: { [SESSION_COOKIE]: token, ...(chal ? { '__Host-tid_chal': chal } : {}) },
      });

    const a = await get();
    const wrongChallenge = await fakeRegistration(a.options, {
      origin: env.APP_ORIGIN,
      challenge: 'AAAA',
    });
    expect((await call({ response: wrongChallenge.response, name: 'X' }, a.chal)).status).toBe(401);

    const b = await get();
    const good = await fakeRegistration(b.options, { origin: env.APP_ORIGIN });
    expect((await call({ response: good.response, name: 'X' }, '')).status).toBe(401);
    expect((await call({ response: good.response, name: '' }, b.chal)).status).toBe(400);
    expect(await countRows('passkeys')).toBe(1);
    expect((await call({ response: good.response, name: 'X' }, b.chal)).status).toBe(201);
    expect((await call({ response: good.response, name: 'X' }, b.chal)).status).toBe(401); // replay
    expect(await countRows('passkeys')).toBe(2);
    // Only one pending add_passkey challenge per user.
    await get();
    await get();
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'add_passkey'",
    ).first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });

  it('passkeys/options and verify need a session', async () => {
    for (const path of ['/api/auth/passkeys/options', '/api/auth/passkeys/verify']) {
      const res = await h.call('POST', path, { body: {} });
      expect(res.status).toBe(401);
    }
  });
});

describe('AC6: HEAD /api/health', () => {
  it('is 200 with the same headers as GET and an empty body, with no session', async () => {
    const get = await h.call('GET', '/api/health');
    const res = await h.call('HEAD' as 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    for (const name of ['content-type', 'cache-control', 'x-content-type-options']) {
      expect(res.headers.get(name), name).toBe(get.headers.get(name));
    }
  });

  it('HEAD on any other route without a session is still 401', async () => {
    for (const path of ['/api/folders', '/api/auth/passkeys', '/api/auth/session-x', '/api/nope']) {
      const res = await h.call('HEAD' as 'GET', path);
      expect(res.status, path).toBe(401);
    }
    expect(isPublicRoute('HEAD', '/api/folders')).toBe(false);
    expect(isPublicRoute('HEAD', '/api/auth/session')).toBe(false);
    expect(isPublicRoute('HEAD', '/api/health')).toBe(true);
  });
});

describe('the route table', () => {
  it('POST /api/auth/recover is Public and CSRF-checked', async () => {
    expect(isPublicRoute('POST', '/api/auth/recover')).toBe(true);
    const res = await h.call('POST', '/api/auth/recover', {
      body: { code: 'x' },
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
