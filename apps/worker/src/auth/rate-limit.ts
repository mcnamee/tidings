import { Db, nowSeconds, sql, type Clock } from '../db';

/**
 * D1 fixed-window counters for the public auth routes (spec 10.7, ADR 0004). Authoritative:
 * unlike the Rate Limiting binding it is exact.
 *
 * Counting is increment-first, so concurrent requests cannot slip past the limit together.
 * Requests that turn out fine can hand their slot back with `refund`, which makes the limit a
 * limit on failed attempts (TID-007 AC6) while still stopping a parallel guessing burst.
 */
export interface RateRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateTicket extends RateRule {
  windowStart: number;
}

export type RateResult =
  { allowed: true; tickets: RateTicket[] } | { allowed: false; retryAfterSeconds: number };

interface CounterRow {
  count: number;
  window_start: number;
}

/** Takes one slot from every rule. The first rule that is over its limit refuses the request. */
export async function consumeRateLimits(
  db: Db,
  rules: readonly RateRule[],
  clock: Clock,
): Promise<RateResult> {
  const now = nowSeconds(clock);
  const tickets: RateTicket[] = [];
  let retryAfter = 0;
  for (const rule of rules) {
    const row = await db.first<CounterRow>(
      sql(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start + ?3 <= ?2 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start + ?3 <= ?2 THEN ?2 ELSE window_start END
         RETURNING count, window_start`,
        rule.key,
        now,
        rule.windowSeconds,
      ),
    );
    if (!row) throw new Error('rate_limits upsert returned no row');
    if (row.count > rule.limit) {
      retryAfter = Math.max(retryAfter, row.window_start + rule.windowSeconds - now, 1);
    } else {
      tickets.push({ ...rule, windowStart: row.window_start });
    }
  }
  if (retryAfter > 0) {
    // Give back the slots taken by rules that did allow it: a refused request is not an attempt
    // against them.
    await refundRateLimits(db, tickets);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  return { allowed: true, tickets };
}

/** Returns slots taken by `consumeRateLimits`, but only inside the window they were taken in. */
export async function refundRateLimits(db: Db, tickets: readonly RateTicket[]): Promise<void> {
  if (tickets.length === 0) return;
  await db.batch(
    tickets.map((t) =>
      sql(
        'UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key = ? AND window_start = ?',
        t.key,
        t.windowStart,
      ),
    ),
  );
}
