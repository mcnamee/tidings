import type { SessionResponse, User } from '@tidings/shared';
import { Db, nowSeconds, sql, type Clock, type Statement } from '../db';
import { randomToken, sha256Hex } from './crypto';

/** Spec 10.2. The cookie carries a random token; only its SHA-256 is stored. */
export const SESSION_COOKIE = '__Host-tid_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS = 180 * 24 * 60 * 60;
/** Spec 10.2: `expires_at` is pushed out only when fewer than this many seconds remain (about one write a week). */
export const SESSION_RENEW_BELOW_SECONDS = 23 * 24 * 60 * 60;

export type AuthMethod = 'setup' | 'passkey' | 'recovery' | 'email';

export interface NewSession {
  token: string;
  /** The statement that stores it; the caller runs it in its own batch. */
  statement: Statement;
}

export async function buildSessionInsert(
  userId: string,
  method: AuthMethod,
  userAgent: string | null,
  clock: Clock,
): Promise<NewSession> {
  const token = randomToken(32);
  const now = nowSeconds(clock);
  const statement = sql(
    `INSERT INTO sessions
       (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method)
     SELECT ?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
    await sha256Hex(token),
    userId,
    now,
    now + SESSION_TTL_SECONDS,
    now + SESSION_ABSOLUTE_TTL_SECONDS,
    userAgent ? userAgent.slice(0, 256) : null,
    method,
  );
  return { token, statement };
}

interface SessionUserRow {
  id: string;
  display_name: string;
  role: 'owner' | 'member';
  settings_json: string;
  auth_method: AuthMethod;
  session_created_at: number;
  expires_at: number;
  absolute_expires_at: number;
}

export function parseSettings(json: string): User['settings'] {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as User['settings'])
      : {};
  } catch {
    return {};
  }
}

export async function anyUserExists(db: Db): Promise<boolean> {
  return (await db.first<{ one: number }>(sql('SELECT 1 AS one FROM users LIMIT 1'))) !== null;
}

export interface ResolvedSession {
  user: User;
  authMethod: AuthMethod;
  sessionCreatedAt: number;
  idHash: string;
  /**
   * Set when this request pushed `expires_at` out: the new cookie lifetime in seconds. The
   * caller re-issues the cookie with it so the browser's copy slides with the row.
   */
  renewedMaxAge: number | null;
}

/**
 * Looks up a session by its cookie token (one primary-key read joined to the user) and applies
 * sliding expiry (spec 10.2, TID-008 AC3). A session past `expires_at` or `absolute_expires_at`
 * is simply not found. Writes at most one row, and only when fewer than 23 days remain.
 */
export async function resolveSession(
  db: Db,
  token: string | undefined,
  clock: Clock,
): Promise<ResolvedSession | null> {
  // Tokens are 43 base64url characters; anything much longer cannot match, so skip the hash and read.
  if (!token || token.length > 256) return null;
  const now = nowSeconds(clock);
  const idHash = await sha256Hex(token);
  const row = await db.first<SessionUserRow>(
    sql(
      `SELECT u.id, u.display_name, u.role, u.settings_json, s.auth_method,
              s.created_at AS session_created_at, s.expires_at, s.absolute_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ?`,
      idHash,
      now,
      now,
    ),
  );
  if (!row) return null;

  let renewedMaxAge: number | null = null;
  if (row.expires_at - now < SESSION_RENEW_BELOW_SECONDS) {
    const next = Math.min(now + SESSION_TTL_SECONDS, row.absolute_expires_at);
    // The guard makes a burst of parallel requests write once, not once each.
    const meta = await db.run(
      sql(
        'UPDATE sessions SET expires_at = ? WHERE id_hash = ? AND expires_at < ?',
        next,
        idHash,
        next,
      ),
    );
    if (meta.changes > 0) renewedMaxAge = next - now;
  }
  return {
    user: {
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      settings: parseSettings(row.settings_json),
    },
    authMethod: row.auth_method,
    sessionCreatedAt: row.session_created_at,
    idHash,
    renewedMaxAge,
  };
}

/** Deletes one session (sign out). Scoped by the user as well, so it can only ever be your own. */
export async function deleteSession(db: Db, userId: string, idHash: string): Promise<void> {
  await db.run(sql('DELETE FROM sessions WHERE id_hash = ? AND user_id = ?', idHash, userId));
}

/** Unused recovery codes (indexed by `recovery_codes_user`). */
export async function countUnusedRecoveryCodes(db: Db, userId: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    sql('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId),
  );
  return row?.n ?? 0;
}

/** `GET /api/auth/session` for an already resolved (or absent) session. */
export async function describeSession(
  db: Db,
  session: ResolvedSession | null,
  emailSignIn = false,
): Promise<SessionResponse> {
  if (session) {
    if (session.authMethod === 'recovery') {
      // ADR 0010: two indexed reads (no writes), only for recovery sessions.
      const added = await db.first<{ one: number }>(
        sql(
          'SELECT 1 AS one FROM passkeys WHERE user_id = ? AND created_at >= ? LIMIT 1',
          session.user.id,
          session.sessionCreatedAt,
        ),
      );
      return {
        user: session.user,
        setupRequired: false,
        mustAddPasskey: added === null,
        recoveryCodesRemaining: await countUnusedRecoveryCodes(db, session.user.id),
        emailSignIn,
      };
    }
    return { user: session.user, setupRequired: false, mustAddPasskey: false, emailSignIn };
  }
  return {
    user: null,
    setupRequired: !(await anyUserExists(db)),
    mustAddPasskey: false,
    emailSignIn,
  };
}
