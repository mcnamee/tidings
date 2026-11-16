# 0004. Background refresh: per-minute cron dispatcher with per-feed loopback RPC

- Status: Accepted, provisional on spike TID-003
- Date: 2026-11-16
- Deciders: product-manager

## Context

Baseline load is 250 feeds every 30 minutes: 12,000 fetches/day. On the Free plan each invocation has 10 ms CPU and 50 external subrequests, and parsing feed XML is CPU-heavy. A single cron invocation can't fetch and parse many feeds. Queues on Free allow 10,000 operations/day, about 3,300 messages, which is too few for one message per fetch.

## Options

1. One cron invocation fetches and parses a batch of feeds. Fails: parse CPU for even two or three feeds exceeds 10 ms.
2. Cron enqueues one Queue message per feed. Fails the Free quota (12,000 × 3 ops = 36,000/day).
3. **Cron dispatcher leases due feeds and calls a `FeedRefresher` entrypoint once per feed via `ctx.exports` (loopback service binding RPC)**, each call a separate invocation.
4. Durable Object per feed shard with alarms.
5. Workers Paid (30 s CPU), simple batch loop. Costs $5/month.

## Decision

Option 3:
- Cron `* * * * *` runs the dispatcher; one `UPDATE … RETURNING` leases up to 20 due feeds by moving `next_fetch_at` forward atomically (no double fetch across overlapping ticks).
- For each, `ctx.exports.FeedRefresher.refresh(job)`; `Promise.allSettled`; the dispatcher records failures (including CPU-limit kills) for callees that couldn't.
- Each refresh: conditional GET → body hash → streaming parse capped at 50 items and 2 MB → dedup → one `batch()` write. No write when nothing changed.
- Capacity 28,800 fetches/day (600 feeds at 30 min). More capacity: add dispatcher crons (up to 3 more).
- New subscriptions call the same entrypoint directly from the API so the first fetch is immediate and in its own CPU budget.
- Hourly maintenance cron does bounded cleanup.

## Fallback ladder (if TID-003 shows callees share the caller's CPU or subrequest budget)

1. Move `FeedRefresher` to a second Worker bound by a normal service binding, and re-test.
2. Durable Object alarms (SQLite DO, Free: 100k requests/day), one DO per shard of feeds, one feed per alarm.
3. Queues with up to 3 feeds per message (≈ 4,000 messages/day at baseline: within 10,000 ops only at 45-minute intervals), and lower the interval.
4. Ask the user about Workers Paid (spec Q6).

## Consequences

- Every feed is isolated: one pathological feed fails alone and backs off.
- Requests/day ≈ 16,000 at baseline (assuming callee invocations count as requests).
- The lease costs one row written per fetch: the largest single item in the write budget.
