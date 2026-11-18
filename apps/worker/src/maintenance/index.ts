/**
 * Hourly maintenance (spec 7.6, TID-021). Every step is one self-contained, atomic statement
 * bounded to {@link CHUNK} rows, so a run is idempotent, safe next to the refresh pipeline, and
 * catches up over later runs. Retention steps share a budget of {@link MAX_STATEMENTS} statements.
 * Nothing logged contains user data, only counts.
 */
import { Db, sql, type Meta, type Statement } from '../db';
import { Meter } from '../refresh/store';

export const CHUNK = 500;
export const MAX_STATEMENTS = 10;
/** Dead feeds picked per run; each is emptied in chunks before the feed row goes. */
export const DEAD_FEED_BATCH = 20;
/** The 03:17 UTC run does the daily sweep and the daily report. */
export const DAILY_HOUR_UTC = 3;

const DAY = 86_400;
export const READ_RETENTION_S = 30 * DAY;
export const UNREAD_RETENTION_S = 90 * DAY;
export const TOMBSTONE_RETENTION_S = 180 * DAY;
export const DEAD_FEED_AFTER_S = 7 * DAY;
/** Longest rate-limit window in use (86,400 s: the daily email-send cap, DEF-110). Older rows reset on the next hit. */
export const RATE_LIMIT_MAX_WINDOW_S = 86_400;

export interface MaintenanceSummary {
  readDeleted: number;
  unreadDeleted: number;
  entriesPurged: number;
  tombstonesDeleted: number;
  deadFeedsDeleted: number;
  deadFeedEntriesDeleted: number;
  sessionsDeleted: number;
  challengesDeleted: number;
  rateLimitsDeleted: number;
  magicLinksDeleted: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  errors: number;
}

export interface MaintenanceDeps {
  db: Db;
  /** Milliseconds, like `Date.now`. */
  clock: () => number;
  log?: (line: string) => void;
}

/** `DELETE … WHERE <key> IN (SELECT <key> … LIMIT 500)`; D1 has no `DELETE … LIMIT`. */
const chunked = (table: string, key: string, where: string) =>
  `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ${CHUNK})`;

const DEAD_FEED_WHERE =
  'COALESCE(f.last_attempt_at, f.created_at) < ? ' +
  'AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id)';

