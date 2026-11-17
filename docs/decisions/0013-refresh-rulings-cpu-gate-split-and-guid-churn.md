# 0013. Background refresh: CPU gate split, GUID churn guard, dead feeds and import budget

- Status: Accepted
- Date: 2026-11-17
- Deciders: product-manager
- Stories: TID-012 (accepted), TID-039 (new), TID-046 (new), TID-013, TID-015, TID-016, TID-024, TID-038. Source: `tid-012-gate-closure` (tip `5f01e52`), DEF-013 to DEF-017.

## Context

TID-012 passes AC1-AC12 and AC14-AC16. DEF-014, DEF-016 and DEF-017 are fixed and closed, and the AC13 benchmark gate can no longer pass vacuously. AC13 itself, the deployed CPU gate, needs throwaway Workers deployed on the user's Cloudflare account and an Analytics API token. The user hasn't approved that yet. The tester also found a design gap (DEF-013), a budget error in the spec (DEF-015), and several points that need a ruling.

## Decision 1: accept TID-012 and move AC13 to its own story

- **TID-012 is Done without AC13.** Its code is complete and tested, and every later M1 story needs the pipeline. Holding it open would block TID-013 and TID-021 on a user decision that doesn't change their code.
- **AC13 moves to TID-039 (deployed CPU gate), Blocked on the user's approval.** TID-039 must be Done before TID-024 (production deploy). If it fails, ADR 0006's ladder applies (25 items, then a 50 KB content cap, then Q6). That changes constants in the parser and refresher, not the design of later stories.
- **TID-039 also fixes the DEF-016 residuals (S4) before the run:** `analyze.ts` reads ceilings from the current plan by scenario ID, not from the run file; a run file without `runs` and `warnings` is refused; and a window where Analytics saw more than 102% of the calls made is NEEDS PM.
- **Engineer's runbook decisions:** 3 new items per `changed` call is accepted for the gate (AC4's typical case, about 25,000 rows written). Because a first fetch inserts up to 50 items, TID-039 adds one recorded run of `--new-items 50 --only changed:rss-typical --runs 50` (about 20,000 rows), on a different UTC day from the gate run if both would exceed 50,000 rows on one day. Any non-success invocation in it goes to the PM. The p95 fallback ladder (exact p95, then share above ceiling, then p90 only to fail, else PROVISIONAL) is accepted.
- **Runner warnings give NEEDS PM, not FAIL.** Confirmed. A warning can be an origin hiccup unrelated to CPU. Any non-success invocation already gives FAIL, so the PM reviewing warnings can't hide a CPU kill.

## Decision 2: GUID churn guard (DEF-013), story TID-046

A feed whose GUIDs change on every fetch makes 50 items look new each time: about 401 rows written per fetch, 19,248 a day (19% of the write quota) and 2,400 unread articles a day, from one feed. Options considered:

| Option | Fixes the duplicates? | Cost | Risk |
|---|---|---|---|
| A. Per-feed cap on new entries per day | No, only bounds them | No extra rows (counter columns on the existing feed `UPDATE`) | Busy feeds lose items past the cap |
| B. Detect churn and mark the feed misbehaving | No, only tells the user | Small | Still floods until the user acts |
| C. Secondary dedup on link and title | Yes, for the common case (GUID is a timestamp or random, link is stable) | A lookup per changed fetch | Feeds where every item links to the homepage |
| D. Secondary dedup against a lookup of all the feed's entries by link | Yes | No index on `entries(feed_id, url)`, so it scans the feed's rows: up to tens of thousands of reads per fetch for a churning feed | Read budget |

**Decision: C plus A as a backstop, with no new reads and no new row writes.**

