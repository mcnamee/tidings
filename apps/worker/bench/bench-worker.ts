/**
 * Benchmark callee for AC13 (deployed as `tidings-bench`, deleted afterwards): the production
 * `FeedRefresher`, unchanged, as its own Worker so that every analytics row for this script name is
 * one `refresh()` invocation and nothing else.
 *
 * The only addition is a benchmark-only body cap: a job URL carrying `?cap=<bytes>` raises
 * `MAX_BODY_BYTES` for that call, to measure body read + SHA-256 at 2 MiB (not gated). Nothing
 * outside this file knows about it; production code never sets the cap.
 */
import { FeedRefresher as ProductionFeedRefresher } from '../src/refresh/entrypoint';
import type { RefreshDeps } from '../src/refresh/refresh-feed';
import type { RefreshJob, RefreshOutcome } from '../src/refresh/types';

const CAP_PARAM = 'cap';

function capFor(url: string): number | undefined {
  try {
    const cap = Number(new URL(url).searchParams.get(CAP_PARAM));
    return Number.isInteger(cap) && cap > 0 && cap <= 8_000_000 ? cap : undefined;
  } catch {
    return undefined;
  }
}

export class FeedRefresher extends ProductionFeedRefresher {
  private benchCap: number | undefined;

  protected override depsOverrides(): Partial<RefreshDeps> {
    return this.benchCap === undefined ? {} : { maxBodyBytes: this.benchCap };
  }

  override async refresh(job: RefreshJob): Promise<RefreshOutcome> {
    this.benchCap = capFor(job.url);
    return super.refresh(job);
  }
}

export default {
  fetch: () => new Response('tidings benchmark callee', { status: 404 }),
} satisfies ExportedHandler;
