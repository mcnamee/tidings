import type { FeedErrorCode } from '@tidings/shared';

export type FeedState = 'pending' | 'ok' | 'failing' | 'dead' | 'gone';

/** What the dispatcher's lease returns for one feed, and what `FeedRefresher.refresh` takes. */
export interface RefreshJob {
  feedId: number;
  url: string;
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  errorCount: number;
  state: FeedState;
  fetchIntervalS: number;
  lastSuccessAt: number | null;
}

export interface D1Usage {
  rowsRead: number;
  rowsWritten: number;
  /** Prepared statements run, for the 50-queries-per-invocation limit. */
  statements: number;
}

export type RefreshResult =
  /** New or changed content was stored. */
  | 'updated'
  /** 304 or a byte-identical body. */
  | 'unchanged'
  /** No subscribers: parked instead of fetched. */
  | 'parked'
  | 'failed'
  /** The config guard refused to run (ALLOW_FETCH_HOSTS with a non-local APP_ORIGIN). */
  | 'skipped';

/**
 * What a refresh returns over RPC. Deliberately tiny and free of anything from the origin: a fixed
 * code, counts and numbers only (spec §10.6 rule 8).
 */
export interface RefreshOutcome {
  feedId: number;
  result: RefreshResult;
  newEntries: number;
  errorCode: FeedErrorCode | null;
  usage: D1Usage;
}
