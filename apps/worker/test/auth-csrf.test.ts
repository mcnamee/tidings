import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  resetAuthTables,
  runSetup,
  SETUP_TOKEN,
  setCookies,
  type Harness,
} from './support/auth-harness';
import { countRows } from './support/seed';

// TID-008 AC14 and AC15 (ADR 0011): CSRF on every Public auth route, and bounded challenge rows.
let h: Harness;
beforeEach(async () => {
  await resetAuthTables();
  h = createHarness();
});

const TABLES = [
  'users',
  'passkeys',
  'recovery_codes',
  'sessions',
  'webauthn_challenges',
  'rate_limits',
] as const;

async function snapshot() {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await countRows(t);
  return out;
}

const PUBLIC_POSTS = [
  '/api/auth/setup/options',
  '/api/auth/setup/verify',
  '/api/auth/login/options',
  '/api/auth/login/verify',
  '/api/auth/recover',
] as const;

/** A body that would be accepted if the CSRF check were missing. */
const GOOD_BODY: Record<(typeof PUBLIC_POSTS)[number], unknown> = {
  '/api/auth/setup/options': { setupToken: SETUP_TOKEN, displayName: 'Matt' },
  '/api/auth/setup/verify': {
    setupToken: SETUP_TOKEN,
    displayName: 'Matt',
    response: {
      id: 'x',
      rawId: 'x',
      type: 'public-key',
      response: { clientDataJSON: 'x', attestationObject: 'x' },
    },
  },
  '/api/auth/login/options': {},
  '/api/auth/login/verify': {
    response: {
      id: 'x',
      rawId: 'x',
      type: 'public-key',
      response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' },
    },
  },
  '/api/auth/recover': { code: 'AAAA-BBBB-CCCC-DDDD' },
};

const CASES: Array<
  [string, (path: (typeof PUBLIC_POSTS)[number]) => Parameters<Harness['call']>[2]]
