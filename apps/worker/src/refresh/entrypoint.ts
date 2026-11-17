/**
 * `FeedRefresher`: the per-feed RPC entrypoint (ADR 0004). The dispatcher (and, from TID-013, the
 * subscribe API) calls it through `ctx.exports.FeedRefresher.refresh(job)`; each call is a separate
 * invocation with its own CPU and subrequest budget.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../../env';
import { Db } from '../db';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';
import { refreshFeed, type RefreshDeps, type RefreshLog } from './refresh-feed';
import type { RefreshJob, RefreshOutcome } from './types';

export const logWarning: RefreshLog = (event, data) => {
  console.warn(JSON.stringify({ level: 'warn', event, ...data }));
};

export class FeedRefresher extends WorkerEntrypoint<Env> {
  /** Extension point for the AC13 benchmark Worker (apps/worker/bench). Production adds nothing. */
  protected depsOverrides(): Partial<RefreshDeps> {
    return {};
  }

  async refresh(job: RefreshJob): Promise<RefreshOutcome> {
    // TID-012 AC16 / spec §10.6: a misconfigured ALLOW_FETCH_HOSTS means no fetch at all.
    let policy;
    try {
      policy = resolveFetchPolicy(this.env);
    } catch (err) {
      if (!(err instanceof FetchConfigError)) throw err;
      console.error(`configuration error: ${err.message}`);
      return {
        feedId: job.feedId,
        result: 'skipped',
        newEntries: 0,
        errorCode: null,
        usage: { rowsRead: 0, rowsWritten: 0, statements: 0 },
      };
    }
    return refreshFeed(job, {
      db: new Db(this.env.DB),
      // Looked up at call time so tests can replace `globalThis.fetch`.
      fetch: (input, init) => fetch(input, init),
      clock: () => Date.now(),
      random: () => Math.random(),
      appOrigin: policy.appOrigin,
      allowHosts: policy.allowHosts,
      log: logWarning,
      ...this.depsOverrides(),
    });
  }
}
