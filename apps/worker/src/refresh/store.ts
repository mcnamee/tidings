/**
 * D1 reads and writes for the refresh pipeline. Every statement is parameterised, and every
 * result's `meta` feeds a {@link Meter} so callers can report rows read and written (NFR-7).
 */
import type { FeedErrorCode } from '@tidings/shared';
import { Db, sql, type Meta } from '../db';
import { planFailure, PARKED_AT, type FailurePlan } from './backoff';
import type { D1Usage, FeedState, RefreshJob } from './types';

export class Meter {
  rowsRead = 0;
  rowsWritten = 0;
  statements = 0;

  add(meta: Meta | D1Meta | undefined): void {
    this.statements += 1;
    if (!meta) return;
    this.rowsRead += Number(meta.rows_read ?? 0);
    this.rowsWritten += Number(meta.rows_written ?? 0);
  }

  usage(): D1Usage {
    return {
      rowsRead: this.rowsRead,
      rowsWritten: this.rowsWritten,
      statements: this.statements,
    };
  }
}

interface LeaseRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
  body_hash: string | null;
  error_count: number;
  state: FeedState;
  fetch_interval_s: number;
  last_success_at: number | null;
}

/**
 * Spec §7.1: one statement moves `next_fetch_at` forward for the oldest-due feeds, so overlapping
 * ticks can never lease the same feed. `gone` feeds are never leased; unsubscribed feeds sit at
 * {@link PARKED_AT} and are not due.
 */
export async function leaseDueFeeds(
  db: Db,
  now: number,
  batchSize: number,
  meter: Meter,
): Promise<RefreshJob[]> {
  const { rows, meta } = await db.all<LeaseRow>(
    sql(
      `UPDATE feeds
          SET next_fetch_at = ? + fetch_interval_s,
              last_attempt_at = ?
        WHERE id IN (SELECT id FROM feeds
                      WHERE next_fetch_at <= ? AND state != 'gone'
                      ORDER BY next_fetch_at
                      LIMIT ?)
    RETURNING id, url, etag, last_modified, body_hash, error_count, state,
              fetch_interval_s, last_success_at`,
      now,
      now,
      now,
      batchSize,
    ),
  );
  meter.add(meta);
  return rows
    .map((r) => ({
      feedId: r.id,
      url: r.url,
      etag: r.etag,
      lastModified: r.last_modified,
      bodyHash: r.body_hash,
      errorCount: r.error_count,
      state: r.state,
      fetchIntervalS: r.fetch_interval_s,
      lastSuccessAt: r.last_success_at,
    }))
    .sort((a, b) => a.feedId - b.feedId);
}

export async function hasSubscribers(db: Db, feedId: number, meter: Meter): Promise<boolean> {
  const { rows, meta } = await db.all<{ n: number }>(
    sql('SELECT 1 AS n FROM subscriptions WHERE feed_id = ? LIMIT 1', feedId),
  );
  meter.add(meta);
  return rows.length > 0;
}

/** Parks an unsubscribed feed. Guarded so a subscription added meanwhile is not undone. */
export async function parkFeed(db: Db, feedId: number, meter: Meter): Promise<void> {
  meter.add(
    await db.run(
      sql(
        `UPDATE feeds SET next_fetch_at = ?
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE feed_id = ?)`,
        PARKED_AT,
        feedId,
        feedId,
      ),
    ),
  );
}

export interface Failure {
  code: FeedErrorCode;
  /** Numeric HTTP status, the only origin-controlled value we keep. */
  status: number | null;
  retryAfterS: number | null;
}

/** Applies `planFailure` to the feed row (`error_count`, `state`, error code, `next_fetch_at`). */
export async function recordFailure(
  db: Db,
  job: Pick<RefreshJob, 'feedId' | 'errorCount' | 'fetchIntervalS'>,
  failure: Failure,
  now: number,
  random: () => number,
  meter: Meter,
): Promise<FailurePlan> {
  const plan = planFailure({
    errorCount: job.errorCount,
    fetchIntervalS: job.fetchIntervalS,
    now,
    retryAfterS: failure.retryAfterS,
    random,
  });
  meter.add(
    await db.run(
      sql(
        `UPDATE feeds
            SET error_count = ?, state = ?, last_error_code = ?, last_status = ?, next_fetch_at = ?
          WHERE id = ?`,
        plan.errorCount,
        plan.state,
        failure.code,
        failure.status,
        plan.nextFetchAt,
        job.feedId,
      ),
    ),
  );
  return plan;
}

/** 410 Gone: never fetched again (lease skips `gone`; parked as well for safety). */
export async function markGone(
  db: Db,
  job: Pick<RefreshJob, 'feedId' | 'errorCount'>,
  code: FeedErrorCode,
  status: number,
  meter: Meter,
): Promise<void> {
  meter.add(
    await db.run(
      sql(
        `UPDATE feeds
            SET state = 'gone', error_count = ?, last_error_code = ?, last_status = ?, next_fetch_at = ?
          WHERE id = ?`,
        job.errorCount + 1,
        code,
        status,
        PARKED_AT,
        job.feedId,
      ),
    ),
  );
}

/**
 * SQL fragment and params that set `url` to `newUrl` unless another feed already has it
 * (merging feeds is M3, spec §7.4).
 */
export function urlUpdate(
  feedId: number,
  newUrl: string | null,
): { set: string; params: (string | number)[] } {
  if (newUrl === null) return { set: '', params: [] };
  return {
    set: ', url = CASE WHEN EXISTS (SELECT 1 FROM feeds f2 WHERE f2.url = ? AND f2.id != ?) THEN url ELSE ? END',
    params: [newUrl, feedId, newUrl],
  };
}
