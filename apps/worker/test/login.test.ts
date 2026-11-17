import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoginVerifyResponse, RequestOptionsJSON } from '@tidings/shared';
import {
  createHarness,
  resetAuthTables,
  runLogin,
  runSetup,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { countRows, sessionRow } from './support/seed';

// TID-008: passkey sign-in (spec 8.3, 10.1, 10.2, 10.7) against the real @simplewebauthn/server in
// workerd, with a software passkey registered through the real setup route.
let h: Harness;
beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
});

async function setUpOwner() {
  const setup = await runSetup(h);
  // Setup left one session behind; sign-in tests count the sessions they create.
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM rate_limits');
  return setup;
}

describe('AC1: sign in with a passkey creates a session', () => {
  it('login/options returns discoverable-credential options and sets the challenge cookie', async () => {
    await setUpOwner();
    const res = await h.call('POST', '/api/auth/login/options', { body: {} });
    expect(res.status).toBe(200);
    const options = (await res.json()) as RequestOptionsJSON;
    expect(options.rpId).toBe(env.RP_ID);
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.challenge.length).toBeGreaterThan(20);
    const chal = setCookies(res)['__Host-tid_chal'];
    expect(chal?.attrs).toMatchObject({
      httponly: '',
      secure: '',
      samesite: 'Strict',
      path: '/',
      'max-age': '300',
    });
    expect(chal?.attrs).not.toHaveProperty('domain');
    expect(await countRows('webauthn_challenges')).toBe(1);
  });

  it('login/verify with a valid assertion returns the user and a 30-day session cookie', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey);
    expect(login.verifyRes.status).toBe(200);
    const body = (await login.verifyRes.json()) as LoginVerifyResponse;
    expect(body.user).toMatchObject({ id: setup.body.user.id, displayName: 'Matt', role: 'owner' });

    const cookie = login.cookies['__Host-tid_session'];
    expect(cookie?.attrs).toMatchObject({
      httponly: '',
      secure: '',
      samesite: 'Lax',
      path: '/',
      'max-age': String(30 * 86400),
    });
    expect(cookie?.attrs).not.toHaveProperty('domain');
    // The cookie works.
    const session = await h.call('GET', '/api/auth/session', {
      cookies: { '__Host-tid_session': login.sessionToken ?? '' },
    });
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(setup.body.user.id);
  });

  it('stores only the SHA-256 of the token, with auth_method passkey (AC13) and the clock times', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey);
    const token = login.sessionToken ?? '';
    const row = await env.DB.prepare(
      'SELECT id_hash, user_id, auth_method, created_at, authenticated_at, expires_at, absolute_expires_at FROM sessions',
    ).first<Record<string, string | number>>();
    expect(row?.id_hash).not.toBe(token);
    expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.auth_method).toBe('passkey');
    const now = Math.floor(h.clock.now() / 1000);
    expect(row).toMatchObject({
      user_id: setup.body.user.id,
      created_at: now,
      authenticated_at: now,
      expires_at: now + 30 * 86400,
      absolute_expires_at: now + 180 * 86400,
    });
  });

  it('records the signature counter and last_used_at on the passkey', async () => {
    const setup = await setUpOwner();
    h.clock.advance(5000);
    await runLogin(h, setup.passkey, { assertion: { counter: 7 } });
    const key = await env.DB.prepare('SELECT counter, last_used_at FROM passkeys').first<{
      counter: number;
      last_used_at: number;
    }>();
    expect(key).toEqual({ counter: 7, last_used_at: Math.floor(h.clock.now() / 1000) });
  });

  it('every sign-in makes a new session with a new token, even when a session cookie is sent (no fixation)', async () => {
    const setup = await setUpOwner();
    const first = await runLogin(h, setup.passkey);
    const second = await runLogin(h, setup.passkey);
    expect(first.sessionToken).toBeTruthy();
    expect(second.sessionToken).toBeTruthy();
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(await countRows('sessions')).toBe(2);
  });
});

