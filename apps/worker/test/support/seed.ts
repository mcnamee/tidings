import { env } from 'cloudflare:workers';
import { sha256Hex } from '../../src/auth/crypto';

/** A user straight into D1, for tests that need another user without going through setup. */
export async function seedUser(id: string, displayName = id): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role, settings_json, created_at) VALUES (?, ?, 'owner', '{}', 1760000000)",
  )
    .bind(id, displayName)
    .run();
}

export interface SessionTimes {
  /** Epoch seconds. */
  now: number;
  expiresAt?: number;
  absoluteExpiresAt?: number;
  createdAt?: number;
}

/** A session straight into D1 with exact timestamps. Returns the cookie token. */
export async function seedSession(
  userId: string,
  times: SessionTimes,
  token = `tok-${crypto.randomUUID()}`,
): Promise<string> {
  const created = times.createdAt ?? times.now;
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method)
     VALUES (?, ?, ?, ?, ?, ?, 'vitest', 'passkey')`,
  )
    .bind(
      await sha256Hex(token),
      userId,
      created,
      created,
      times.expiresAt ?? times.now + 30 * 86400,
      times.absoluteExpiresAt ?? times.now + 180 * 86400,
    )
    .run();
  return token;
}

export interface SessionRow {
  expires_at: number;
  absolute_expires_at: number;
  auth_method: string;
  user_id: string;
}

export async function sessionRow(token: string): Promise<SessionRow | null> {
  return env.DB.prepare(
    'SELECT expires_at, absolute_expires_at, auth_method, user_id FROM sessions WHERE id_hash = ?',
  )
    .bind(await sha256Hex(token))
    .first<SessionRow>();
}

const COUNT_SQL = {
  users: 'SELECT COUNT(*) AS n FROM users',
  passkeys: 'SELECT COUNT(*) AS n FROM passkeys',
  recovery_codes: 'SELECT COUNT(*) AS n FROM recovery_codes',
  sessions: 'SELECT COUNT(*) AS n FROM sessions',
  webauthn_challenges: 'SELECT COUNT(*) AS n FROM webauthn_challenges',
  rate_limits: 'SELECT COUNT(*) AS n FROM rate_limits',
  magic_links: 'SELECT COUNT(*) AS n FROM magic_links',
} as const;

export async function countRows(table: keyof typeof COUNT_SQL): Promise<number> {
  const row = await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>();
  return row?.n ?? -1;
}
