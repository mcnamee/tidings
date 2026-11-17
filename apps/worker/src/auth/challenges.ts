import { Db, nowSeconds, sql, type Clock } from '../db';

/** WebAuthn challenges: single use, five minutes, bound to the `__Host-tid_chal` cookie (spec 10.1). */
export const CHALLENGE_TTL_SECONDS = 300;
/** ADR 0011 item 9 / TID-008 AC15: at most this many unexpired `setup` challenges at once. */
export const MAX_PENDING_SETUP_CHALLENGES = 5;

export type ChallengePurpose = 'setup' | 'login' | 'add_passkey';

export interface NewChallenge {
  id: string;
  /** The pending user ID for setup (the WebAuthn user handle), NULL for sign-in. */
  userId: string | null;
  challenge: string;
}

export async function storeChallenge(
  db: Db,
  purpose: ChallengePurpose,
  input: NewChallenge,
  clock: Clock,
): Promise<void> {
  await db.run(
    sql(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.id,
      input.userId,
      purpose,
      input.challenge,
      nowSeconds(clock) + CHALLENGE_TTL_SECONDS,
    ),
  );
}

export type StoreSetupChallengeResult =
  { stored: true } | { stored: false; retryAfterSeconds: number };

/**
 * Stores a `setup` challenge, in one batch (one transaction): delete the expired ones, then
 * insert only while fewer than five unexpired ones exist. The table cannot grow, whatever the
 * token holder does, and the check cannot race with itself.
 */
export async function storeSetupChallenge(
  db: Db,
  input: NewChallenge,
  clock: Clock,
): Promise<StoreSetupChallengeResult> {
  const now = nowSeconds(clock);
  const results = await db.batch([
    sql("DELETE FROM webauthn_challenges WHERE purpose = 'setup' AND expires_at <= ?", now),
    sql(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at)
       SELECT ?1, ?2, 'setup', ?3, ?4
       WHERE (SELECT COUNT(*) FROM webauthn_challenges WHERE purpose = 'setup' AND expires_at > ?5) < ?6`,
      input.id,
      input.userId,
      input.challenge,
      now + CHALLENGE_TTL_SECONDS,
      now,
      MAX_PENDING_SETUP_CHALLENGES,
    ),
  ]);
  if (results[1]?.meta.changes === 1) return { stored: true };
  const oldest = await db.first<{ expires_at: number | null }>(
    sql(
      "SELECT MIN(expires_at) AS expires_at FROM webauthn_challenges WHERE purpose = 'setup' AND expires_at > ?",
      now,
    ),
  );
  const wait = oldest?.expires_at ? oldest.expires_at - now : CHALLENGE_TTL_SECONDS;
  return { stored: false, retryAfterSeconds: Math.max(1, wait) };
}

export interface ConsumedChallenge {
  challenge: string;
  pendingUserId: string | null;
}

/**
 * Single use: the row is deleted by the same statement that reads it, so a challenge can never
 * be replayed, and an expired one is cleaned up as it is refused. The purpose is part of the
 * match, so a challenge made for one flow can never complete another.
 */
export async function consumeChallenge(
  db: Db,
  id: string,
  purpose: ChallengePurpose,
  clock: Clock,
): Promise<ConsumedChallenge | null> {
  const row = await db.first<{ challenge: string; user_id: string | null; expires_at: number }>(
    sql(
      `DELETE FROM webauthn_challenges WHERE id = ? AND purpose = ?
       RETURNING challenge, user_id, expires_at`,
      id,
      purpose,
    ),
  );
  if (!row || row.expires_at <= nowSeconds(clock)) return null;
  return { challenge: row.challenge, pendingUserId: row.user_id };
}
