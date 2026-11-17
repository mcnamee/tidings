import type { User } from '@tidings/shared';
import { Db, nowSeconds, sql, type Clock } from '../db';
import { buildSessionInsert, parseSettings } from './session';
import type { StoredCredential } from './webauthn';

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: ArrayBuffer | number[];
  counter: number;
  transports: string | null;
  display_name: string;
  role: 'owner' | 'member';
  settings_json: string;
}

export interface LoginCandidate extends StoredCredential {
  user: User;
}

function parseTransports(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? (value as string[])
      : null;
  } catch {
    return null;
  }
}

/** The stored passkey for a credential ID, with its owner. One primary-key read. */
export async function findLoginCandidate(
  db: Db,
  credentialId: string,
): Promise<LoginCandidate | null> {
  const row = await db.first<PasskeyRow>(
    sql(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports,
              u.display_name, u.role, u.settings_json
       FROM passkeys p JOIN users u ON u.id = p.user_id
       WHERE p.id = ?`,
      credentialId,
    ),
  );
  if (!row) return null;
  return {
    credentialId: row.id,
    publicKey: Array.isArray(row.public_key)
      ? Uint8Array.from(row.public_key)
      : new Uint8Array(row.public_key),
    counter: row.counter,
    transports: parseTransports(row.transports),
    user: {
      id: row.user_id,
      displayName: row.display_name,
      role: row.role,
      settings: parseSettings(row.settings_json),
    },
  };
}

/**
 * Records a verified passkey sign-in: the new signature counter and `last_used_at`, and a
 * brand new session (`auth_method = 'passkey'`, never reusing an old token), in one batch.
 */
export async function completeLogin(
  db: Db,
  input: { userId: string; credentialId: string; newCounter: number; userAgent: string | null },
  clock: Clock,
): Promise<{ sessionToken: string } | null> {
  const session = await buildSessionInsert(input.userId, 'passkey', input.userAgent, clock);
  const results = await db.batch([
    sql(
      'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND user_id = ?',
      input.newCounter,
      nowSeconds(clock),
      input.credentialId,
      input.userId,
    ),
    session.statement,
  ]);
  if (results[1]?.meta.changes !== 1) return null;
  return { sessionToken: session.token };
}
