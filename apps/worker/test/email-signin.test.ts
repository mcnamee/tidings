import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '@tidings/shared';
import { sha256Hex } from '../src/auth/crypto';
import {
  buildMagicLinkMail,
  captureEnabled,
  createResendSender,
  defaultSender,
  RESEND_URL,
  type OutgoingMail,
} from '../src/auth/mail';
import { createHarness, resetAuthTables, setCookies, type Harness } from './support/auth-harness';
import { countRows, seedSession, seedUser } from './support/seed';

// TID-053 (ADR 0016): emailed one-time sign-in links, against the real Worker app in workerd with
// an injected fake sender. Addresses are fake (example.test); the real one is a wrangler secret.
const OWNER = 'owner-1';
const ADDRESS = env.MAGIC_LINK_EMAIL ?? '';
const SESSION_COOKIE = '__Host-tid_session';

let h: Harness;
let sent: OutgoingMail[];
const sendEmail = vi.fn((_env: unknown, mail: OutgoingMail) => {
  sent.push(mail);
  return Promise.resolve();
});

beforeEach(async () => {
  await resetAuthTables();
  await seedUser(OWNER, 'Matt');
  sent = [];
  sendEmail.mockClear();
  h = createHarness({ sendEmail });
});

const request = (email: unknown, ip = '198.51.100.1') =>
  h.call('POST', '/api/auth/email/request', { body: { email }, ip });
const verify = (token: unknown, ip = '198.51.100.1') =>
  h.call('POST', '/api/auth/email/verify', { body: { token }, ip });

/** Requests a link for the owner and returns the token from the captured message. */
async function issueLink(ip?: string): Promise<string> {
  const res = await request(ADDRESS, ip);
  expect(res.status).toBe(202);
  await h.settle();
  const body = sent.at(-1)?.text ?? '';
  const token = /#token=([A-Za-z0-9_-]+)/.exec(body)?.[1];
  if (!token) throw new Error('no token in the sent message');
  return token;
}

/** A link straight into D1 (for tests that need many, or an exact expiry). */
async function seedLink(token: string, userId = OWNER, createdAt = h.clock.now() / 1000) {
  await env.DB.prepare(
    'INSERT INTO magic_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, createdAt, createdAt + 900)
    .run();
}

async function sessionInfo(): Promise<SessionResponse> {
  const res = await h.call('GET', '/api/auth/session');
  return (await res.json()) as SessionResponse;
}

describe('AC1: disabled unless configured', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['RESEND_API_KEY secret missing', { RESEND_API_KEY: undefined }],
    ['RESEND_API_KEY empty', { RESEND_API_KEY: '' }],
    ['MAGIC_LINK_EMAIL secret missing', { MAGIC_LINK_EMAIL: undefined }],
    ['MAGIC_LINK_EMAIL empty', { MAGIC_LINK_EMAIL: '' }],
    ['MAGIC_LINK_EMAIL without @', { MAGIC_LINK_EMAIL: 'nobody' }],
    ['MAGIC_LINK_FROM var missing', { MAGIC_LINK_FROM: undefined }],
  ];
  for (const [name, overrides] of cases) {
    it(`${name}: emailSignIn false, both routes 404, nothing sent`, async () => {
      const off = createHarness({ sendEmail }, overrides);
      const session = (await (
        await off.call('GET', '/api/auth/session')
      ).json()) as SessionResponse;
      expect(session.emailSignIn).toBe(false);
      for (const path of ['/api/auth/email/request', '/api/auth/email/verify']) {
        const res = await off.call('POST', path, { body: { email: ADDRESS, token: 'x' } });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      }
      await off.settle();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await countRows('magic_links')).toBe(0);
    });
  }

  it('is off with no user, and off with two users', async () => {
    await resetAuthTables();
    expect((await sessionInfo()).emailSignIn).toBe(false);
    expect((await request(ADDRESS)).status).toBe(404);
    await seedUser('a');
    await seedUser('b');
    expect((await sessionInfo()).emailSignIn).toBe(false);
    expect((await request(ADDRESS)).status).toBe(404);
    expect((await verify('x')).status).toBe(404);
    await h.settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('is on when everything is present and exactly one user exists', async () => {
    expect((await sessionInfo()).emailSignIn).toBe(true);
  });
});

