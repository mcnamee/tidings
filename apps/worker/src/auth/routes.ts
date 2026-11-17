import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import type { ApiError, LoginVerifyResponse, SetupVerifyResponse } from '@tidings/shared';
import {
  loginOptionsRequestSchema,
  loginVerifyRequestSchema,
  setupOptionsRequestSchema,
  setupVerifyRequestSchema,
} from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { Db, newId, systemClock, type Clock } from '../db';
import {
  CHALLENGE_TTL_SECONDS,
  consumeChallenge,
  storeChallenge,
  storeSetupChallenge,
} from './challenges';
import { clearSessionCookie, setSecureCookie, setSessionCookie } from './cookies';
import { randomToken } from './crypto';
import { completeLogin, findLoginCandidate } from './login';
import { consumeRateLimits, refundRateLimits, type RateRule, type RateTicket } from './rate-limit';
import {
  anyUserExists,
  deleteSession,
  describeSession,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './session';
import { checkSetupToken, createOwner, normalizePasskeyName } from './setup';
import { defaultWebauthn, type WebauthnApi } from './webauthn';

export const CHALLENGE_COOKIE = '__Host-tid_chal';

export interface AuthDeps {
  clock: Clock;
  webauthn: WebauthnApi;
}

type Ctx = Context<AppEnv>;

function clientIp(c: Ctx): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

/** Spec 10.7 / 8.3: 10 per IP per 10 minutes, and 30 per hour overall, for the setup family. */
function setupRules(c: Ctx): RateRule[] {
  return [
    { key: `setup:ip:${clientIp(c)}`, limit: 10, windowSeconds: 600 },
    { key: 'setup:global', limit: 30, windowSeconds: 3600 },
  ];
}

/**
 * Spec 10.7: 10 per IP per 10 minutes, as two counters in the login family. They are separate
 * keys so that a full sign-in (one `options` slot that is never refunded, one `verify` slot that
 * is) fits ten times in a window: sharing one key would make the tenth sign-in's verify the 11th
 * hit.
 */
function loginRules(c: Ctx, step: 'options' | 'verify'): RateRule[] {
  return [{ key: `login:${step}:ip:${clientIp(c)}`, limit: 10, windowSeconds: 600 }];
}

function rateLimited(c: Ctx, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return fail(c, 429, 'rate_limited', 'Too many attempts');
}

export async function parseBody<T>(c: Ctx, schema: ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, 'validation_failed', 'Request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const body: ApiError = {
      error: {
        code: 'validation_failed',
        message: 'Invalid request',
        details: parsed.error.issues,
      },
    };
    return c.json(body, 400);
  }
  return parsed.data;
}

