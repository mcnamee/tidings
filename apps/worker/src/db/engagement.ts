/**
 * The owner's engagement signals (TID-066, ADR 0018). One row per user x entry, so a repeat signal
 * writes nothing. Points are derived: opened 1, clicked 2, each kind counted once. The row copies the
 * entry's title, feed, url and url key at write time and has no foreign key to `entries`, so it
 * outlives the content purge and the tombstone. TID-067: it also copies the entry's embedding (when it
 * has one yet), so the interest profile survives the purge too. Every statement puts `user_id = ?` in its SQL.
 */
import type { EngagementKind } from '@tidings/shared';
import { Db, sql, type Meta } from './client';

export const POINTS: Readonly<Record<EngagementKind, number>> = { open: 1, click: 2 };

const COLUMN: Readonly<Record<EngagementKind, 'opened_at' | 'clicked_at'>> = {
  open: 'opened_at',
  click: 'clicked_at',
};

export interface EngagementResult {
  /** True when this call stored a signal; false when that kind was already recorded. */
  recorded: boolean;
  meta: Meta;
}

/**
 * Records one signal for an entry the user has. Returns null when the user has no such entry
 * (unknown, or another user's). The first signal inserts the row (1 row written); the other kind
 * later updates it (1 row written); a repeat of a recorded kind changes nothing and writes nothing.
 */
export async function recordEngagement(
  db: Db,
  userId: string,
  entryId: number,
  kind: EngagementKind,
  nowSeconds: number,
): Promise<EngagementResult | null> {
  const col = COLUMN[kind];
  const meta = await db.run(
    sql(
      `INSERT INTO engagement (user_id, entry_id, feed_id, title, url, url_key, ${col}, last_at,
                               embedding)
       SELECT ue.user_id, ue.entry_id, ue.feed_id, e.title, e.url, e.url_key, ?, ?,
              (SELECT ee.vec FROM entry_embeddings ee WHERE ee.entry_id = ue.entry_id)
         FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
        WHERE ue.user_id = ? AND ue.entry_id = ?
       ON CONFLICT (user_id, entry_id) DO UPDATE
          SET ${col} = excluded.${col}, last_at = excluded.last_at,
              embedding = COALESCE(engagement.embedding, excluded.embedding)
        WHERE engagement.${col} IS NULL`,
      nowSeconds,
      nowSeconds,
      userId,
      entryId,
    ),
  );
  if (meta.changes > 0) return { recorded: true, meta };
  // Nothing written: either already recorded, or the user has no such entry.
  const known = await db.first<{ one: number }>(
    sql(
      'SELECT 1 AS one FROM engagement WHERE user_id = ? AND entry_id = ? ' +
        'UNION ALL SELECT 1 FROM user_entries WHERE user_id = ? AND entry_id = ? LIMIT 1',
      userId,
      entryId,
      userId,
      entryId,
    ),
  );
  return known ? { recorded: false, meta } : null;
}
