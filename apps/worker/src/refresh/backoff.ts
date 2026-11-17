/**
 * Failure scheduling for the refresh pipeline (spec §7.4). Pure: time and randomness are passed in.
 */

export const DEFAULT_FETCH_INTERVAL_S = 1800;
export const MAX_BACKOFF_S = 86_400;
/** `next_fetch_at` for feeds nobody subscribes to, and for `gone` feeds (year 9999, spec §7.1). */
export const PARKED_AT = 253_402_300_799;
/** Consecutive failures after which a feed is `dead` and retried daily (AC8). */
export const DEAD_AFTER_FAILURES = 20;
const RETRY_AFTER_MIN_S = 1800;

export interface FailureInput {
  /** `error_count` before this failure. */
  errorCount: number;
  fetchIntervalS: number;
  now: number;
  /** Parsed `Retry-After` in seconds, only for 429 and 503. */
  retryAfterS: number | null;
  /** Returns a value in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

export interface FailurePlan {
  errorCount: number;
  state: 'failing' | 'dead';
  nextFetchAt: number;
}

/**
 * `error_count += 1`; `next_fetch_at = now + min(interval x 2^error_count, 86,400)` with ±10% jitter,
 * or `now + clamp(Retry-After, 1800, 86,400)` exactly. Dead feeds retry every 24 hours.
 */
export function planFailure(input: FailureInput): FailurePlan {
  const errorCount = input.errorCount + 1;
  if (errorCount >= DEAD_AFTER_FAILURES) {
    return { errorCount, state: 'dead', nextFetchAt: input.now + MAX_BACKOFF_S };
  }
  if (input.retryAfterS !== null) {
    const wait = Math.min(Math.max(input.retryAfterS, RETRY_AFTER_MIN_S), MAX_BACKOFF_S);
    return { errorCount, state: 'failing', nextFetchAt: input.now + wait };
  }
  const base = Math.min(input.fetchIntervalS * 2 ** errorCount, MAX_BACKOFF_S);
  const jitter = 0.9 + 0.2 * input.random();
  return { errorCount, state: 'failing', nextFetchAt: input.now + Math.round(base * jitter) };
}

/** `Retry-After` as delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v);
  if (!/[A-Za-z]/.test(v)) return null; // an HTTP date names its month; "-5" is not a date
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor(ms / 1000) - now);
}