export function createAuthRoutes(deps?: Partial<AuthDeps>): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const webauthn = deps?.webauthn ?? defaultWebauthn;
  const auth = new Hono<AppEnv>();

  const relyingParty = (c: Ctx) => ({
    rpID: c.env.RP_ID,
    rpName: c.env.RP_NAME,
    origin: c.env.APP_ORIGIN,
  });

  /**
   * Public, so the SPA can ask "who am I, and is setup still open?". It still slides the session
   * (opening the app is use), and re-issues the cookie when it does.
   */
  auth.get('/session', async (c) => {
    const db = new Db(c.env.DB);
    const token = getCookie(c, SESSION_COOKIE);
    const session = await resolveSession(db, token, clock);
    if (session && token && session.renewedMaxAge !== null) {
      setSessionCookie(c, token, session.renewedMaxAge);
    }
    return c.json(await describeSession(db, session));
  });

  /**
   * Shared front half of both setup endpoints: rate limit, "is setup still open", body shape,
   * setup token. Returns the parsed body and the rate tickets, or the response to send.
   */
  async function guardSetup<T extends { setupToken: string }>(
    c: Ctx,
    db: Db,
    schema: ZodType<T>,
  ): Promise<{ body: T; tickets: RateTicket[] } | Response> {
    const limit = await consumeRateLimits(db, setupRules(c), clock);
    if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds);
    // Everything below is a failed attempt unless the handler refunds `tickets` on success.
    if (await anyUserExists(db)) {
      return fail(c, 409, 'setup_unavailable', 'Setup is not available');
    }
    const body = await parseBody(c, schema);
    if (body instanceof Response) return body;
    const token = await checkSetupToken(c.env.SETUP_TOKEN, body.setupToken);
    if (token === 'misconfigured') {
      console.error('configuration error: SETUP_TOKEN is missing or shorter than 32 characters');
      return fail(c, 500, 'config_error', 'Server configuration error');
    }
    if (token === 'invalid') return fail(c, 403, 'invalid_setup_token', 'Invalid setup token');
    return { body, tickets: limit.tickets };
  }

  auth.post('/setup/options', async (c) => {
    const db = new Db(c.env.DB);
    const guarded = await guardSetup(c, db, setupOptionsRequestSchema);
    if (guarded instanceof Response) return guarded;
    const { body, tickets } = guarded;

    const pendingUserId = newId();
    const options = await webauthn.registrationOptions({
      ...relyingParty(c),
      userId: pendingUserId,
      userName: body.displayName,
      displayName: body.displayName,
    });
    const challengeId = randomToken(32);
    // Deletes expired setup challenges and refuses at five unexpired ones (TID-008 AC15).
    const stored = await storeSetupChallenge(
      db,
      { id: challengeId, userId: pendingUserId, challenge: options.challenge },
      clock,
    );
    if (!stored.stored) return rateLimited(c, stored.retryAfterSeconds);
    setSecureCookie(c, CHALLENGE_COOKIE, challengeId, 'Strict', CHALLENGE_TTL_SECONDS);
    await refundRateLimits(db, tickets);
    return c.json(options);
  });

  auth.post('/setup/verify', async (c) => {
    const db = new Db(c.env.DB);
    const guarded = await guardSetup(c, db, setupVerifyRequestSchema);
    if (guarded instanceof Response) return guarded;
    const { body, tickets } = guarded;

    const challengeId = getCookie(c, CHALLENGE_COOKIE);
    deleteCookie(c, CHALLENGE_COOKIE, { path: '/', secure: true });
    const challenge = challengeId ? await consumeChallenge(db, challengeId, 'setup', clock) : null;
    if (!challenge) return fail(c, 401, 'webauthn_failed', 'Passkey could not be verified');

    const passkey = await webauthn.verifyRegistration(
      relyingParty(c),
      body.response,
      challenge.challenge,
    );
    if (!passkey) return fail(c, 401, 'webauthn_failed', 'Passkey could not be verified');

    const created = await createOwner(
      db,
      {
        userId: challenge.pendingUserId ?? newId(),
        displayName: body.displayName,
        passkey,
        passkeyName: normalizePasskeyName((body as { passkeyName?: unknown }).passkeyName),
        userAgent: c.req.header('User-Agent') ?? null,
      },
      clock,
    );
    if (!created) return fail(c, 409, 'setup_unavailable', 'Setup is not available');

    setSessionCookie(c, created.sessionToken, SESSION_TTL_SECONDS);
    await refundRateLimits(db, tickets);
    const response: SetupVerifyResponse = {
      user: created.user,
      recoveryCodes: created.recoveryCodes,
    };
    return c.json(response, 201);
  });

  /**
   * Sign-in step 1. Anyone can call it, so every call takes a slot from the per-IP login limit
   * and is NEVER refunded: that caps the challenge rows one IP can create (ADR 0011 item 9).
   */
  auth.post('/login/options', async (c) => {
    const db = new Db(c.env.DB);
    const limit = await consumeRateLimits(db, loginRules(c, 'options'), clock);
    if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds);
    const body = await parseBody(c, loginOptionsRequestSchema);
    if (body instanceof Response) return body;

    const options = await webauthn.authenticationOptions(relyingParty(c));
    const challengeId = randomToken(32);
    await storeChallenge(
      db,
      'login',
      { id: challengeId, userId: null, challenge: options.challenge },
      clock,
    );
    setSecureCookie(c, CHALLENGE_COOKIE, challengeId, 'Strict', CHALLENGE_TTL_SECONDS);
    return c.json(options);
  });

  /**
   * Sign-in step 2. The slot claimed on arrival is handed back only on success, and only this
   * call's own slot: the one `login/options` took stays used (spec 10.7).
   */
  auth.post('/login/verify', async (c) => {
    const db = new Db(c.env.DB);
    const limit = await consumeRateLimits(db, loginRules(c, 'verify'), clock);
    if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds);
    const body = await parseBody(c, loginVerifyRequestSchema);
    if (body instanceof Response) return body;

    const refuse = () => fail(c, 401, 'webauthn_failed', 'Passkey could not be verified');
    const challengeId = getCookie(c, CHALLENGE_COOKIE);
    deleteCookie(c, CHALLENGE_COOKIE, { path: '/', secure: true });
    const challenge = challengeId ? await consumeChallenge(db, challengeId, 'login', clock) : null;
    if (!challenge) return refuse();

    const candidate = await findLoginCandidate(db, body.response.id);
    if (!candidate) return refuse();
    const verified = await webauthn.verifyAuthentication(
      relyingParty(c),
      body.response,
      challenge.challenge,
      candidate,
    );
    if (!verified) return refuse();

    const done = await completeLogin(
      db,
      {
        userId: candidate.user.id,
        credentialId: candidate.credentialId,
        newCounter: verified.newCounter,
        userAgent: c.req.header('User-Agent') ?? null,
      },
      clock,
    );
    if (!done) return refuse();

    setSessionCookie(c, done.sessionToken, SESSION_TTL_SECONDS);
    await refundRateLimits(db, limit.tickets);
    const response: LoginVerifyResponse = { user: candidate.user };
    return c.json(response);
  });

  /** Ends this session only. The guard has already proved the session is the caller's own. */
  auth.post('/logout', async (c) => {
    const session = c.get('session');
    await deleteSession(new Db(c.env.DB), session.user.id, session.idHash);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return auth;
}
