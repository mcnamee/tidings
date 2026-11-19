# 0018. Recommended sort from engagement signals

- Status: Accepted (owner request and approval 2026-11-19; the PM confirms at acceptance)
- Date: 2026-11-19
- Deciders: owner (reversal of "Won't do: AI features", scope), software-engineer (design of stage 1), product-manager (acceptance)
- Stories: TID-066 (stage 1, built here), TID-067 (stage 2, planned). Builds on ADR 0003 (data store), ADR 0012 (isolation), ADR 0017 (url keys) and spec §7.6 (retention).

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

## Stage 2 (TID-067): recommended sort, planned, not built

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
