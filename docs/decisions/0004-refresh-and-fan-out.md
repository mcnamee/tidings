# 0004. Background refresh: per-minute cron dispatcher with per-feed loopback RPC

- Status: Results in, decision pending PM (spike TID-003 ran 2026-11-16; was: Accepted, provisional on spike TID-003)
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

## Results (spike TID-003, run 2026-11-16, Workers Free plan)

Code: `spikes/tid-003/` (never merged). Account: the user's, confirmed Free. Workers: `tidings-spike-fanout` (dispatcher plus an in-Worker `Callee` entrypoint reached through `ctx.exports`) and `tidings-spike-fanout-callee` (a second Worker with the same `Callee` entrypoint, reached through a service binding with `entrypoint: "Callee"`). Compatibility date 2026-11-16, flag `enable_ctx_exports`. Wrangler 4.162.0.

**Measurement source.** CPU and outcome come from Cloudflare's `wrangler tail --format json` events (`cpuTime`, `wallTime`, `outcome`, one event per invocation including each RPC callee). Not `performance.now()`. Two limits on the data: `cpuTime` is whole milliseconds, and tail sheds events under bursts (a 20-callee burst delivered about 11 events), so CPU tables are samples from the delivered events; pass/fail counts come from the dispatcher's own `Promise.allSettled` result and are complete. I tried to read the GraphQL Analytics API with the Wrangler OAuth token; the permission system denied that, so no GraphQL numbers are included.

### AC1: do callees get their own CPU budget?

Callee burns CPU with a xorshift loop (3.5M iterations measured 6 ms per callee in tail; 20 callees per run).

| Run                                                  | `ctx.exports`                                              | Service binding (2 Workers)            |
| ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| 20 callees x ~6 ms CPU                               | 20/20 fulfilled                                            | 20/20 fulfilled                        |
| 20 callees x ~29 ms CPU (16M iters, well over 10 ms) | 20/20 fulfilled                                            | 20/20 fulfilled                        |
| 20 callees x 100M iters (0.1 to 2 s CPU)             | 8 fulfilled, 12 rejected `Worker exceeded CPU time limit.` | 11 fulfilled, 9 rejected, same message |
| 5 callees x 300M iters                               | 3 fulfilled, 2 rejected                                    | 3 fulfilled, 2 rejected                |
| Dispatcher CPU (tail, `ok` outcome in every run)     | 1 ms (n=3 events)                                          | 1 to 3 ms (n=6 events)                 |

Findings:

- **Isolation holds, for both mechanisms.** Each callee is its own invocation (own tail event, entrypoint `Callee`, own `cpuTime`). Twenty callees at 6 ms (120 ms total) and at 29 ms (about 580 ms total) did not touch the dispatcher's CPU: it stayed at 1 to 3 ms and always finished `ok`.
- **A callee killed for CPU fails alone.** Tail shows `outcome: exceededCpu` on the callee event; the dispatcher's `allSettled` receives a rejection whose message is `Worker exceeded CPU time limit.`, so the dispatcher can tell `cpu_limit` from other errors by message, as ADR 0004 plans.
- **The 10 ms CPU limit is soft on this account, not a hard cutoff.** A single HTTP request burning 699 ms CPU (`/burn?iters=400000000`) returned 200 `ok`. Callees at about 29 ms CPU all completed. Kills only appeared at roughly 100 ms CPU and above, and not for every over-limit callee (some ran 876 ms to completion; killed ones logged 10, 99 and 197 ms). Do not read "p99 4 ms in the spike" as "safe with margin"; do read it as "the limit isn't hit by ordinary work". Design and budget to 10 ms regardless, because Cloudflare doesn't promise the lenient behaviour.
- The scheduled (cron) dispatcher also behaves the same: cron event 1 ms CPU, 20 `rpc:work` callee events alongside it, all `ok`.

### AC2: do callee subrequests count against the dispatcher's 50?

- Control: one invocation doing 60 `fetch()` calls got 50 successes and 10 `Too many subrequests by single Worker invocation`. The 50 limit is enforced on this account.
- 20 callees x 3 `fetch()` (60 total) to `https://example.com/`: all 60 returned 200, in both modes. Repeated at 20 x 5 (100 total): all 100 returned 200, both modes.
- **Callee subrequests are counted per callee invocation, not against the dispatcher.**
- **But the RPC call itself counts differently by mechanism.** Through a service binding, each RPC call counts as one of the dispatcher's 50 subrequests (n=50 fulfilled, then `Too many subrequests` at 60 and at 100 calls). Through `ctx.exports`, 100 RPC calls in one invocation all succeeded. The "32 service-binding invocations per request" figure in spec §9.1 did not bite: 33 calls succeeded in both modes.
- Wall time: 20 callees x 3 sequential fetches finished in about 6 to 8 s wall (example.com from the Sydney colo). Far under the 15 min cron wall limit.

### AC3: do callee invocations count toward 100,000 requests/day? (method only; a day couldn't pass in the session)

