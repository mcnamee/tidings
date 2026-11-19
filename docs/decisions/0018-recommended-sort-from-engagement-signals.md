# 0018. Recommended sort from engagement signals

- Status: Accepted (owner request and approval 2026-11-19; the PM confirms at acceptance)
- Date: 2026-11-19
- Deciders: owner (reversal of "Won't do: AI features", scope), software-engineer (design of stage 1), product-manager (acceptance)
- Stories: TID-066 (stage 1, built here), TID-067 (stage 2, built: see the amendment at the end). Builds on ADR 0003 (data store), ADR 0012 (isolation), ADR 0017 (url keys) and spec §7.6 (retention).

## Context

The owner wants the unread list to be able to put the articles they are most likely to want first, learned from what they actually read. Until now the spec listed "AI features" under Won't do. On 2026-11-19 the owner explicitly approved reversing that for this one feature. Spec §2, §16 (Q16) and the backlog are updated to match. Summaries, translation and any chat or generative feature remain Won't do.

The feature has two stages, so the data can start accumulating before any ranking exists: ranking needs a profile, and a profile needs weeks of signals.

## Decisions

### 1. The signals and their points

| Signal | Points | When |
|---|---|---|
| `open` | 1 | The user opens an article in the article view by their own action. |
| `click` | 2 | The user goes through to the original website: the title link or the Open original button in the article view. |
| marked read by scrolling past, "Mark all as read", the Mark as read button | 0 | No signal at all, no request, no row. |

An article that is both opened and clicked through is **3 points** (each kind counts once per entry, however often it is repeated). The owner's rule gave the two single values; summing them was chosen because the click always follows an open, and an article that was read and then taken to the site is more interesting than one that was only opened. If the owner wants "strongest signal only" (a clicked article is 2), it is a one-line change in the stage 2 scoring, because the table keeps both timestamps.

**What counts as an open.** A tap on a list row (history PUSH) and Previous / Next (history REPLACE) count. Next and Previous count because they are the user's explicit act of putting a new article full-screen, the same trigger the mark-read-on-open rule already uses. A direct link, a reload and history Back or Forward (POP) do not, so reloading an article never double counts. A scroll-past or a bulk mark never counts. Stepping back to an article already signalled in this page's life sends nothing, and the server is idempotent anyway.

### 2. Storage: one compact row per user and entry, outliving the entry

Migration `0007_engagement.sql` creates `engagement(user_id, entry_id, feed_id, title, url, url_key, opened_at, clicked_at, last_at)`, primary key `(user_id, entry_id)`, `WITHOUT ROWID`. Points are derived from the two timestamps, not stored.

- **Survives the content purge.** Maintenance deletes read `user_entries` after 30 days, purges content and later deletes the `entries` tombstone (spec §7.6). The row therefore has **no foreign key** to `entries` (or feeds), and copies the entry's `title`, `feed_id`, canonical `url` and `url_key` at write time. Stage 2 needs the text of engaged entries to embed them again (title) and the keys to match duplicates; it cannot rely on the entry still existing. `user_id` does cascade from `users`, so removing a user removes their signals.
- **At most one row per user and entry.** The write is one `INSERT … SELECT … ON CONFLICT (user_id, entry_id) DO UPDATE SET <kind>_at … WHERE <kind>_at IS NULL`. A repeat of a recorded kind matches nothing and writes nothing.
- **No secondary index.** An index on `last_at` for the retention sweep would add a row written to every signal, and writes are the scarce resource (spec §9). The table is small, so the sweep scans it.
- **Only the owner's own entries.** The `SELECT` joins `user_entries` scoped to `user_id`, so another user's or an unknown entry inserts nothing and answers 404.

### 3. Retention: 180 days from the latest signal