describe('AC2 and AC3: request a link, without enumeration', () => {
  it('any case and surrounding spaces: 202 {}, one row, one send from MAGIC_LINK_FROM to the secret', async () => {
    const res = await request(`  ${ADDRESS.toUpperCase()}  `);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    await h.settle();
    expect(await countRows('magic_links')).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({ from: env.MAGIC_LINK_FROM, to: ADDRESS });
    const row = await env.DB.prepare('SELECT user_id FROM magic_links').first<{
      user_id: string;
    }>();
    expect(row?.user_id).toBe(OWNER);
  });

  it('the response does not wait for the send (it is queued with waitUntil)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = vi.fn(() => gate);
    const slowHarness = createHarness({ sendEmail: slow });
    const res = await slowHarness.call('POST', '/api/auth/email/request', {
      body: { email: ADDRESS },
    });
    // The handler has answered while the sender is still pending.
    expect(res.status).toBe(202);
    release();
    await slowHarness.settle();
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('a wrong address gets the byte-for-byte same response, writes nothing and sends nothing', async () => {
    const hit = await request(ADDRESS, '198.51.100.2');
    const miss = await request('someone.else@example.test', '198.51.100.3');
    await h.settle();
    expect(miss.status).toBe(hit.status);
    expect(await miss.text()).toBe(await hit.text());
    const headers = (r: Response) => [...r.headers].sort();
    expect(headers(miss)).toEqual(headers(hit));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await countRows('magic_links')).toBe(1);

    await env.DB.exec('DELETE FROM magic_links');
    sendEmail.mockClear();
    await request('still.not@example.test', '198.51.100.4');
    await h.settle();
    expect(await countRows('magic_links')).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('answers before anything that depends on the match: a blocked match job cannot delay the miss or the hit', async () => {
    // The sender never resolves until released; both answers still arrive.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blocked = vi.fn(() => gate);
    const b = createHarness({ sendEmail: blocked });
    const [hit, miss] = await Promise.all([
      b.call('POST', '/api/auth/email/request', { body: { email: ADDRESS }, ip: '198.51.100.5' }),
      b.call('POST', '/api/auth/email/request', {
        body: { email: 'x@example.test' },
        ip: '198.51.100.6',
      }),
    ]);
    expect([hit.status, miss.status]).toEqual([202, 202]);
    release();
    await b.settle();
  });

  const malformed: Array<[string, { rawBody?: string; body?: unknown }]> = [
    ['not JSON', { rawBody: '{nope' }],
    ['missing email', { body: {} }],
    ['non-string email', { body: { email: 42 } }],
    ['over 254 characters', { body: { email: `${'a'.repeat(250)}@x.test` } }],
  ];
  for (const [name, init] of malformed) {
    it(`${name}: 400 validation_failed, nothing written or sent`, async () => {
      const res = await h.call('POST', '/api/auth/email/request', init);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'validation_failed',
      );
      await h.settle();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await countRows('magic_links')).toBe(0);
    });
  }
});