Left deployed: `tidings-spike-fanout` only, cron `*/5 * * * *` (deployed 2026-11-16 10:13 UTC). Each tick is one scheduled invocation plus exactly 20 `ctx.exports` callee invocations, with no outbound fetches and about 0 ms CPU, so the expected counts are deterministic:

| Hypothesis           | Requests for `tidings-spike-fanout` per 5-minute tick | Per hour | Per UTC day |
| -------------------- | ----------------------------------------------------- | -------- | ----------- |
| Callees do not count | 1                                                     | 12       | 288         |
| Callees count        | 21                                                    | 252      | 6,048       |

How to read it (no need to wait a full day: one clean hour is enough, any hour after 11:00 UTC on 2026-11-16 once nothing else calls the Worker):

1. Dashboard: Cloudflare dashboard, Workers & Pages, `tidings-spike-fanout`, Metrics tab, Requests chart, set the range to cover whole hours after 11:00 UTC on 2026-11-16, and read the request total for one hour. About 12 means callees are not counted; about 252 means they are. The Workers & Pages overview "Requests" counter (the figure that is capped at 100,000/day) should move by the same amounts for this Worker; compare per-day totals the same way on 2026-11-17 UTC (288 vs 6,048, plus any other Workers on the account).
2. GraphQL Analytics (`https://api.cloudflare.com/client/v4/graphql`), same comparison:
   ```graphql
   query {
     viewer {
       accounts(filter: { accountTag: "72f8c2f186ccd349773a913a4e07e8e5" }) {
         workersInvocationsAdaptive(
           limit: 100
           filter: {
             scriptName: "tidings-spike-fanout"
             datetime_geq: "2026-11-17T00:00:00Z"
             datetime_lt: "2026-11-18T00:00:00Z"
           }
           orderBy: [datetimeHour_ASC]
         ) {
           dimensions {
             datetimeHour
             scriptName
             status
           }
           sum {
             requests
             subrequests
             errors
           }
         }
       }
     }
   }
   ```
   Sum `sum.requests` per `datetimeHour`. Also compare the per-script figure with the account-level Requests total on the dashboard (the quota counter), to confirm the quota counter and analytics agree.
3. The earlier ad hoc test traffic from this session (a few hundred calls on 2026-11-16 UTC) is in the 2026-11-16 data, so use whole hours after 11:00 UTC or the full 2026-11-17 day, not the 16th.

Caveat: this answers it for `ctx.exports` (the chosen mechanism). For service-binding callees the same experiment would use the other Worker; it was deleted, because only one mechanism is recommended (see below). If the PM wants the service-binding answer too, redeploy `spikes/tid-003/callee` and add the binding.

### AC5: Rate Limiting binding on Free

`"ratelimits": [{ "name": "RL", "namespace_id": "1001", "simple": { "limit": 5, "period": 10 } }]` deployed on the Free plan without error (`env.RL (5 requests/10s) Rate Limit` shown in the deploy output). It enforces: a burst of 12 sequential `limit()` calls on a fresh key returned `111111000000` (6 allowed, 6 denied), twice for different keys. Across several seconds-apart bursts the allowed count varied (2 to 6 per burst) as 10 s windows rolled over. So: available on Free, enforces, approximate (up to one over the limit within a burst; counts are per location and eventually consistent), as Cloudflare documents. Fit for the 600 requests/minute per-user backstop in spec §10.7, not for anything that needs exact counts. Auth routes keep the D1 counter as planned. The binding was removed from the final deployed config.

### Recommendation (for the PM to decide)

1. **Keep option 3 as written: `ctx.exports.FeedRefresher.refresh(job)`.** Isolation, independent CPU accounting and independent subrequest budgets are all confirmed, and `ctx.exports` is better than a service binding on one more count: its RPC calls don't consume the dispatcher's 50-subrequest budget. The ladder's rung 1 (two Workers) would work but caps the batch at under 50 minus the dispatcher's other subrequests, so don't use it unless something forces it.
2. **`REFRESH_BATCH_SIZE`: keep 20.** Subrequests no longer limit it (100 `ctx.exports` calls in one invocation worked), so 25 is technically fine. The binding constraints now are the daily request quota if callees count (1,440 x (1 + 20) = 30,240/day at 20; 37,440 at 25), D1 writes (lease row per fetch), and 6 simultaneous outbound connections per callee. At 250 feeds / 30 min the average tick needs about 8 feeds, so 20 is generous headroom. Revisit once AC3 is read.
3. Treat the soft CPU limit as a bonus, not as budget: keep TID-002's caps so a refresh stays under 10 ms.
4. Update spec §9.1 rows: callee CPU and subrequest budget = verified 2026-11-16 (`ctx.exports` and service binding), service-binding calls count toward the 50 subrequests (`ctx.exports` calls don't), the 32-invocation cap not observed (33 calls in both modes, 100 via `ctx.exports`), rate limiting = available and approximate on Free, callee request counting = pending AC3 read.

### Still deployed (AC3)

`tidings-spike-fanout` only. Delete after reading the result: `npx wrangler delete --name tidings-spike-fanout --force`.
