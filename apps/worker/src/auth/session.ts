import type { SessionResponse, User } from '@tidings/shared';
import { Db, nowSeconds, sql, type Clock, type Statement } from '../db';
import { randomToken, sha256Hex } from './crypto';

/** Spec 10.2. The cookie carries a random token; only its SHA-256 is stored. */
export const SESSION_COOKIE = '__Host-tid_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS = 180 * 24 * 60 * 60;

export type AuthMethod = 'setup' | 'passkey' | 'recovery';

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
}

function parseSettings(json: string): User['settings'] {
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

/** `GET /api/auth/session`. Read-only: sliding expiry is the sign-in story's job (TID-008). */
export async function describeSession(
  db: Db,
  token: string | undefined,
  clock: Clock,
): Promise<SessionResponse> {
  if (token) {
    const now = nowSeconds(clock);
    const row = await db.first<SessionUserRow>(
      sql(
        `SELECT u.id, u.display_name, u.role, u.settings_json, s.auth_method,
                s.created_at AS session_created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ?`,
        await sha256Hex(token),
        now,
        now,
      ),
    );
    if (row) {
      let mustAddPasskey = false;
      if (row.auth_method === 'recovery') {
        // ADR 0010: one indexed read, only for recovery sessions.
        const added = await db.first<{ one: number }>(
          sql(
            'SELECT 1 AS one FROM passkeys WHERE user_id = ? AND created_at >= ? LIMIT 1',
            row.id,
            row.session_created_at,
          ),
        );
        mustAddPasskey = added === null;
      }
      return {
        user: {
          id: row.id,
          displayName: row.display_name,
          role: row.role,
          settings: parseSettings(row.settings_json),
        },
        setupRequired: false,
        mustAddPasskey,
      };
    }
  }
  return { user: null, setupRequired: !(await anyUserExists(db)), mustAddPasskey: false };
}
