import { Db, nowSeconds, sql, type Clock } from '../db';
import { hashRecoveryCode } from './recovery-codes';
import { buildSessionInsert, countUnusedRecoveryCodes, parseSettings } from './session';
import type { User } from '@tidings/shared';

export interface RecoveredSession {
  user: User;
  sessionToken: string;
  remaining: number;
}

/**
 * Burns one recovery code and starts a session (TID-009, spec 10.1).
 *
 * The code is always normalised and hashed first, and then goes through the same single
 * statement whether it is valid, used, unknown or malformed, so nothing before the lookup
 * depends on the code's validity. The claim is one atomic `UPDATE ... RETURNING`: of two
 * requests racing with the same code, exactly one gets a row. The session is `recovery`.
 */
export async function recoverWithCode(
  db: Db,
  input: { code: string; userAgent: string | null },
  clock: Clock,
): Promise<RecoveredSession | null> {
  const hash = await hashRecoveryCode(input.code);
  const claimed = await db.first<{ user_id: string }>(
    sql(
      `UPDATE recovery_codes SET used_at = ?1
       WHERE code_hash = ?2 AND used_at IS NULL
       RETURNING user_id`,
      nowSeconds(clock),
      hash,
    ),
  );
  if (!claimed) return null;

  const row = await db.first<{
    display_name: string;
    role: 'owner' | 'member';
    settings_json: string;
  }>(sql('SELECT display_name, role, settings_json FROM users WHERE id = ?', claimed.user_id));
  if (!row) return null;
  const session = await buildSessionInsert(claimed.user_id, 'recovery', input.userAgent, clock);
  const inserted = await db.run(session.statement);
  if (inserted.changes !== 1) return null;

  return {
    user: {
      id: claimed.user_id,
      displayName: row.display_name,
      role: row.role,
      settings: parseSettings(row.settings_json),
    },
    sessionToken: session.token,
    remaining: await countUnusedRecoveryCodes(db, claimed.user_id),
  };
}
