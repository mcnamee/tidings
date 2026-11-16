import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import {
  setupOptionsRequestSchema,
  setupVerifyRequestSchema,
  type ApiError,
  type ErrorCode,
  type SetupVerifyResponse,
} from '@tidings/shared';
import type { Env } from '../../env';
import { Db, newId, systemClock, type Clock } from '../db';
import { randomToken } from './crypto';
import { consumeRateLimits, refundRateLimits, type RateRule, type RateTicket } from './rate-limit';
import { describeSession, anyUserExists, SESSION_COOKIE, SESSION_TTL_SECONDS } from './session';
import {
  CHALLENGE_TTL_SECONDS,
  checkSetupToken,
  consumeSetupChallenge,
  createOwner,
  normalizePasskeyName,
  storeSetupChallenge,
} from './setup';
import { defaultWebauthn, type WebauthnApi } from './webauthn';

export const CHALLENGE_COOKIE = '__Host-tid_chal';

export interface AuthDeps {
  clock: Clock;
  webauthn: WebauthnApi;
}

type Ctx = Context<{ Bindings: Env }>;

function fail(c: Ctx, status: 400 | 401 | 403 | 409 | 429 | 500, code: ErrorCode, message: string) {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

/** Spec 10.7 / 8.3: 10 per IP per 10 minutes, and 30 per hour overall, for the setup family. */
function setupRules(c: Ctx): RateRule[] {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  return [
    { key: `setup:ip:${ip}`, limit: 10, windowSeconds: 600 },
    { key: 'setup:global', limit: 30, windowSeconds: 3600 },
  ];
}

async function parseBody<T>(c: Ctx, schema: ZodType<T>): Promise<T | Response> {
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

function setSecureCookie(
  c: Ctx,
  name: string,
  value: string,
  sameSite: 'Lax' | 'Strict',
  maxAge: number,
): void {
  setCookie(c, name, value, { httpOnly: true, secure: true, sameSite, path: '/', maxAge });
}

export function createAuthRoutes(deps?: Partial<AuthDeps>): Hono<{ Bindings: Env }> {
  const clock = deps?.clock ?? systemClock;
  const webauthn = deps?.webauthn ?? defaultWebauthn;
  const auth = new Hono<{ Bindings: Env }>();

  auth.get('/session', async (c) => {
    return c.json(await describeSession(new Db(c.env.DB), getCookie(c, SESSION_COOKIE), clock));
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
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      return fail(c, 429, 'rate_limited', 'Too many attempts');
    }
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
      rpID: c.env.RP_ID,
      rpName: c.env.RP_NAME,
      origin: c.env.APP_ORIGIN,
      userId: pendingUserId,
      userName: body.displayName,
      displayName: body.displayName,
    });
    const challengeId = randomToken(32);
    await storeSetupChallenge(
      db,
      { id: challengeId, pendingUserId, challenge: options.challenge },
      clock,
    );
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
    const challenge = challengeId ? await consumeSetupChallenge(db, challengeId, clock) : null;
    if (!challenge) return fail(c, 401, 'webauthn_failed', 'Passkey could not be verified');

    const passkey = await webauthn.verifyRegistration(
      { rpID: c.env.RP_ID, rpName: c.env.RP_NAME, origin: c.env.APP_ORIGIN },
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

    setSecureCookie(c, SESSION_COOKIE, created.sessionToken, 'Lax', SESSION_TTL_SECONDS);
    await refundRateLimits(db, tickets);
    const response: SetupVerifyResponse = {
      user: created.user,
      recoveryCodes: created.recoveryCodes,
    };
    return c.json(response, 201);
  });

  return auth;
}