describe('AC4: the email', () => {
  it('builds the exact plain-text message (snapshot)', () => {
    const mail = buildMagicLinkMail({
      from: 'signin@tidings.example',
      to: 'owner@example.test',
      link: 'https://tidings.example/login/email#token=TOKEN',
      now: new Date(Date.UTC(2026, 10, 17, 9, 5, 7)),
    });
    expect(mail).toEqual({
      from: 'signin@tidings.example',
      to: 'owner@example.test',
      subject: 'Your Tidings sign-in link',
      text: [
        'Use this link to sign in to Tidings:',
        '',
        'https://tidings.example/login/email#token=TOKEN',
        '',
        'It works once and expires in 15 minutes (requested 2026-11-17 09:05 UTC).',
        '',
        "If you didn't ask for this, ignore this email. Nobody can sign in without the link.",
        '',
      ].join('\n'),
    });
  });

  it('the sent message is plain text with one URL and no token in the subject', async () => {
    const token = await issueLink();
    const { subject, text } = sent[0] ?? { subject: '', text: '' };
    expect(subject).toBe('Your Tidings sign-in link');
    expect(subject).not.toContain(token);
    expect(text.toLowerCase()).not.toContain('<html');
    expect(text).not.toMatch(/<img/i);
    expect(text.match(/https?:\/\/\S+/g)).toEqual([`${env.APP_ORIGIN}/login/email#token=${token}`]);
    expect(text).toContain('expires in 15 minutes');
    expect(text).toContain('(requested 2026-11-10 12:00 UTC)');
    expect(text).toContain(
      "If you didn't ask for this, ignore this email. Nobody can sign in without the link.",
    );
  });
});

describe('Resend sender (ADR 0016 amendment)', () => {
  const sendEnv = {
    ...env,
    RESEND_API_KEY: 're_test_key_123',
    APP_ORIGIN: 'https://tidings.mcn.am',
  };
  const mail: OutgoingMail = {
    from: 'signin@tidings.mcn.am',
    to: ADDRESS,
    subject: 'Your Tidings sign-in link',
    text: 'link: https://tidings.mcn.am/login/email#token=SECRETTOKEN',
  };
  const ok = () => Promise.resolve(new Response('{"id":"x"}', { status: 200 }));

  it('POSTs the documented JSON to api.resend.com with a bearer key and a timeout signal', async () => {
    const fetchFn = vi.fn<typeof fetch>(ok);
    await createResendSender(fetchFn)(sendEnv as unknown as typeof env, mail);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(url).toBe(RESEND_URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer re_test_key_123');
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'Tidings <signin@tidings.mcn.am>',
      to: [ADDRESS],
      subject: 'Your Tidings sign-in link',
      text: mail.text,
    });
    expect(String(body.subject)).not.toContain('SECRETTOKEN');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request that outlives the timeout', async () => {
    const hang = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(
      createResendSender(hang, 20)(sendEnv as unknown as typeof env, mail),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a non-2xx answer throws ResendError and logs only the status', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`bad ${ADDRESS} re_test_key_123`, { status: 422 })),
    );
    await expect(
      createResendSender(fetchFn)(sendEnv as unknown as typeof env, mail),
    ).rejects.toMatchObject({ name: 'ResendError' });
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('422');
    for (const secret of [ADDRESS, 're_test_key_123', 'SECRETTOKEN']) {
      expect(logged).not.toContain(secret);
    }
    err.mockRestore();
  });

  it('makes no request without a key, or for a non-matching address', async () => {
    const fetchFn = vi.fn<typeof fetch>(ok);
    await expect(
      createResendSender(fetchFn)(
        { ...sendEnv, RESEND_API_KEY: undefined } as unknown as typeof env,
        mail,
      ),
    ).rejects.toThrow();
    const real = createHarness({ sendEmail: createResendSender(fetchFn) });
    const res = await real.call('POST', '/api/auth/email/request', {
      body: { email: 'someone@example.test' },
      ip: '198.51.100.77',
    });
    expect(res.status).toBe(202);
    await real.settle();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('through the route: a matching request makes exactly one fetch, with the link in the text', async () => {
    const fetchFn = vi.fn<typeof fetch>(ok);
    const real = createHarness({ sendEmail: createResendSender(fetchFn) });
    await real.call('POST', '/api/auth/email/request', {
      body: { email: ADDRESS },
      ip: '198.51.100.78',
    });
    await real.settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toMatch(/#token=[A-Za-z0-9_-]+/);
  });
});

describe('AC5: the token', () => {
  it('is 43 base64url characters, stored only as its SHA-256, expiring in 15 minutes', async () => {
    const token = await issueLink();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = (await env.DB.prepare('SELECT * FROM magic_links').all<Record<string, unknown>>())
      .results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]?.expires_at).toBe((rows[0]?.created_at as number) + 900);
    expect(rows[0]?.used_at).toBeNull();
  });

  it('a new request deletes the earlier unused link, so one is live', async () => {
    const first = await issueLink('198.51.100.7');
    const second = await issueLink('198.51.100.8');
    expect(second).not.toBe(first);
    expect(await countRows('magic_links')).toBe(1);
    expect((await verify(first)).status).toBe(401);
    expect((await verify(second)).status).toBe(200);
  });

  it('uses crypto.getRandomValues for 32 bytes', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    await issueLink();
    const sizes = spy.mock.calls.map(([a]) => (a as Uint8Array).length);
    expect(sizes).toContain(32);
    spy.mockRestore();
  });
});