> = [
  [
    'a text/plain body',
    (p) => ({ rawBody: JSON.stringify(GOOD_BODY[p]), headers: { 'Content-Type': 'text/plain' } }),
  ],
  [
    'a form-encoded body',
    (p) => ({
      rawBody: JSON.stringify(GOOD_BODY[p]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
  ],
  [
    'Origin: https://evil.example',
    (p) => ({ body: GOOD_BODY[p], headers: { Origin: 'https://evil.example' } }),
  ],
  ['no Origin and no Sec-Fetch-Site', (p) => ({ body: GOOD_BODY[p], headers: { Origin: null } })],
  [
    'no Origin and Sec-Fetch-Site: cross-site',
    (p) => ({ body: GOOD_BODY[p], headers: { Origin: null, 'Sec-Fetch-Site': 'cross-site' } }),
  ],
  [
    'no Content-Type at all',
    (p) => ({ rawBody: JSON.stringify(GOOD_BODY[p]), headers: { 'Content-Type': null } }),
  ],
];

describe('AC14: CSRF on every Public auth route', () => {
  for (const path of PUBLIC_POSTS) {
    for (const [name, build] of CASES) {
      it(`${path} with ${name} is 403 csrf_failed and creates no rows`, async () => {
        const before = await snapshot();
        const res = await h.call('POST', path, build(path));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: { code: 'csrf_failed', message: 'Request rejected' },
        });
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('the same holds once an owner exists (login routes with a real owner)', async () => {
    await runSetup(h);
    await env.DB.exec('DELETE FROM sessions');
    await env.DB.exec('DELETE FROM rate_limits');
    const before = await snapshot();
    for (const path of PUBLIC_POSTS) {
      for (const [name, build] of CASES) {
        const res = await h.call('POST', path, build(path));
        expect(res.status, `${path} ${name}`).toBe(403);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a well-formed same-origin request is not refused by the CSRF check', async () => {
    for (const path of PUBLIC_POSTS) {
      const res = await h.call('POST', path, { body: GOOD_BODY[path] });
      expect(res.status, path).not.toBe(403);
    }
  });

  it('Sec-Fetch-Site: same-origin with no Origin is accepted (older same-origin requests)', async () => {
    const res = await h.call('POST', '/api/auth/login/options', {
      body: {},
      headers: { Origin: null, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(200);
  });

  it('the CSRF check runs before the rate limit: refused requests use no slot', async () => {
    for (let i = 0; i < 15; i++) {
      await h.call('POST', '/api/auth/login/verify', {
        body: GOOD_BODY['/api/auth/login/verify'],
        headers: { Origin: 'https://evil.example' },
        ip: '203.0.113.9',
      });
    }
    expect(await countRows('rate_limits')).toBe(0);
    const ok = await h.call('POST', '/api/auth/login/options', { body: {}, ip: '203.0.113.9' });
    expect(ok.status).toBe(200);
  });

  it('GET /api/auth/session is not subject to the check', async () => {
    const res = await h.call('GET', '/api/auth/session', { headers: { Origin: null } });
    expect(res.status).toBe(200);
  });
});

describe('AC15: setup challenge rows are bounded', () => {
  const options = (displayName = 'Matt', ip?: string) =>
    h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName },
      ...(ip ? { ip } : {}),
    });

  const setupChallenges = async () =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'setup'",
      ).first<{ n: number }>()
    )?.n;

  it('the sixth unexpired setup challenge is 429 rate_limited with Retry-After and no new row', async () => {
    for (let i = 0; i < 5; i++) expect((await options()).status, `call ${i + 1}`).toBe(200);
    expect(await setupChallenges()).toBe(5);

    const refused = await options();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get('Retry-After'))).toBeLessThanOrEqual(300);
    expect(setCookies(refused)['__Host-tid_chal']).toBeUndefined();
    expect(await setupChallenges()).toBe(5);
  });

  it('only the token holder gets that far: a wrong token is 403 and the cap is never reached', async () => {
    for (let i = 0; i < 5; i++) await options();
    const res = await h.call('POST', '/api/auth/setup/options', {
      body: { setupToken: 'x'.repeat(40), displayName: 'Matt' },
    });
    expect(res.status).toBe(403);
  });

  it('expired setup challenges are deleted by the next call, which then succeeds', async () => {
    for (let i = 0; i < 5; i++) await options();
    h.clock.advance(301_000);
    const res = await options();
    expect(res.status).toBe(200);
    expect(await setupChallenges()).toBe(1);
  });

  it('only expired challenges count as free: 3 expired + 2 live leaves room for 4 more, not 5', async () => {
    for (let i = 0; i < 3; i++) await options();
    h.clock.advance(200_000);
    for (let i = 0; i < 2; i++) await options();
    h.clock.advance(101_000); // the first three are now expired, the last two are not
    for (let i = 0; i < 3; i++) expect((await options()).status, `call ${i + 1}`).toBe(200);
    expect(await setupChallenges()).toBe(5);
    expect((await options()).status).toBe(429);
  });

  it('a normal owner retrying setup a few times never sees the 429', async () => {
    for (let i = 0; i < 3; i++) expect((await options()).status).toBe(200);
    const done = await runSetup(h);
    expect(done.verifyRes.status).toBe(201);
  });

  it('login challenges neither count against the setup cap nor get deleted by it', async () => {
    for (let i = 0; i < 4; i++) await h.call('POST', '/api/auth/login/options', { body: {} });
    for (let i = 0; i < 5; i++) expect((await options()).status).toBe(200);
    h.clock.advance(301_000);
    await options();
    // The purge is for expired *setup* rows; the (also expired) login rows wait for TID-021's job.
    const login = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'login'",
    ).first<{ n: number }>();
    expect(login?.n).toBe(4);
    expect(await setupChallenges()).toBe(1);
  });
});
