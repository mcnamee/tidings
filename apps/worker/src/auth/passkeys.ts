import type { Passkey } from '@tidings/shared';
import { Db, nowSeconds, sql, type Clock } from '../db';
import { CHALLENGE_TTL_SECONDS } from './challenges';
import type { VerifiedPasskey } from './webauthn';

/** Credential IDs the user already has, so the authenticator refuses to register one twice. */
export async function passkeyIdsFor(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.all<{ id: string }>(
    sql('SELECT id FROM passkeys WHERE user_id = ?', userId),
  );
  return rows.map((r) => r.id);
}

/**
 * Stores the `add_passkey` challenge for a signed-in user. One per user: an earlier one (and any
 * expired one of theirs) is deleted in the same batch, so a signed-in caller cannot grow the table.
 */
export async function storeAddPasskeyChallenge(
  db: Db,
  input: { id: string; userId: string; challenge: string },
  clock: Clock,
): Promise<void> {
  const now = nowSeconds(clock);
  await db.batch([
    sql(
      "DELETE FROM webauthn_challenges WHERE purpose = 'add_passkey' AND user_id = ?",
      input.userId,
    ),
    sql(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at)
       VALUES (?, ?, 'add_passkey', ?, ?)`,
      input.id,
      input.userId,
      input.challenge,
      now + CHALLENGE_TTL_SECONDS,
    ),
  ]);
}

/** Inserts a verified passkey for the user. Returns null when the credential ID already exists. */
export async function insertPasskey(
  db: Db,
  input: { userId: string; passkey: VerifiedPasskey; name: string },
  clock: Clock,
): Promise<Passkey | null> {
  const p = input.passkey;
  const now = nowSeconds(clock);
  const publicKey = p.publicKey.buffer.slice(
    p.publicKey.byteOffset,
    p.publicKey.byteOffset + p.publicKey.byteLength,
  ) as ArrayBuffer;
  const meta = await db.run(
    sql(
      `INSERT INTO passkeys
         (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO NOTHING`,
      p.credentialId,
      input.userId,
      publicKey,
      p.counter,
      p.transports ? JSON.stringify(p.transports) : null,
      p.deviceType,
      p.backedUp ? 1 : 0,
      input.name,
      now,
    ),
  );
  if (meta.changes !== 1) return null;
  return { id: p.credentialId, name: input.name, createdAt: now, lastUsedAt: null };
}