describe('AC6: GET has no effect', () => {
  it('GET on the verify path is not a route, and the token still works afterwards', async () => {
    const token = await issueLink();
    const before = await countRows('sessions');
    const res = await h.call('GET', '/api/auth/email/verify');
    expect(res.status).toBe(401); // not public for GET: the guard answers before any handler
    expect(await countRows('sessions')).toBe(before);
    const used = await env.DB.prepare('SELECT used_at FROM magic_links').first<{
      used_at: number | null;
    }>();
    expect(used?.used_at).toBeNull();
    expect((await verify(token)).status).toBe(200);
  });
});

describe('AC7: sign in', () => {
  it('returns the user, sets the session cookie, records an email session, marks the link used', async () => {
    const token = await issueLink();
    const res = await verify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { id: OWNER, displayName: 'Matt', role: 'owner' },
    });
    const cookie = setCookies(res)[SESSION_COOKIE];
    expect(cookie?.attrs).toMatchObject({
      httponly: '',
      secure: '',
      samesite: 'Lax',
      path: '/',
      'max-age': String(30 * 86400),
    });
    expect(cookie?.attrs).not.toHaveProperty('domain');
    const session = await env.DB.prepare(
      'SELECT id_hash, user_id, auth_method, created_at, authenticated_at FROM sessions',
    ).first<{
      id_hash: string;
      user_id: string;
      auth_method: string;
      created_at: number;
      authenticated_at: number;
    }>();
    expect(session).toMatchObject({
      id_hash: await sha256Hex(cookie?.value ?? ''),
      user_id: OWNER,
      auth_method: 'email',
      authenticated_at: h.clock.now() / 1000,
    });
    const link = await env.DB.prepare('SELECT used_at FROM magic_links').first<{
      used_at: number;
    }>();
    expect(link?.used_at).toBe(h.clock.now() / 1000);
    // The cookie works for an ordinary route.
    const folders = await h.call('GET', '/api/folders', {
      cookies: { [SESSION_COOKIE]: cookie?.value ?? '' },
    });
    expect(folders.status).toBe(200);
  });
});