export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceSummary> {
  const { db } = deps;
  const now = Math.floor(deps.clock() / 1000);
  const meter = new Meter();
  const s: MaintenanceSummary = {
    readDeleted: 0,
    unreadDeleted: 0,
    entriesPurged: 0,
    tombstonesDeleted: 0,
    deadFeedsDeleted: 0,
    deadFeedEntriesDeleted: 0,
    sessionsDeleted: 0,
    challengesDeleted: 0,
    rateLimitsDeleted: 0,
    magicLinksDeleted: 0,
    statements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    errors: 0,
  };
  let budget = MAX_STATEMENTS;
  const isDailyRun = new Date(now * 1000).getUTCHours() === DAILY_HOUR_UTC;
  let sizeAfter: number | null = null;

  const exec = async (stmt: Statement): Promise<Meta> => {
    const meta = await db.run(stmt);
    meter.add(meta);
    if (typeof meta.size_after === 'number') sizeAfter = meta.size_after;
    return meta;
  };

  /**
   * Runs `stmt` until a chunk comes back short or the shared budget is spent. With `collect`, the
   * statement ends in `RETURNING entry_id` and the ids are gathered for the targeted purge.
   */
  const drain = async (stmt: Statement, collect?: number[]): Promise<number> => {
    let total = 0;
    while (budget > 0) {
      budget -= 1;
      let changes: number;
      if (collect) {
        const { rows, meta } = await db.all<{ entry_id: number }>(stmt);
        meter.add(meta);
        for (const r of rows) collect.push(r.entry_id);
        changes = rows.length;
      } else {
        changes = (await exec(stmt)).changes;
      }
      total += changes;
      if (changes < CHUNK) break;
    }
    return total;
  };

  /** One failed step must not stop the others (a retry comes next hour). */
  const step = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      s.errors += 1;
    }
  };

  // Housekeeping: tiny tables, one bounded statement each, outside the retention budget.
  const once = async (stmt: Statement): Promise<number> => (await exec(stmt)).changes;
  await step(async () => {
    s.sessionsDeleted = await once(
      sql(chunked('sessions', 'id_hash', 'expires_at < ? OR absolute_expires_at < ?'), now, now),
    );
  });
  await step(async () => {
    s.challengesDeleted = await once(
      sql(chunked('webauthn_challenges', 'id', 'expires_at < ?'), now),
    );
  });
  await step(async () => {
    s.rateLimitsDeleted = await once(
      sql(chunked('rate_limits', 'key', 'window_start < ?'), now - RATE_LIMIT_MAX_WINDOW_S),
    );
  });
  await step(async () => {
    s.magicLinksDeleted = await once(
      sql(chunked('magic_links', 'token_hash', 'expires_at < ? OR used_at IS NOT NULL'), now),
    );
  });

  const released: number[] = []; // entries that just lost a user_entries row

  // 1. Read, unstarred, older than 30 days (partial index ue_read_old).
  await step(async () => {
    s.readDeleted = await drain(
      sql(
        `DELETE FROM user_entries WHERE (user_id, entry_id) IN (
           SELECT user_id, entry_id FROM user_entries INDEXED BY ue_read_old
            WHERE is_read = 1 AND is_starred = 0 AND published_at < ? LIMIT ${CHUNK})
         RETURNING entry_id`,
        now - READ_RETENTION_S,
      ),
      released,
    );
  });

  // 2. Unread, unstarred, older than 90 days (partial index ue_unread_all, probed per user).
  await step(async () => {
    s.unreadDeleted = await drain(
      sql(
        `DELETE FROM user_entries WHERE (user_id, entry_id) IN (
           SELECT user_id, entry_id FROM user_entries INDEXED BY ue_unread_all
            WHERE user_id IN (SELECT id FROM users)
              AND is_read = 0 AND is_starred = 0 AND published_at < ? LIMIT ${CHUNK})
         RETURNING entry_id`,
        now - UNREAD_RETENTION_S,
      ),
      released,
    );
  });

  // 3. Purge content of entries older than 30 days that no user references. Each statement
  //    re-checks "unreferenced" itself, so an entry a refresh links meanwhile is not purged.
  //    a) Targeted: the entries that just lost a reference (reads proportional to deletions).
  //    b) Window: the oldest CHUNK candidates, so orphans are found in small databases at once.
  //    c) Daily sweep (03:17 UTC run): every candidate, for orphans past the window (unsubscribed
  //       feeds, items never linked). Scanning all of them hourly would cost two rows read per
  //       old-but-referenced entry per hour.
  const PURGE = 'UPDATE entries SET content_html = NULL, summary = NULL, purged_at = ?';
  const UNREFERENCED = 'NOT EXISTS (SELECT 1 FROM user_entries u WHERE u.entry_id = c.id)';
  const purgeIds = (ids: number[]) =>
    sql(
      `${PURGE} WHERE id IN (
         SELECT c.id FROM entries c
          WHERE c.id IN (SELECT value FROM json_each(?)) AND c.purged_at IS NULL
            AND c.published_at < ? AND ${UNREFERENCED})`,
      now,
      JSON.stringify(ids),
      now - READ_RETENTION_S,
    );
  const purgeWindow = sql(
    `${PURGE} WHERE id IN (
       SELECT c.id FROM (SELECT id FROM entries INDEXED BY entries_published
                          WHERE purged_at IS NULL AND published_at < ?
                          ORDER BY published_at, id LIMIT ${CHUNK}) c
        WHERE ${UNREFERENCED})`,
    now,
    now - READ_RETENTION_S,
  );
  await step(async () => {
    const ids = [...new Set(released)];
    for (let i = 0; i < ids.length && budget > 0; i += CHUNK) {
      budget -= 1;
      s.entriesPurged += (await exec(purgeIds(ids.slice(i, i + CHUNK)))).changes;
    }
    if (budget > 0) {
      budget -= 1;
      s.entriesPurged += (await exec(purgeWindow)).changes;
    }
    if (isDailyRun) {
      s.entriesPurged += await drain(
        sql(
          `UPDATE entries SET content_html = NULL, summary = NULL, purged_at = ?
            WHERE id IN (
              SELECT e.id FROM entries e INDEXED BY entries_published
               WHERE e.purged_at IS NULL AND e.published_at < ?
                 AND NOT EXISTS (SELECT 1 FROM user_entries u WHERE u.entry_id = e.id)
               LIMIT ${CHUNK})`,
          now,
          now - READ_RETENTION_S,
        ),
      );
    }
  });

  // 4. Tombstones are kept 180 days from the purge (spec 6.3).
  await step(async () => {
    s.tombstonesDeleted = await drain(
      sql(
        `DELETE FROM entries WHERE id IN (
           SELECT id FROM entries INDEXED BY entries_tombstones
            WHERE purged_at IS NOT NULL AND purged_at < ? LIMIT ${CHUNK})`,
        now - TOMBSTONE_RETENTION_S,
      ),
    );
  });

  // 5. Feeds nobody subscribes to, last attempted over 7 days ago: empty them in chunks, then
  //    delete the rows that are empty. Both statements re-check "no subscriptions".
  await step(async () => {
    if (budget === 0) return;
    const cutoff = now - DEAD_FEED_AFTER_S;
    const { rows, meta } = await db.all<{ id: number }>(
      sql(`SELECT f.id FROM feeds f WHERE ${DEAD_FEED_WHERE} LIMIT ${DEAD_FEED_BATCH}`, cutoff),
    );
    meter.add(meta);
    if (rows.length === 0) return;
    const ids = JSON.stringify(rows.map((r) => r.id));
    s.deadFeedEntriesDeleted = await drain(
      sql(
        `DELETE FROM entries WHERE id IN (
           SELECT e.id FROM entries e JOIN feeds f ON f.id = e.feed_id
            WHERE e.feed_id IN (SELECT value FROM json_each(?)) AND ${DEAD_FEED_WHERE}
            LIMIT ${CHUNK})`,
        ids,
        cutoff,
      ),
    );
    if (budget === 0) return;
    budget -= 1;
    s.deadFeedsDeleted = (
      await exec(
        sql(
          `DELETE FROM feeds WHERE id IN (
             SELECT f.id FROM feeds f
              WHERE f.id IN (SELECT value FROM json_each(?)) AND ${DEAD_FEED_WHERE}
                AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.feed_id = f.id))`,
          ids,
          cutoff,
        ),
      )
    ).changes;
  });

  s.statements = meter.statements;
  s.rowsRead = meter.rowsRead;
  s.rowsWritten = meter.rowsWritten;

  const line: Record<string, unknown> = { event: 'maintenance', ...s };

  // 7. Daily report on the 03:17 UTC run. D1 reports its size on every result, so this costs one
  //    indexed count (entries published in the previous UTC day), not a table scan.
  if (isDailyRun) {
    try {
      const dayStart = now - (now % DAY);
      const { rows, meta } = await db.all<{ n: number }>(
        sql(
          `SELECT COUNT(*) AS n FROM entries INDEXED BY entries_published
            WHERE purged_at IS NULL AND published_at >= ? AND published_at < ?`,
          dayStart - DAY,
          dayStart,
        ),
      );
      meter.add(meta);
      if (typeof meta.size_after === 'number') sizeAfter = meta.size_after;
      line.daily = { dbSizeBytes: sizeAfter, entriesPublishedYesterday: rows[0]?.n ?? 0 };
    } catch {
      s.errors += 1;
      line.errors = s.errors;
    }
  }

  (deps.log ?? console.log)(JSON.stringify(line));
  return s;
}
