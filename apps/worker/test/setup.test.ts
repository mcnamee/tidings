import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { RECOVERY_CODE_PATTERN, type SessionResponse } from '@tidings/shared';
import { sha256Hex } from '../src/auth/crypto';
import { hashRecoveryCode, normalizeRecoveryCode } from '../src/auth/recovery-codes';
import {
  SETUP_TOKEN,
  createHarness,
  resetAuthTables,
  runSetup,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { fakeRegistration } from './support/virtual-authenticator';

// TID-007: first-run setup API (spec 8.3, 10.1), against the real @simplewebauthn/server in workerd.
let h: Harness;
beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
});

const COUNT_SQL = {
  users: 'SELECT COUNT(*) AS n FROM users',
  passkeys: 'SELECT COUNT(*) AS n FROM passkeys',
  recovery_codes: 'SELECT COUNT(*) AS n FROM recovery_codes',
  sessions: 'SELECT COUNT(*) AS n FROM sessions',
  webauthn_challenges: 'SELECT COUNT(*) AS n FROM webauthn_challenges',
} as const;
const count = async (table: keyof typeof COUNT_SQL) =>
  (await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>())?.n ?? -1;

async function optionsFor(token: string, displayName = 'Matt', ip?: string) {
  return h.call('POST', '/api/auth/setup/options', {
    body: { setupToken: token, displayName },
    ...(ip ? { ip } : {}),
  });
}