describe('AC8: single use and expiry', () => {
  async function expectRefused(token: string) {
    const before = await countRows('sessions');
    const res = await verify(token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_link');
    expect(setCookies(res)[SESSION_COOKIE]).toBeUndefined();
    expect(await countRows('sessions')).toBe(before);
  }

  it('a used token', async () => {
    const token = await issueLink();
    expect((await verify(token)).status).toBe(200);
    await expectRefused(token);
  });

  it('an expired token (15 minutes and 1 second), but not one at 15 minutes less a second', async () => {
    const token = await issueLink();
    h.clock.advance(15 * 60 * 1000 + 1000);
    await expectRefused(token);
    const fresh = await issueLink('198.51.100.9');
    h.clock.advance(15 * 60 * 1000 - 1000);
    expect((await verify(fresh)).status).toBe(200);
  });

  it('a superseded token and a made-up one', async () => {
    const first = await issueLink('198.51.100.10');
    await issueLink('198.51.100.11');
    await expectRefused(first);
    await expectRefused('made-up-token');
  });

  it('two concurrent verifies of one token create exactly one session', async () => {
    const token = await issueLink();
    const results = await Promise.all([verify(token), verify(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await countRows('sessions')).toBe(1);
  });

  it('malformed bodies are 400', async () => {
    expect((await h.call('POST', '/api/auth/email/verify', { body: {} })).status).toBe(400);
    expect((await verify(5)).status).toBe(400);
    expect((await verify('')).status).toBe(400);
  });
});

describe('AC9: rate limits', () => {
  it('request: the 6th from one IP in 10 minutes is 429 with Retry-After, before the address is compared', async () => {
    for (let i = 0; i < 5; i++) expect((await request('x@example.test')).status).toBe(202);
    await env.DB.exec('DELETE FROM magic_links');
    const res = await request(ADDRESS);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    await h.settle();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await countRows('magic_links')).toBe(0);
    // Another IP is unaffected; the window ends after 10 minutes.
    expect((await request('x@example.test', '198.51.100.99')).status).toBe(202);
    h.clock.advance(601_000);
    expect((await request('x@example.test')).status).toBe(202);
  });

  it('request: 100 an hour from any IPs, then 429', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await request('x@example.test', `203.0.${Math.floor(i / 5)}.${i % 5}`);
      expect(res.status).toBe(202);
    }
    expect((await request('x@example.test', '192.0.2.200')).status).toBe(429);
  });

  it('send: the 11th matching request in a UTC day is 202 but sends nothing, and is logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (let i = 0; i < 11; i++) {
      expect((await request(ADDRESS, `198.51.100.${20 + i}`)).status).toBe(202);
      await h.settle();
    }
    expect(sendEmail).toHaveBeenCalledTimes(10);
    expect(log.mock.calls.flat().join('\n')).toContain('send_capped');
    // The next UTC day starts a new allowance.
    h.clock.advance(24 * 3600 * 1000);
    expect((await request(ADDRESS, '198.51.100.60')).status).toBe(202);
    await h.settle();
    expect(sendEmail).toHaveBeenCalledTimes(11);
    log.mockRestore();
  });

  it('send: non-matching requests never use a send slot', async () => {
    for (let i = 0; i < 12; i++) await request('nope@example.test', `198.51.101.${i}`);
    await h.settle();
    for (let i = 0; i < 10; i++) await request(ADDRESS, `198.51.102.${i}`);
    await h.settle();
    expect(sendEmail).toHaveBeenCalledTimes(10);
  });

  it('verify: 10 failures per IP in 10 minutes, then 429 even for a valid token (not consumed)', async () => {
    await seedLink('good-token');
    for (let i = 0; i < 10; i++) expect((await verify('bad-token')).status).toBe(401);
    const res = await verify('good-token');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    const link = await env.DB.prepare('SELECT used_at FROM magic_links').first<{
      used_at: number | null;
    }>();
    expect(link?.used_at).toBeNull();
    expect(await countRows('sessions')).toBe(0);
  });

  it('verify: 30 failures an hour across IPs, then 429', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await verify('bad-token', `203.1.${Math.floor(i / 9)}.${i % 9}`)).status).toBe(401);
    }
    expect((await verify('bad-token', '192.0.2.201')).status).toBe(429);
  });

  it('verify: a success refunds its own slots, so many sign-ins from one IP never hit the limit', async () => {
    for (let i = 0; i < 12; i++) {
      await seedLink(`token-${i}`);
      expect((await verify(`token-${i}`)).status).toBe(200);
      await env.DB.exec('DELETE FROM magic_links');
    }
  });
});