The 03:17 UTC maintenance run deletes up to 500 rows with `last_at` older than 180 days, as one bounded statement outside the shared retention budget (spec §7.6 step 6). It runs daily, not hourly, because with no index it scans the table. A backlog above 500 catches up over later days. 180 days matches the tombstone retention and is long enough for a stable profile; a stage 2 profile is recency-weighted, so older signals count little anyway.

### 4. API

`POST /api/entries/:id/engagement` with the strict body `{ kind: 'open' | 'click' }`, `200 { recorded: boolean }`, `404` for an entry that is not the caller's, `400` for anything else in the body (spec §8.5). It is covered by the per-user rate limit like every other write, is in the route table and has an isolation case (ADR 0012).

### 5. Client behaviour

Fire and forget: `fetch` with `keepalive: true` so the request survives leaving for the original site, never awaited by navigation, no toast and no retry queue on failure (a failed send is forgotten so the next open or click tries again). The signal is sent once the article has loaded, not on a placeholder.

### 6. Privacy

The signals are the owner's own reading behaviour. They stay in the owner's Cloudflare account (D1, and in stage 2 Workers AI on the same account). Nothing is sent to a third party, and stage 2 sends only article titles and summaries (public feed text) to Workers AI, never the signals or any identifier. Removing the user removes the signals (cascade), and they expire after 180 days.

### 7. Free-tier cost of stage 1

- **Rows written:** 1 per signal (the first open inserts the row, a later click updates it, a repeat writes 0), measured in `apps/worker/test/engagement.test.ts`. At an assumed 75 signals a day that is about 150 rows a day including the retention delete, 0.15% of the 100,000 daily limit (spec §9.4).
- **Rows read:** about 3 per signal plus the daily scan, up to about 14,000 a day, 0.3% of the 5,000,000 limit (spec §9.5).
- **Requests:** one extra Worker request per open or click, roughly 75 a day against the 100,000 limit. Workers CPU is a single indexed statement.
- **No new Cloudflare product, no new dependency.**

## Stage 2 (TID-067): recommended sort, as planned (built: see the amendment at the end)

- **Embeddings.** Embed each new entry's title plus summary with Workers AI `@cf/baai/bge-small-en-v1.5` (384 dimensions). Measured price: 1,841 neurons per million input tokens, so about 300 neurons a day at roughly 2,000 entries a day, against the 10,000 neurons a day free allowance.
- **Storage in D1, not Vectorize.** Each embedding is stored compactly (for example int8-quantised, about 384 bytes) in D1. Vectorize's Free plan holds 5 million stored dimensions, about 13,000 vectors at 384 dimensions, too few for a 90-day unread window.
- **Profile.** A per-user interest profile is the points- and recency-weighted mean of the embeddings of engaged entries (from `engagement`).
- **Ranking.** Rank the user's unread by cosine similarity to the profile with a freshness decay, and add a "Recommended" sort option beside newest-first.
- **Fallback.** Until there are enough signals (for example 20), the sort is newest-first.
- **CPU.** The Free plan allows 10 ms CPU per request, so scores are pre-computed in the hourly job, or the candidate set is capped; measure first and record the costs in spec §9.
- Acceptance criteria are in the backlog entry for TID-067. Stage 2 needs its own budget check before it is built, and may need a further ADR if the measurements change the design (for example a Workers AI binding in `wrangler.jsonc`).

## Consequences

- Stage 1 is invisible to the user: no UI changes, no new screen. It only starts collecting.
- The table holds a copy of an entry's title for up to 180 days after the entry itself is gone. That is intended.
- Signals recorded before stage 2 ships are what make the first recommendations useful, so stage 1 ships first.
- A signal sent while the owner is offline is lost (no retry queue). Acceptable: the signal is a statistical hint, and a queue would add code and storage for little gain.

## Alternatives considered