describe('AC1: session reports setupRequired on a fresh instance', () => {
  it('returns {user:null, setupRequired:true} when no user exists', async () => {
    const res = await h.call('GET', '/api/auth/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, setupRequired: true, mustAddPasskey: false });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns setupRequired:false once a user exists', async () => {
    await runSetup(h);
    const res = await h.call('GET', '/api/auth/session');
    expect(((await res.json()) as SessionResponse).setupRequired).toBe(false);
  });
});

describe('AC2: setup with the right token creates the owner, a passkey, a session and 10 codes', () => {
  it('runs options then verify and returns 201 with the owner and 10 distinct codes', async () => {
    const s = await runSetup(h, { displayName: '  Matt  ' });
    expect(s.optionsRes.status).toBe(200);
    expect(s.options.rp.id).toBe(env.RP_ID);
    expect(s.verifyRes.status).toBe(201);
    expect(s.body.user).toMatchObject({ displayName: 'Matt', role: 'owner' });
    expect(s.body.recoveryCodes).toHaveLength(10);
    expect(new Set(s.body.recoveryCodes).size).toBe(10);
    for (const code of s.body.recoveryCodes) expect(code).toMatch(RECOVERY_CODE_PATTERN);

    const user = await env.DB.prepare('SELECT id, role, display_name FROM users').all();
    expect(user.results).toEqual([{ id: s.body.user.id, role: 'owner', display_name: 'Matt' }]);
    const keys = await env.DB.prepare('SELECT id, user_id, name, device_type FROM passkeys').all();
    expect(keys.results).toEqual([
      { id: s.credentialId, user_id: s.body.user.id, name: 'Passkey', device_type: 'singleDevice' },
    ]);
  });

  it('uses the WebAuthn user handle as the user id', async () => {
    const s = await runSetup(h);
    expect(s.options.user.id).toBe(btoa(s.body.user.id).replace(/=+$/, ''));
  });

  it('sets the session cookie with the spec 10.2 attributes', async () => {
    const s = await runSetup(h);
    const cookie = s.cookies['__Host-tid_session'];
    expect(cookie).toBeDefined();
    expect(cookie?.value.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(Object.keys(cookie?.attrs ?? {})).toEqual(
      expect.arrayContaining(['httponly', 'secure', 'samesite', 'path', 'max-age']),
    );
    expect(cookie?.attrs['samesite']).toBe('Lax');
    expect(cookie?.attrs['path']).toBe('/');
    expect(cookie?.attrs['max-age']).toBe(String(30 * 24 * 3600));
    expect(cookie?.attrs['domain']).toBeUndefined();
  });

  it('sets the challenge cookie as HttpOnly, Secure, SameSite=Strict, Max-Age 300', async () => {
    const res = await optionsFor(SETUP_TOKEN);
    const cookie = setCookies(res)['__Host-tid_chal'];
    expect(cookie?.attrs).toMatchObject({ samesite: 'Strict', path: '/', 'max-age': '300' });
    expect(Object.keys(cookie?.attrs ?? {})).toEqual(
      expect.arrayContaining(['httponly', 'secure']),
    );
  });

  it('requests discoverable credentials, required user verification and no attestation', async () => {
    const res = await optionsFor(SETUP_TOKEN);
    const options = (await res.json()) as Record<string, unknown>;
    expect(options['attestation']).toBe('none');
    expect(options['authenticatorSelection']).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    const algs = (options['pubKeyCredParams'] as Array<{ alg: number }>).map((p) => p.alg);
    expect(algs).toEqual([-7, -8, -257]);
  });

  it('the new session works for GET /api/auth/session', async () => {
    const s = await runSetup(h);
    const res = await h.call('GET', '/api/auth/session', {
      cookies: { '__Host-tid_session': s.cookies['__Host-tid_session']?.value ?? '' },
    });
    const body = (await res.json()) as SessionResponse;
    expect(body.user).toMatchObject({ id: s.body.user.id, role: 'owner' });
    expect(body.setupRequired).toBe(false);
    expect(body.mustAddPasskey).toBe(false);
  });

  it('refuses a passkey whose user verification flag is not set', async () => {
    const s = await runSetup(h, { authenticator: { userVerified: false } });
    expect(s.verifyRes.status).toBe(401);
    expect(await count('users')).toBe(0);
  });

  it('refuses a passkey made for another origin', async () => {
    const s = await runSetup(h, { authenticator: { origin: 'https://evil.example' } });
    expect(s.verifyRes.status).toBe(401);
    expect(await count('users')).toBe(0);
  });

  it('records a synced (backed up) passkey as multiDevice', async () => {
    await runSetup(h, { authenticator: { backedUp: true } });
    const row = await env.DB.prepare('SELECT device_type, backed_up FROM passkeys').first();
    expect(row).toEqual({ device_type: 'multiDevice', backed_up: 1 });
  });
});

describe('AC4: a wrong setup token gets 403 invalid_setup_token and creates nothing', () => {
  it('rejects setup/options', async () => {
    const res = await optionsFor('x'.repeat(40));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_setup_token',
    );
    expect(setCookies(res)['__Host-tid_chal']).toBeUndefined();
    expect(await count('webauthn_challenges')).toBe(0);
  });

  it('rejects setup/verify even with a valid challenge and passkey', async () => {
    const ok = await optionsFor(SETUP_TOKEN);
    const options = (await ok.clone().json()) as { challenge: string; rp: { id: string } };
    const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN });
    const res = await h.call('POST', '/api/auth/setup/verify', {
      body: { setupToken: 'wrong-token', displayName: 'Matt', response: reg.response },
      cookies: { '__Host-tid_chal': setCookies(ok)['__Host-tid_chal']?.value ?? '' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_setup_token',
    );
    expect(await count('users')).toBe(0);
    expect(await count('passkeys')).toBe(0);
    expect(await count('sessions')).toBe(0);
  });

  it('treats a token that is a prefix or a longer version of the real one as wrong', async () => {
    expect((await optionsFor(SETUP_TOKEN.slice(0, -1))).status).toBe(403);
    expect((await optionsFor(`${SETUP_TOKEN}x`)).status).toBe(403);
  });

  it('answers 500 config_error when SETUP_TOKEN is not configured or is too short', async () => {
    const original = env.SETUP_TOKEN;
    try {
      (env as { SETUP_TOKEN?: string }).SETUP_TOKEN = 'short';
      const res = await optionsFor('short');
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('config_error');
      delete (env as { SETUP_TOKEN?: string }).SETUP_TOKEN;
      expect((await optionsFor('')).status).toBe(400);
      expect((await optionsFor('anything')).status).toBe(500);
    } finally {
      (env as { SETUP_TOKEN?: string }).SETUP_TOKEN = original;
    }
    expect(await count('users')).toBe(0);
  });

  it('rejects malformed bodies with 400 validation_failed', async () => {
    const bad = [
      { setupToken: SETUP_TOKEN },
      { setupToken: SETUP_TOKEN, displayName: '   ' },
      { setupToken: SETUP_TOKEN, displayName: 'x'.repeat(65) },
      { setupToken: 5, displayName: 'Matt' },
    ];
    for (const body of bad) {
      const res = await h.call('POST', '/api/auth/setup/options', { body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'validation_failed',
      );
    }
    const res = await h.call('POST', '/api/auth/setup/options', { rawBody: '{nope' });
    expect(res.status).toBe(400);
  });
});

describe('AC5: setup is refused once a user exists', () => {
  it('returns 409 setup_unavailable from both endpoints, even with the right token', async () => {
    await runSetup(h);
    const options = await optionsFor(SETUP_TOKEN);
    expect(options.status).toBe(409);
    expect(((await options.json()) as { error: { code: string } }).error.code).toBe(
      'setup_unavailable',
    );
    const verify = await h.call('POST', '/api/auth/setup/verify', {
      body: {
        setupToken: SETUP_TOKEN,
        displayName: 'Second',
        response: { id: 'a', rawId: 'a', type: 'public-key', response: {} },
      },
    });
    expect(verify.status).toBe(409);
    expect(await count('users')).toBe(1);
  });

  it('a second setup started before the first finished cannot create a second user', async () => {
    // Two browsers fetch options (two challenges), then both verify.
    const a = await optionsFor(SETUP_TOKEN, 'A');
    const b = await optionsFor(SETUP_TOKEN, 'B');
    const submit = async (res: Response, name: string) => {
      const options = (await res.clone().json()) as { challenge: string; rp: { id: string } };
      const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN });
      return h.call('POST', '/api/auth/setup/verify', {
        body: { setupToken: SETUP_TOKEN, displayName: name, response: reg.response },
        cookies: { '__Host-tid_chal': setCookies(res)['__Host-tid_chal']?.value ?? '' },
      });
    };
    const [ra, rb] = await Promise.all([submit(a, 'A'), submit(b, 'B')]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect(await count('users')).toBe(1);
    expect(await count('passkeys')).toBe(1);
    expect(await count('recovery_codes')).toBe(10);
    expect(await count('sessions')).toBe(1);
  });
});

describe('AC6: setup attempts are rate limited from the D1 counter', () => {
  const ip = '203.0.113.9';

  it('refuses the 11th failed attempt from one IP with 429 and Retry-After', async () => {
    for (let i = 0; i < 10; i++) expect((await optionsFor('wrong', 'Matt', ip)).status).toBe(403);
    const res = await optionsFor('wrong', 'Matt', ip);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBe(600);
    // Even the right token is refused while limited: the check happens first.
    expect((await optionsFor(SETUP_TOKEN, 'Matt', ip)).status).toBe(429);
    // Another address is unaffected.
    expect((await optionsFor(SETUP_TOKEN, 'Matt', '203.0.113.10')).status).toBe(200);
  });

  it('Retry-After counts down and the window resets after 10 minutes', async () => {
    for (let i = 0; i < 10; i++) await optionsFor('wrong', 'Matt', ip);
    h.clock.advance(250_000);
    const limited = await optionsFor('wrong', 'Matt', ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBe(350);
    h.clock.advance(351_000);
    expect((await optionsFor('wrong', 'Matt', ip)).status).toBe(403);
  });

  it('applies to setup/verify too, and the families share one counter', async () => {
    for (let i = 0; i < 5; i++) await optionsFor('wrong', 'Matt', ip);
    for (let i = 0; i < 5; i++) {
      const res = await h.call('POST', '/api/auth/setup/verify', {
        body: { setupToken: 'wrong', displayName: 'Matt', response: {} },
        ip,
      });
      expect([400, 403]).toContain(res.status);
    }
    const res = await h.call('POST', '/api/auth/setup/verify', { body: {}, ip });
    expect(res.status).toBe(429);
  });

  it('enforces 30 failed attempts per hour across all addresses', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await optionsFor('wrong', 'Matt', `198.51.100.${i + 1}`)).status).toBe(403);
    }
    const res = await optionsFor('wrong', 'Matt', '198.51.100.200');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBe(3600);
    h.clock.advance(3601_000);
    expect((await optionsFor('wrong', 'Matt', '198.51.100.200')).status).toBe(403);
  });

  it('a successful setup does not use up attempts', async () => {
    for (let i = 0; i < 4; i++)
      expect((await optionsFor(SETUP_TOKEN, 'Matt', ip)).status).toBe(200);
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?')
      .bind(`setup:ip:${ip}`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it('a refused request does not count against the global counter', async () => {
    for (let i = 0; i < 10; i++) await optionsFor('wrong', 'Matt', ip);
    for (let i = 0; i < 5; i++) await optionsFor('wrong', 'Matt', ip); // refused, 429
    const row = await env.DB.prepare(
      "SELECT count FROM rate_limits WHERE key = 'setup:global'",
    ).first<{
      count: number;
    }>();
    expect(row?.count).toBe(10);
  });
});

describe('AC7: only hashes are stored', () => {
  it('stores SHA-256 of each normalised code and of the session token, never the plaintext', async () => {
    const s = await runSetup(h);
    const stored = (
      await env.DB.prepare('SELECT code_hash, used_at FROM recovery_codes').all<{
        code_hash: string;
        used_at: number | null;
      }>()
    ).results;
    expect(stored).toHaveLength(10);
    const expected = await Promise.all(
      s.body.recoveryCodes.map((c) => sha256Hex(c.replace(/-/g, ''))),
    );
    expect(stored.map((r) => r.code_hash).sort()).toEqual(expected.sort());
    expect(stored.every((r) => r.used_at === null)).toBe(true);

    const everything = JSON.stringify(
      (await env.DB.prepare('SELECT * FROM recovery_codes').all()).results,
    );
    for (const code of s.body.recoveryCodes) {
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(code.replace(/-/g, ''));
    }

    const token = s.cookies['__Host-tid_session']?.value ?? '';
    const sessions = (await env.DB.prepare('SELECT * FROM sessions').all<Record<string, unknown>>())
      .results;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.['id_hash']).toBe(await sha256Hex(token));
    expect(JSON.stringify(sessions)).not.toContain(token);
  });
});

describe('AC8: challenges are single use and expire after 5 minutes', () => {
  async function started() {
    const res = await optionsFor(SETUP_TOKEN);
    const options = (await res.clone().json()) as { challenge: string; rp: { id: string } };
    const reg = await fakeRegistration(options, { origin: env.APP_ORIGIN });
    const cookies = { '__Host-tid_chal': setCookies(res)['__Host-tid_chal']?.value ?? '' };
    const verify = (c: Record<string, string> | null = cookies) =>
      h.call('POST', '/api/auth/setup/verify', {
        body: { setupToken: SETUP_TOKEN, displayName: 'Matt', response: reg.response },
        ...(c ? { cookies: c } : {}),
      });
    return { verify, options, reg };
  }
  const code = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;

  it('accepts a challenge just inside 5 minutes', async () => {
    const t = await started();
    h.clock.advance(299_000);
    expect((await t.verify()).status).toBe(201);
  });

  it('refuses a challenge older than 5 minutes with 401 webauthn_failed', async () => {
    const t = await started();
    h.clock.advance(301_000);
    const res = await t.verify();
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('webauthn_failed');
    expect(await count('users')).toBe(0);
    expect(await count('webauthn_challenges')).toBe(0);
  });

  it('refuses a challenge that was already used, whether or not it verified', async () => {
    const t = await started();
    expect((await t.verify()).status).toBe(201);
    await resetAuthTables(); // setup open again; only the challenge cookie is replayed
    const replay = await t.verify();
    expect(replay.status).toBe(401);
    expect(await code(replay)).toBe('webauthn_failed');
  });

  it('burns the challenge on a failed verification (no second guess)', async () => {
    const t = await started();
    const bad = await fakeRegistration(t.options, { origin: env.APP_ORIGIN, challenge: 'AAAA' });
    const cookies = {
      '__Host-tid_chal':
        (await env.DB.prepare('SELECT id FROM webauthn_challenges').first<{ id: string }>())?.id ??
        '',
    };
    const first = await h.call('POST', '/api/auth/setup/verify', {
      body: { setupToken: SETUP_TOKEN, displayName: 'Matt', response: bad.response },
      cookies,
    });
    expect(first.status).toBe(401);
    expect(await count('webauthn_challenges')).toBe(0);
    const second = await t.verify(cookies);
    expect(second.status).toBe(401);
  });

  it('refuses a missing or unknown challenge cookie', async () => {
    const t = await started();
    expect((await t.verify(null)).status).toBe(401);
    expect((await t.verify({ '__Host-tid_chal': 'nope' })).status).toBe(401);
    expect(await count('users')).toBe(0);
  });

  it('refuses a challenge issued for another purpose', async () => {
    const t = await started();
    await env.DB.exec("UPDATE webauthn_challenges SET purpose = 'login'");
    const id =
      (await env.DB.prepare('SELECT id FROM webauthn_challenges').first<{ id: string }>())?.id ??
      '';
    expect((await t.verify({ '__Host-tid_chal': id })).status).toBe(401);
  });

  it('clears the challenge cookie on verify', async () => {
    const t = await started();
    const res = await t.verify();
    expect(setCookies(res)['__Host-tid_chal']?.attrs['max-age']).toBe('0');
  });
});

describe('AC11: passkeyName is a best-effort label', () => {
  const cases: Array<[string, unknown, string]> = [
    ['missing', undefined, 'Passkey'],
    ['empty', '', 'Passkey'],
    ['whitespace only', '   \t ', 'Passkey'],
    ['not a string', 42, 'Passkey'],
    ['an object', { a: 1 }, 'Passkey'],
    ['trimmed', '  Passkey on iPhone  ', 'Passkey on iPhone'],
    ['64 characters', 'a'.repeat(64), 'a'.repeat(64)],
    ['65 characters', 'a'.repeat(65), 'a'.repeat(64)],
    ['very long', 'b'.repeat(5000), 'b'.repeat(64)],
  ];
  it.each(cases)('setup succeeds with passkeyName %s', async (_label, value, expected) => {
    const s = await runSetup(h, { verifyBody: value === undefined ? {} : { passkeyName: value } });
    expect(s.verifyRes.status).toBe(201);
    const row = await env.DB.prepare('SELECT name FROM passkeys').first<{ name: string }>();
    expect(row?.name).toBe(expected);
  });

  it('does not split an emoji when capping', async () => {
    const s = await runSetup(h, { verifyBody: { passkeyName: '🔑'.repeat(70) } });
    expect(s.verifyRes.status).toBe(201);
    const row = await env.DB.prepare('SELECT name FROM passkeys').first<{ name: string }>();
    expect(Array.from(row?.name ?? '')).toHaveLength(64);
  });

  it('records auth_method = setup on the new session', async () => {
    await runSetup(h);
    const row = await env.DB.prepare('SELECT auth_method FROM sessions').first<{
      auth_method: string;
    }>();
    expect(row?.auth_method).toBe('setup');
  });
});

describe('AC12: recovery codes use the Crockford alphabet', () => {
  it('never contain I, L, O or U across many generated sets', async () => {
    const { generateRecoveryCodes } = await import('../src/auth/recovery-codes');
    for (let i = 0; i < 200; i++) {
      for (const code of generateRecoveryCodes()) {
        expect(code).toMatch(RECOVERY_CODE_PATTERN);
        expect(code).not.toMatch(/[ILOU]/);
      }
    }
  });

  it('the codes returned by setup contain no I, L, O or U', async () => {
    const s = await runSetup(h);
    for (const code of s.body.recoveryCodes) expect(code).not.toMatch(/[ILOU]/);
  });
});

describe('recovery code normalisation (ADR 0010 item 2)', () => {
  it('trims, strips spaces and dashes, upper-cases and maps O, I, L', () => {
    expect(normalizeRecoveryCode('  k7q2-m9xd 4trp-8wzb  ')).toBe('K7Q2M9XD4TRP8WZB');
    expect(normalizeRecoveryCode('OILo-il00-1111-ABCD')).toBe('011011001111ABCD');
  });

  it('hashes the typo and the canonical form to the same value', async () => {
    expect(await hashRecoveryCode('K7Q2-M9XD-4TRP-8WZ0')).toBe(
      await hashRecoveryCode('k7q2 m9xd 4trp 8wzo'),
    );
    expect(await hashRecoveryCode('K7Q2-M9XD-4TRP-8WZ1')).toBe(
      await hashRecoveryCode('K7Q2-M9XD-4TRP-8WZl'),
    );
    expect(await hashRecoveryCode('K7Q2-M9XD-4TRP-8WZ1')).not.toBe(
      await hashRecoveryCode('K7Q2-M9XD-4TRP-8WZ2'),
    );
  });
});

describe('responses are never cached', () => {
  it('sends Cache-Control: no-store on setup responses', async () => {
    const s = await runSetup(h);
    expect(s.optionsRes.headers.get('Cache-Control')).toBe('no-store');
    expect(s.verifyRes.headers.get('Cache-Control')).toBe('no-store');
    expect((await optionsFor('wrong')).headers.get('Cache-Control')).toBe('no-store');
  });
});