describe('AC10: CSRF', () => {
  const posts = ['/api/auth/email/request', '/api/auth/email/verify'];
  const variants: Array<[string, Record<string, string | null>]> = [
    ['cross-site Origin', { Origin: 'https://evil.example' }],
    ['no Origin and no Sec-Fetch-Site', { Origin: null }],
    ['Sec-Fetch-Site: cross-site without Origin', { Origin: null, 'Sec-Fetch-Site': 'cross-site' }],
    ['non-JSON Content-Type', { 'Content-Type': 'text/plain' }],
  ];
  for (const path of posts) {
    for (const [name, headers] of variants) {
      it(`${path}: ${name} is 403 csrf_failed and nothing is written or sent`, async () => {
        await seedLink('t');
        const res = await h.call('POST', path, { body: { email: ADDRESS, token: 't' }, headers });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf_failed');
        await h.settle();
        expect(sendEmail).not.toHaveBeenCalled();
        expect(await countRows('sessions')).toBe(0);
        expect(await countRows('magic_links')).toBe(1);
        expect(await countRows('rate_limits')).toBe(0);
      });
    }
  }
  it('Sec-Fetch-Site: same-origin without Origin is accepted', async () => {
    const res = await h.call('POST', '/api/auth/email/request', {
      body: { email: 'x@example.test' },
      headers: { Origin: null, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(202);
  });
});

describe('AC11: step-up for email sessions', () => {
  async function emailSession(): Promise<string> {
    const token = await issueLink();
    const res = await verify(token);
    return setCookies(res)[SESSION_COOKIE]?.value ?? '';
  }
  const guarded: Array<['POST' | 'DELETE', string]> = [
    ['POST', '/api/auth/passkeys/options'],
    ['POST', '/api/auth/passkeys/verify'],
    ['DELETE', '/api/auth/passkeys/some-id'],
    ['POST', '/api/auth/recovery-codes'],
  ];
  for (const [method, path] of guarded) {
    it(`${method} ${path} is 403 reauth_required for an email session, and not for a passkey session`, async () => {
      const email = await emailSession();
      const res = await h.call(method, path, { body: {}, cookies: { [SESSION_COOKIE]: email } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'reauth_required',
      );

      const passkey = await seedSession(OWNER, { now: h.clock.now() / 1000 });
      const other = await h.call(method, path, {
        body: {},
        cookies: { [SESSION_COOKIE]: passkey },
      });
      expect(other.status).not.toBe(403);
    });
  }

  it('feed routes work and renaming a passkey is not blocked', async () => {
    const email = await emailSession();
    expect(
      (await h.call('GET', '/api/folders', { cookies: { [SESSION_COOKIE]: email } })).status,
    ).toBe(200);
    expect(
      (await h.call('GET', '/api/subscriptions', { cookies: { [SESSION_COOKIE]: email } })).status,
    ).toBe(200);
    const rename = await h.call('PATCH', '/api/auth/passkeys/some-id', {
      body: { name: 'Work' },
      cookies: { [SESSION_COOKIE]: email },
    });
    expect(rename.status).not.toBe(403);
  });
});

describe('AC12: migration 0004', () => {
  it('creates magic_links, accepts auth_method email, rejects unknown, keeps sessions and the index', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('magic_links', 'sessions_user')",
    ).all<{ name: string }>();
    expect(tables.results.map((r) => r.name).sort()).toEqual(['magic_links', 'sessions_user']);
    const insert = (id: string, method: string) =>
      env.DB.prepare(
        'INSERT INTO sessions (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, auth_method) VALUES (?, ?, 1, 1, 2, 3, ?)',
      )
        .bind(id, OWNER, method)
        .run();
    await insert('a', 'email');
    await expect(insert('b', 'carrier-pigeon')).rejects.toThrow();
  });

  it('rebuilds a seeded pre-0004 database without losing sessions', async () => {
    const m4 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0004'));
    if (!m4) throw new Error('0004 migration not found');
    // Put the database back to its pre-0004 shape (0001 + 0002), with rows in it.
    await env.DB.exec('DROP TABLE magic_links');
    await env.DB.exec('DROP TABLE sessions');
    await env.DB.exec(
      "CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, user_agent TEXT, auth_method TEXT NOT NULL DEFAULT 'passkey' CHECK (auth_method IN ('setup','passkey','recovery')))",
    );
    await env.DB.exec('CREATE INDEX sessions_user ON sessions(user_id)');
    const insert = (id: string, method: string, ua: string) =>
      env.DB.prepare(
        'INSERT INTO sessions (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method) VALUES (?, ?, 10, 11, 12, 13, ?, ?)',
      )
        .bind(id, OWNER, ua, method)
        .run();
    await insert('s1', 'passkey', 'ua1');
    await insert('s2', 'recovery', 'ua2');
    await insert('s3', 'setup', null as unknown as string);

    await applyD1Migrations(env.DB, [{ name: '0004_rerun', queries: m4.queries }]);

    const rows = await env.DB.prepare('SELECT * FROM sessions ORDER BY id_hash').all<
      Record<string, unknown>
    >();
    expect(
      rows.results.map((r) => [
        r.id_hash,
        r.auth_method,
        r.created_at,
        r.authenticated_at,
        r.expires_at,
        r.absolute_expires_at,
        r.user_agent,
        r.user_id,
      ]),
    ).toEqual([
      ['s1', 'passkey', 10, 11, 12, 13, 'ua1', OWNER],
      ['s2', 'recovery', 10, 11, 12, 13, 'ua2', OWNER],
      ['s3', 'setup', 10, 11, 12, 13, null, OWNER],
    ]);
    const idx = await env.DB.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE name = 'sessions_user'",
    ).first<{ tbl_name: string }>();
    expect(idx?.tbl_name).toBe('sessions');
    await insert('s4', 'email', 'ua4');
    await expect(insert('s5', 'nope', 'ua5')).rejects.toThrow();
    expect(await countRows('magic_links')).toBe(0);
  });
});

describe('AC13: secrets stay secret, the token resolves the user server-side', () => {
  it('no log line holds the token, the link, or the address', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const failing = vi.fn(() => Promise.reject(new Error(`boom ${ADDRESS}`)));
    const bad = createHarness({ sendEmail: failing });
    await bad.call('POST', '/api/auth/email/request', {
      body: { email: ADDRESS },
      ip: '198.51.100.40',
    });
    await bad.settle();
    const token = await issueLink('198.51.100.41');
    await request('someone@example.test', '198.51.100.42');
    await h.settle();
    await verify('wrong-token-value');
    await verify(token);
    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(logged).toContain('email_link_requested');
    expect(logged).toContain('email_link_verified');
    for (const secret of [
      token,
      'wrong-token-value',
      ADDRESS,
      'someone@example.test',
      '/login/email',
    ]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });

  it('a link issued for the owner signs in the owner and nobody else', async () => {
    const token = await issueLink();
    const res = await verify(token);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(OWNER);
    const session = await env.DB.prepare('SELECT user_id FROM sessions').all<{ user_id: string }>();
    expect(session.results).toEqual([{ user_id: OWNER }]);
  });
});

describe('test-only capture mode is never active in production', () => {
  const prod = { APP_ORIGIN: 'https://tidings.mcn.am', E2E_CAPTURE_EMAIL: '1' };
  it('captureEnabled needs the var and a plain http://localhost origin', () => {
    expect(captureEnabled({ APP_ORIGIN: 'http://localhost:8788', E2E_CAPTURE_EMAIL: '1' })).toBe(
      true,
    );
    expect(captureEnabled(prod)).toBe(false);
    expect(captureEnabled({ APP_ORIGIN: 'https://localhost', E2E_CAPTURE_EMAIL: '1' })).toBe(false);
    expect(
      captureEnabled({ APP_ORIGIN: 'http://localhost.evil.example', E2E_CAPTURE_EMAIL: '1' }),
    ).toBe(false);
    expect(captureEnabled({ APP_ORIGIN: 'http://localhost:8788' })).toBe(false);
  });

  it('with the var set on a production origin, Resend is called and nothing is recorded', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await defaultSender({ ...env, ...prod } as unknown as typeof env, {
      from: 'signin@tidings.mcn.am',
      to: ADDRESS,
      subject: 'Your Tidings sign-in link',
      text: 'hi',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(RESEND_URL);
    fetchSpy.mockRestore();
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'e2e_outbox'",
    ).first();
    expect(table).toBeNull();
  });

  it('migrations never create the capture table', async () => {
    const all = env.TEST_MIGRATIONS.flatMap((m) => m.queries).join('\n');
    expect(all).not.toContain('e2e_outbox');
  });
});