- **Secondary key.** For each parsed item: SHA-256 of canonical link + `\n` + title, or of title + published date when there is no link. A key shared by two or more items in the same fetch is ignored (this protects feeds where every item links to the homepage).
- **Compared against the previous fetch, not the table.** The feed row keeps a compact list of the last fetch's secondary keys (`feeds.recent_keys`, at most 50 short hashes, about 600 bytes). An item that is new by GUID but whose secondary key is in that list is treated as known. Updating the list rides on the feed `UPDATE` a changed fetch already makes, so it adds columns, not rows.
- **Daily cap.** At most `MAX_NEW_ENTRIES_PER_FEED_PER_DAY = 200` new entries per feed per UTC day, counted in two feed columns on the same `UPDATE`. Items past the cap aren't stored. The feed gets `warning_code = 'new_item_cap'` until the next UTC day with fewer than 200, and Manage shows a warning from UX's fixed table. 200 a day is more than 8 an hour, which is far beyond what one person reads from one feed. Worst case for a feed whose links churn too: 200 × 8 = 1,600 rows a day (1.6%).
- **Migration `0003_feed_churn_guard.sql`** adds the columns. The `Subscription.health` type gains `warning: string | null` (fixed message, §8.2).
- **Priority:** before TID-016 (OPML import brings in many feeds of unknown quality) and before TID-024.

## Decision 3: dead feeds (FR-RF-3, §7.4)

Keep **20 consecutive failures** as the only rule, and drop "failing for 7 days". With the backoff schedule (1, 2, 4, 8 and 16 hours, then 24-hour retries) the 20th failure comes about 15 days after the first. There's no column recording when failures began, and `last_success_at` doesn't move on a healthy 304, so a time-based rule would mark quiet feeds dead. The user sees the feed as `failing` in Manage from the first failure, so nothing is hidden for those 15 days.

## Decision 4: read budget (§9.5)

A changed fetch reads about **121 rows** (D1 counts every key in the dedup `IN` list plus every hit), not the 50 the spec assumed, and every fetch reads 1 row for the parked check. §9.5 is updated: baseline A about 980,000 reads a day (20%), heavy B about 2,010,000 (40%). Reads remain far from the limit, and writes are still the first daily quota we'll hit.

## Decision 5: OPML import write cost (DEF-015, §9.8, TID-016)

A first fetch stores up to 50 entries (so items 11-50 don't arrive as unread on the next fetch) and links 10: 50 × 3 + 10 × 5 + 1 = 201 rows. With the feed row (2), the subscription (5) and the lease (1), each imported feed costs about 209 rows: **about 52,250 for 250 feeds**, not 20,000. On import day in scenario A that's about 77% of the write quota, which fits but leaves little room for larger files (the subscription limit is 1,000).

- **TID-016 limits first fetches from imports to 250 per UTC day.** Feeds beyond that are scheduled from 00:05 UTC the next day, staggered the same way. The import response reports `deferred`, and the import screen says how many feeds will start tomorrow. 250 covers the user's whole assumed subscription list (§9.2 A) in one sitting.
- TID-016 AC8 is corrected to ≤ 53,000 rows for the 250-feed fixture.

## Decision 6: error message for a 304 without validators

DEF-014's fix stores `http_304` with the message "The server returned 304 Not Modified". The code is confirmed. The wording reads like success, so UX rewrites it, and reviews the whole draft table in `packages/shared/src/feed-errors.ts`, in TID-015 (AC6). Until then the draft table is used as is.

## Decision 7: resubscribing to a parked, dead or gone feed

When a subscription is created for an existing feed that is parked, `dead` or `gone`, the feed's `next_fetch_at` resets to now (plus jitter), and a `dead` or `gone` feed returns to `pending` with `error_count = 0`. The user re-adding a feed is a reason to try it again. Built in TID-013 (AC12), which also turns the `it.todo` in `refresh-adversarial.test.ts` into a passing test.

## Decision 8: test flakiness

The intermittent `409` in TID-007 setup tests when several vitest processes run at once points to local state shared between processes. TID-038 investigates it alongside host sleep.

## Consequences

- TID-012 is Done. TID-039 (Blocked, user approval) and TID-046 (Ready) are new. TID-013 gains AC12, TID-015 gains AC6, and TID-016's AC3 and AC8 change and it gains AC9.
- Spec FR-RF-3, §6.1 (planned columns), §6.3, §7.1, §7.4, §8.2, §8.7, §9.5 and §9.8 are updated.
- Risk R3 (write quota) keeps its rating. Its two known spikes, import day and a churning feed, now have bounds.
