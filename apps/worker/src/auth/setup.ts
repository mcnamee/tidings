import {
  PASSKEY_NAME_DEFAULT,
  PASSKEY_NAME_MAX,
  RECOVERY_CODE_COUNT,
  type User,
} from '@tidings/shared';
import { Db, newId, nowSeconds, sql, type Clock, type Statement } from '../db';
import { timingSafeEqualStrings } from './crypto';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import { buildSessionInsert } from './session';
import type { VerifiedPasskey } from './webauthn';

/** Spec 10.1: the deploy-time secret must be at least 32 characters. */
export const SETUP_TOKEN_MIN_LENGTH = 32;
export const CHALLENGE_TTL_SECONDS = 300;

export type SetupTokenCheck = 'ok' | 'invalid' | 'misconfigured';

export async function checkSetupToken(
  configured: string | undefined,
  supplied: string,
): Promise<SetupTokenCheck> {
  if (!configured || configured.length < SETUP_TOKEN_MIN_LENGTH) return 'misconfigured';
  return (await timingSafeEqualStrings(configured, supplied.trim())) ? 'ok' : 'invalid';
}

/** ADR 0010 item 6: trim, cap at 64 characters, fall back to "Passkey". Never rejects. */
export function normalizePasskeyName(raw: unknown): string {
  if (typeof raw !== 'string') return PASSKEY_NAME_DEFAULT;
  const trimmed = raw.trim();
  if (trimmed === '') return PASSKEY_NAME_DEFAULT;
  return Array.from(trimmed).slice(0, PASSKEY_NAME_MAX).join('');
}

export async function storeSetupChallenge(
  db: Db,
  input: { id: string; pendingUserId: string; challenge: string },
  clock: Clock,
): Promise<void> {
  await db.run(
    sql(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at)
       VALUES (?, ?, 'setup', ?, ?)`,
      input.id,
      input.pendingUserId,
      input.challenge,
      nowSeconds(clock) + CHALLENGE_TTL_SECONDS,
    ),
  );
}

export interface ConsumedChallenge {
  challenge: string;
  pendingUserId: string | null;
}

/**
 * Single use: the row is deleted by the same statement that reads it, so a challenge can never
 * be replayed, and an expired one is cleaned up as it is refused (AC8).
 */
export async function consumeSetupChallenge(
  db: Db,
  id: string,
  clock: Clock,
): Promise<ConsumedChallenge | null> {
  const row = await db.first<{ challenge: string; user_id: string | null; expires_at: number }>(
    sql(
      `DELETE FROM webauthn_challenges WHERE id = ? AND purpose = 'setup'
       RETURNING challenge, user_id, expires_at`,
      id,
    ),
  );
  if (!row || row.expires_at <= nowSeconds(clock)) return null;
  return { challenge: row.challenge, pendingUserId: row.user_id };
}

export interface CreatedOwner {
  user: User;
  recoveryCodes: string[];
  sessionToken: string;
}

/**
 * Creates the owner, the passkey, 10 recovery codes (hashes only) and the session in ONE batch
 * (one transaction). Every insert is guarded on "no other user exists", so two setups racing
 * with different challenges cannot both win. Returns null when another user got there first.
 */
export async function createOwner(
  db: Db,
  input: {
    userId: string;
    displayName: string;
    passkey: VerifiedPasskey;
    passkeyName: string;
    userAgent: string | null;
  },
  clock: Clock,
): Promise<CreatedOwner | null> {
  const now = nowSeconds(clock);
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(c)));
  const session = await buildSessionInsert(input.userId, 'setup', input.userAgent, clock);
  const p = input.passkey;
  const publicKey = p.publicKey.buffer.slice(
    p.publicKey.byteOffset,
    p.publicKey.byteOffset + p.publicKey.byteLength,
  ) as ArrayBuffer;

  const statements: Statement[] = [
    sql(
      `INSERT INTO users (id, display_name, role, settings_json, created_at)
       SELECT ?1, ?2, 'owner', '{}', ?3 WHERE NOT EXISTS (SELECT 1 FROM users)`,
      input.userId,
      input.displayName,
      now,
    ),
    sql(
      `INSERT INTO passkeys
         (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
      p.credentialId,
      input.userId,
      publicKey,
      p.counter,
      p.transports ? JSON.stringify(p.transports) : null,
      p.deviceType,
      p.backedUp ? 1 : 0,
      input.passkeyName,
      now,
    ),
    ...hashes.map((hash) =>
      sql(
        `INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
        newId(),
        input.userId,
        hash,
        now,
      ),
    ),
    session.statement,
  ];
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1) return null;

  return {
    user: { id: input.userId, displayName: input.displayName, role: 'owner', settings: {} },
    recoveryCodes,
    sessionToken: session.token,
  };
}