describe('AC2: assertions that do not verify create no session', () => {
  async function expectRefused(res: Response) {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'webauthn_failed', message: 'Passkey could not be verified' },
    });
    expect(setCookies(res)['__Host-tid_session']).toBeUndefined();
    expect(await countRows('sessions')).toBe(0);
  }

  it('wrong signature (signed with another key)', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, { assertion: { wrongKey: true } });
    await expectRefused(login.verifyRes);
  });

  it('unknown credential', async () => {
    await setUpOwner();
    const other = await runSetupElsewhere();
    const login = await runLogin(h, other);
    await expectRefused(login.verifyRes);
  });

  it('wrong origin', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, {
      assertion: { origin: 'https://evil.example' },
    });
    await expectRefused(login.verifyRes);
  });

  it('wrong RP ID', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, { assertion: { rpId: 'evil.example' } });
    await expectRefused(login.verifyRes);
  });

  it('user verification not performed', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, { assertion: { userVerified: false } });
    await expectRefused(login.verifyRes);
  });

  it('a signed challenge that is not the issued one', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, {
      assertion: { challenge: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
    await expectRefused(login.verifyRes);
  });

  it('a signature counter that went backwards (cloned authenticator)', async () => {
    const setup = await setUpOwner();
    expect(
      (await runLogin(h, setup.passkey, { assertion: { counter: 10 } })).verifyRes.status,
    ).toBe(200);
    await env.DB.exec('DELETE FROM sessions');
    const replayed = await runLogin(h, setup.passkey, { assertion: { counter: 5 } });
    await expectRefused(replayed.verifyRes);
  });

  it('no challenge cookie', async () => {
    const setup = await setUpOwner();
    const login = await runLogin(h, setup.passkey, { skipChallengeCookie: true });
    await expectRefused(login.verifyRes);
  });

  it('a challenge is single use: replaying the same verify request is refused', async () => {
    const setup = await setUpOwner();
    const options = await h.call('POST', '/api/auth/login/options', { body: {} });
    const { challenge } = (await options.json()) as { challenge: string };
    const chal = setCookies(options)['__Host-tid_chal']?.value ?? '';
    const response = await setup.passkey.assert(challenge);
    const send = () =>
      h.call('POST', '/api/auth/login/verify', {
        body: { response },
        cookies: { '__Host-tid_chal': chal },
      });
    expect((await send()).status).toBe(200);
    await env.DB.exec('DELETE FROM sessions');
    await expectRefused(await send());
  });

  it('an expired challenge is refused', async () => {
    const setup = await setUpOwner();
    const options = await h.call('POST', '/api/auth/login/options', { body: {} });
    const { challenge } = (await options.json()) as { challenge: string };
    const chal = setCookies(options)['__Host-tid_chal']?.value ?? '';
    h.clock.advance(301_000);
    const res = await h.call('POST', '/api/auth/login/verify', {
      body: { response: await setup.passkey.assert(challenge) },
      cookies: { '__Host-tid_chal': chal },
    });
    await expectRefused(res);
  });

  it('a setup challenge cannot complete a sign-in (cross-purpose)', async () => {
    const setup = await setUpOwner();
    // Make a live `setup` challenge row directly: the owner exists, so the route would refuse.
    await env.DB.prepare(
      "INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at) VALUES ('setup-chal', NULL, 'setup', 'CCCCCCCCCCCCCCCCCCCCCC', ?)",
    )
      .bind(Math.floor(h.clock.now() / 1000) + 300)
      .run();
    const res = await h.call('POST', '/api/auth/login/verify', {
      body: { response: await setup.passkey.assert('CCCCCCCCCCCCCCCCCCCCCC') },
      cookies: { '__Host-tid_chal': 'setup-chal' },
    });
    await expectRefused(res);
  });

  it('a malformed body is 400 validation_failed and creates nothing', async () => {
    await setUpOwner();
    const res = await h.call('POST', '/api/auth/login/verify', { body: { response: { id: 1 } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );
    expect(await countRows('sessions')).toBe(0);
  });
});

/** A passkey the server has never seen: a registration made against a throwaway harness. */
async function runSetupElsewhere() {
  const { fakeRegistration } = await import('./support/virtual-authenticator');
  return fakeRegistration({ challenge: 'x', rp: { id: env.RP_ID } }, { origin: env.APP_ORIGIN });
}

describe('AC10 and AC15: sign-in rate limits', () => {
  const ip = '203.0.113.50';

  async function badVerify(from: string) {
    return h.call('POST', '/api/auth/login/verify', {
      body: {
        response: {
          id: 'nope',
          rawId: 'nope',
          type: 'public-key',
          response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' },
        },
      },
      ip: from,
    });
  }

  it('10 failed sign-ins from one IP in 10 minutes block the 11th with 429 and Retry-After', async () => {
    await setUpOwner();
    for (let i = 0; i < 10; i++) expect((await badVerify(ip)).status).toBe(401);
    const blocked = await badVerify(ip);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get('Retry-After'))).toBeLessThanOrEqual(600);
    // Another IP is unaffected.
    expect((await badVerify('203.0.113.51')).status).toBe(401);
  });

  it('the window rolls over after 10 minutes', async () => {
    await setUpOwner();
    for (let i = 0; i < 11; i++) await badVerify(ip);
    expect((await badVerify(ip)).status).toBe(429);
    h.clock.advance(601_000);
    expect((await badVerify(ip)).status).toBe(401);
  });

  it('11 login/options calls from one IP: the 11th is 429 and at most 10 challenge rows exist', async () => {
    await setUpOwner();
    for (let i = 0; i < 10; i++) {
      expect((await h.call('POST', '/api/auth/login/options', { body: {}, ip })).status).toBe(200);
    }
    const blocked = await h.call('POST', '/api/auth/login/options', { body: {}, ip });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(await countRows('webauthn_challenges')).toBe(10);
  });

  it('a successful login/verify refunds only its own slot: 10 full sign-ins succeed, the 11th options is refused', async () => {
    const setup = await setUpOwner();
    for (let i = 0; i < 10; i++) {
      const login = await runLogin(h, setup.passkey, { ip });
      expect(login.optionsRes.status, `options ${i + 1}`).toBe(200);
      expect(login.verifyRes.status, `verify ${i + 1}`).toBe(200);
    }
    const eleventh = await h.call('POST', '/api/auth/login/options', { body: {}, ip });
    expect(eleventh.status).toBe(429);
  });

  it('login counters are separate from the setup and global setup counters', async () => {
    await setUpOwner();
    await h.call('POST', '/api/auth/login/options', { body: {}, ip });
    await badVerify(ip);
    const keys = (await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>())
      .results;
    expect(keys.map((k) => k.key).sort()).toEqual([
      `login:options:ip:${ip}`,
      `login:verify:ip:${ip}`,
    ]);
  });
});

describe('session cookie is not issued on failure, and the old session survives a failed sign-in', () => {
  it('a failed sign-in does not touch an existing session', async () => {
    const setup = await setUpOwner();
    const ok = await runLogin(h, setup.passkey);
    const login = await runLogin(h, setup.passkey, { assertion: { wrongKey: true } });
    expect(login.verifyRes.status).toBe(401);
    expect(await sessionRow(ok.sessionToken ?? '')).not.toBeNull();
  });
});
