/**
 * The cron dispatcher (spec §7.1, §7.2, ADR 0004): lease due feeds with one statement, call the
 * `FeedRefresher` entrypoint once per feed (each call is its own invocation with its own CPU and
 * subrequest budget), and record the failures of callees that could not record their own.
 */
import type { FeedErrorCode } from '@tidings/shared';
import { Db, nowSeconds, type Clock } from '../db';
import { leaseDueFeeds, Meter, recordFailure } from './store';
import type { RefreshJob, RefreshOutcome } from './types';

/** ADR 0004: 20 feeds per tick. */
export const REFRESH_BATCH_SIZE = 20;

/** The exact message a callee killed for CPU rejects with (observed in TID-003). */
export const CPU_LIMIT_MESSAGE = 'Worker exceeded CPU time limit.';

export interface DispatcherDeps {
  db: Db;
  clock: Clock;
  random: () => number;
  /** In production `ctx.exports.FeedRefresher.refresh`. Injected so tests can reject. */
  refresh: (job: RefreshJob) => Promise<RefreshOutcome>;
  batchSize?: number;
}

export interface DispatchSummary {
  leased: number;
  fulfilled: number;
  rejected: number;
  cpuLimit: number;
  /** Rows read and written by the dispatcher's own statements (lease plus failure writes). */
  rowsRead: number;
  rowsWritten: number;
}

/** `cpu_limit` only for the exact runtime message; anything else is `internal`. Never stored raw. */
export function classifyRejection(reason: unknown): FeedErrorCode {
  const message = reason instanceof Error ? reason.message : undefined;
  return message === CPU_LIMIT_MESSAGE ? 'cpu_limit' : 'internal';
}

export async function runDispatcher(deps: DispatcherDeps): Promise<DispatchSummary> {
  const now = nowSeconds(deps.clock);
  const meter = new Meter();
  const jobs = await leaseDueFeeds(deps.db, now, deps.batchSize ?? REFRESH_BATCH_SIZE, meter);

  // A throw while starting a call (not only a rejection) must also settle as a failure.
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      return deps.refresh(job);
    }),
  );

  let fulfilled = 0;
  let cpuLimit = 0;
  const failed: { job: RefreshJob; code: FeedErrorCode }[] = [];
  results.forEach((r, i) => {
    const job = jobs[i] as RefreshJob;
    if (r.status === 'fulfilled') {
      fulfilled += 1;
      return;
    }
    const code = classifyRejection(r.reason);
    if (code === 'cpu_limit') cpuLimit += 1;
    failed.push({ job, code });
  });

  for (const { job, code } of failed) {
    await recordFailure(
      deps.db,
      job,
      { code, status: null, retryAfterS: null },
      now,
      deps.random,
      meter,
    );
  }

  return {
    leased: jobs.length,
    fulfilled,
    rejected: failed.length,
    cpuLimit,
    rowsRead: meter.rowsRead,
    rowsWritten: meter.rowsWritten,
  };
}
