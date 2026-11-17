import { Hono, type Context } from 'hono';
import type { EmailVerifyRequest, User } from '@tidings/shared';
import { MAGIC_LINK_TTL_SECONDS } from '@tidings/shared';
import { emailRequestSchema, emailVerifyRequestSchema } from '@tidings/shared/schemas';
import type { Env } from '../../env';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { Db, nowSeconds, sql, systemClock, type Clock } from '../db';
import { setSessionCookie } from './cookies';
import { randomToken, sha256Hex, timingSafeEqualStrings } from './crypto';
import { defaultSender, buildMagicLinkMail, isSafeAddress, type EmailSender } from './mail';
import { consumeRateLimits, refundRateLimits, type RateRule } from './rate-limit';
import { parseBody } from './routes';
import { buildSessionInsert, parseSettings, SESSION_TTL_SECONDS } from './session';

/**
 * Email magic-link sign-in (TID-053, ADR 0016). Public routes under /api/auth/email, both
 * answered 404 unless the feature is configured and exactly one user exists.
 */

type Ctx = Context<AppEnv>;

export interface EmailDeps {
  clock: Clock;
  sendEmail: EmailSender;
}

/** Daily cap on emails actually sent (ADR 0016). Keyed by UTC date so the day boundary is exact. */
export const EMAIL_SEND_DAILY_LIMIT = 10;

/** The configuration items (API key, recipient, sender). The user count is checked separately (one read). */
export function emailConfigured(env: Env): boolean {
  return (
    !!env.RESEND_API_KEY &&
    isSafeAddress(env.MAGIC_LINK_EMAIL) &&
    isSafeAddress(env.MAGIC_LINK_FROM)
  );
}

/** Configured, and exactly one user. Costs one read, and none at all when unconfigured. */
export async function emailSignInEnabled(env: Env, db: Db): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const { rows } = await db.all<{ id: string }>(sql('SELECT id FROM users LIMIT 2'));
  return rows.length === 1;
}

function clientIp(c: Ctx): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

const requestRules = (c: Ctx): RateRule[] => [
  { key: `email:request:ip:${clientIp(c)}`, limit: 5, windowSeconds: 600 },
  { key: 'email:request:global', limit: 100, windowSeconds: 3600 },
];

const verifyRules = (c: Ctx): RateRule[] => [
  { key: `email:verify:ip:${clientIp(c)}`, limit: 10, windowSeconds: 600 },
  { key: 'email:verify:global', limit: 30, windowSeconds: 3600 },
];

/** Logs carry only these booleans: never the token, the link or an address (ADR 0016). */
function log(event: string, data: Record<string, boolean> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

function normalise(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Everything that depends on whether the address matched. It runs after the response (inside
 * `waitUntil`), so neither the body nor the timing of the response can reveal the match.
 */
async function issueAndSend(env: Env, deps: EmailDeps, db: Db, typed: string): Promise<void> {
  const recipient = env.MAGIC_LINK_EMAIL ?? '';
  const matched = await timingSafeEqualStrings(normalise(typed), normalise(recipient));
  log('email_link_requested', { matched });
  if (!matched) return;

  const now = nowSeconds(deps.clock);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const send = await consumeRateLimits(
    db,
    [{ key: `email:send:${day}`, limit: EMAIL_SEND_DAILY_LIMIT, windowSeconds: 86400 }],
    deps.clock,
  );
  if (!send.allowed) {
    log('send_capped');
    return;
  }

  const user = await db.first<{ id: string }>(sql('SELECT id FROM users LIMIT 1'));
  if (!user) return;
  const token = randomToken(32);
  // One live link: the owner's earlier links (used, expired or not) go in the same batch.
  await db.batch([
    sql('DELETE FROM magic_links WHERE user_id = ?', user.id),
    sql(
      'INSERT INTO magic_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      await sha256Hex(token),
      user.id,
      now,
      now + MAGIC_LINK_TTL_SECONDS,
    ),
  ]);

  const mail = buildMagicLinkMail({
    from: env.MAGIC_LINK_FROM ?? '',
    to: recipient,
    link: `${env.APP_ORIGIN}/login/email#token=${token}`,
    now: new Date(now * 1000),
  });
  await deps.sendEmail(env, mail);
}

function afterResponse(c: Ctx, work: Promise<void>): void {
  const guarded = work.catch((err: unknown) => {
    // The error text could include the address, so only its class is logged.
    console.error('email_link_failed', err instanceof Error ? err.name : 'error');
  });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (unit tests that call the app directly): the work still runs.
  }
}

export function createEmailRoutes(deps?: Partial<EmailDeps>): Hono<AppEnv> {
  const d: EmailDeps = {
    clock: deps?.clock ?? systemClock,
    sendEmail: deps?.sendEmail ?? defaultSender,
  };
  const routes = new Hono<AppEnv>();
  const notFound = (c: Ctx) => fail(c, 404, 'not_found', 'Not found');
  const rateLimited = (c: Ctx, retryAfter: number) => {
    c.header('Retry-After', String(retryAfter));
    return fail(c, 429, 'rate_limited', 'Too many attempts');
  };

  routes.post('/request', async (c) => {
    const db = new Db(c.env.DB);
    if (!(await emailSignInEnabled(c.env, db))) return notFound(c);
    // Slots first, so a 429 never depends on the address (AC9). They are never refunded.
    const limit = await consumeRateLimits(db, requestRules(c), d.clock);
    if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds);
    const body = await parseBody(c, emailRequestSchema);
    if (body instanceof Response) return body;

    // Nothing below awaits anything that depends on the match.
    afterResponse(c, issueAndSend(c.env, d, db, body.email));
    return c.json({}, 202);
  });

  routes.post('/verify', async (c) => {
    const db = new Db(c.env.DB);
    if (!(await emailSignInEnabled(c.env, db))) return notFound(c);
    const limit = await consumeRateLimits(db, verifyRules(c), d.clock);
    if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds);
    const body = await parseBody(c, emailVerifyRequestSchema);
    if (body instanceof Response) return body;
    const { token } = body satisfies EmailVerifyRequest;

    const refuse = () => {
      log('email_link_verified', { ok: false });
      return fail(c, 401, 'invalid_link', 'This link has expired or was already used');
    };
    const now = nowSeconds(d.clock);
    // The atomic single-use step: exactly one concurrent verify can win this UPDATE.
    const claimed = await db.first<{ user_id: string }>(
      sql(
        `UPDATE magic_links SET used_at = ?1
         WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
         RETURNING user_id`,
        now,
        await sha256Hex(token),
      ),
    );
    if (!claimed) return refuse();

    const row = await db.first<{
      display_name: string;
      role: 'owner' | 'member';
      settings_json: string;
    }>(sql('SELECT display_name, role, settings_json FROM users WHERE id = ?', claimed.user_id));
    if (!row) return refuse();
    const session = await buildSessionInsert(
      claimed.user_id,
      'email',
      c.req.header('User-Agent') ?? null,
      d.clock,
    );
    const inserted = await db.run(session.statement);
    if (inserted.changes !== 1) return refuse();

    setSessionCookie(c, session.token, SESSION_TTL_SECONDS);
    await refundRateLimits(db, limit.tickets);
    log('email_link_verified', { ok: true });
    const user: User = {
      id: claimed.user_id,
      displayName: row.display_name,
      role: row.role,
      settings: parseSettings(row.settings_json),
    };
    return c.json({ user });
  });

  return routes;
}