- **Store points in a column.** Rejected: it duplicates the two timestamps, and the scoring rule (sum or strongest) is left open for stage 2.
- **An index on `last_at`.** Rejected: one extra row written per signal, for a sweep that scans a few thousand rows once a day.
- **A foreign key to `entries` with cascade.** Rejected: it would delete the signal exactly when the tombstone goes, which is what must not happen.
- **Counting list scroll-past or bulk reads as weak signals.** Rejected by the owner (0 points).

## Owner confirmation (2026-11-19)

The owner confirmed the combined scoring: an article opened and then clicked through scores 3 (1 + 2). To be revisited once the recommended sort (TID-067) is in use.

## Amendment 2026-11-19: stage 2 as built (TID-067)

Stage 2 follows the plan above. What was decided while building it, and where it differs, is below. The spec has the normative detail (§6.1, §7.7, §8.5, §8.6, §9).

### Decisions

1. **Embeddings are base64 text in D1, not BLOBs.** Migration `0008_recommended_sort.sql` creates `entry_embeddings(entry_id, vec)`, `embed_queue`, `user_profiles`, adds `engagement.embedding` and the index `engagement_user_last(user_id, last_at)`. The vector is normalised, quantised to int8 with a float32 scale (388 bytes, 520 characters). Measured in workerd: D1 returns a BLOB as an array of 388 integers, and parsing 1,000 of them costs 4 ms against under 1 ms for the text form. The 33% larger row is the cheaper trade. Cosine from the quantised form is within about 0.5% of the exact value (tested).
2. **Where embedding happens.** Not in the refresh. The refresh batch gains one statement that queues the new entries that are now linked as unread (one `embed_queue` row each). A `Recommender` entrypoint (`ctx.exports`, like `FeedRefresher`, so its own CPU budget) runs the embed step after the dispatcher on a minute cron, only when the queue has a row: up to 25 entries, one `AI.run` call, one D1 batch. A failed call counts a try on the rows (three parks them) and nothing else changes. A new subscription queues its linked entries too. Entries linked only as already read (older than 7 days on a first fetch) are not queued, because they never appear in an unread list.
3. **Budget in code.** At most 3,000 neurons and 3,000 entries a UTC day, counted in two `rate_limits` rows (`ai:tokens`, `ai:entries`). Tokens are estimated at 3 characters each (an over-estimate) and priced at the owner's 1,841 neurons per million. The entry cap bounds D1 writes, which are the scarcer resource, not neurons.
4. **Profile.** The hourly cron's second step (`Recommender.buildProfiles`) reads each user's latest 500 signals through `engagement_user_last` and stores the weighted mean: `points × 0.5^(age/14 days)` with points 1 (open), 2 (click), 3 (both), as unit vector, plus the number of signals. A signal's embedding comes from its own copy (taken when the signal is recorded), else the entry's embedding while the entry exists (then copied onto the signal, so the profile survives the purge), else **the stored title is embedded again** (within the same budget; this is what makes the signals recorded by stage 1 usable, because those entries were never embedded). A signal with none is skipped. The minimum is 20 signals.
5. **Ranking.** `score = cosine(profile, entry) + 0.5 × 0.5^(age / 3 days)`; an entry without an embedding uses a cosine of 0.3. The freshness bonus is as large as the gap between a strong match (about 0.7) and an average one (about 0.3), so a strong match a week old only ties an average article from today and a two-week-old one loses; the constants are in `src/recommend/score.ts` and a unit test fixes the order for the cases in the backlog. Ranking is done in the request, not precomputed: a precomputed score would cost a row written per unread entry per user per refresh of the profile, and writes are the scarce quota.
6. **Candidate cap 500, not 1,000.** The plan said to measure first. Measured in workerd (timer resolution 1 ms): scoring and sorting 1,000 candidates takes a median 2 ms and up to 4 to 8 ms in the worst of 15; 500 takes about 1 ms. With the rest of the request on top and a limit of 10 ms, 500 leaves the margin. The newest 500 unread entries of the view are ranked; the rest are served newest first after them, so nothing is unreachable. Ranking reads 501 candidate rows and their embeddings (1,202 rows for a 50-item page, measured).
7. **Cursor.** Phase 1 carries the frozen clock, the last item's `(score, id)` and the boundary of the ranked set; phase 2 is an ordinary newest-first cursor. Entries marked read while scrolling (mark-read-on-scroll) only drop out; nothing repeats or is skipped except if the hourly profile rebuild lands mid-scroll (documented, spec §8.6).
8. **The sort is a setting, not a per-view choice.** `listSort` (`'newest'` default, `'recommended'`) lives in the user's settings and is saved on the server like the other settings, so it is the same on every device and every view. The header button and a Settings switch change the same value. It applies to unread lists only. The API default stays newest first (`sort` is an explicit parameter).
9. **Fallbacks.** The response says which order it used (`sort`) and, when `recommended` was asked for but not applied, why (`sortNote`: `cold_start` for no profile or under 20 signals, `unavailable` when there is no profile and no `AI` binding). The SPA shows one muted line for each. With no binding the embed and profile steps do nothing. Locally the binding is a stub that fails when called (see "Tooling" below), which the steps treat as a failed call, so the dev and E2E Workers show the cold-start line.

### Tooling consequences

- Workers AI bindings are remote-only: `wrangler dev` and the Vitest pool try to open a remote proxy session and fail without credentials. Local development, the E2E Worker and the tests now run with `wrangler dev --local` (`npm run dev`, `e2e/playwright.config.ts`, README) and `remoteBindings: false` (`apps/worker/vitest.config.ts`). Nothing calls Workers AI in any test: every embedder is a fake that is passed in.
- `AI` is optional in `Env` (`apps/worker/env.d.ts`).

### Costs (details in spec §9; measured where a test exists)

| | A (1 user, 400 entries a day) | B (3 users, 800 a day) |
|---|---|---|
| Neurons a day (10,000 free) | about 75 to 100 (≤ 1%) | about 150 to 200 (≤ 2%); an OPML import of 250 feeds, one time, about 460 |
| Rows written a day (100,000) | about 1,850 (1.8%); import one time 7,500 | about 3,850 (3.9%) |
| Rows read a day (5,000,000) | +200,000 (+3.9%) | **+590,000 (+11.8%)** |
| Storage | about 14 MB (2.8%) | about 35 MB (7%) |
| Requests a day (100,000) | +125 typical, ≤ +1,464 | same |
| CPU | 500 candidates scored in about 1 ms; page about 4 ms locally | profile 3 ms, embed encode under 1 ms, each in its own invocation |

**Above the 10% line:** reads in the three-user worst case where every list page is a recommended page (+11.8%). Almost all of it is the recommended page itself (1,202 rows against about 150). The owner is one user (A, +3.9%). It is raised for the PM; if it matters, `CANDIDATE_LIMIT` is one constant and halving it halves the biggest item.

### Not verified

- The deployed Workers AI call and its response shape (`{ shape, data: number[][] }`, as documented) have not run; the code validates the shape and treats anything else as a failed call. The model's default pooling is used (the docs offer `pooling: "cls"`, recommended for this model family; not set because it could not be tried).
- D1's billing of the moved `engagement_user_last` entry on a click (the simulator reports 2 rows; spec §9.4 budgets up to 3).
- Deployed CPU of the recommended page. The gate is TID-047 (post-launch budget and CPU check), which should read `Recommender` and list-request CPU.

### At deploy

The `"ai": { "binding": "AI" }` binding is in `wrangler.jsonc`; `npm run deploy` applies migration 0008 first and then deploys. The API token that deploys needs the Workers Scripts edit permission it already has; Workers AI needs no extra token for a Worker's own binding. No new secret. After the first deploy, the first embeddings appear within a minute of the next refresh that finds new entries, and the first profile at the next :17 once there are 20 signals with embeddings or titles.
