# 0017. Hiding duplicate articles across feeds

- Status: Accepted (engineer's design for TID-061; the PM confirms at acceptance)
- Date: 2026-11-18
- Deciders: software-engineer (design), product-manager (acceptance)
- Stories: TID-061. Builds on ADR 0004 (fan-out), ADR 0008 (read budgets) and ADR 0013 decision 2 (churn guard).

## Context

The owner follows overlapping feeds (two BBC feeds), so one story becomes two `entries` and two `user_entries`. Dedup today is per feed (GUID, then TID-046's link and title key within one feed). The fix must be per user, must not cost the scarce resource (D1 rows written; spec §9), and the lookup must be one bounded, indexed probe per new candidate (AC6).

## Decisions

### 1. Two keys per entry, computed at insert time, stored on `entries`

`packages/shared/src/dedup-keys.ts` (pure, unit-tested):

- **URL key.** The item link without scheme (`http` and `https` match), a leading `www.`, the fragment and a trailing slash; tracking parameters removed (`utm_*`, `at_medium`, `at_campaign`, `ocid`, `cmpid`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `xtor`, `ns_source`, `ns_mchannel`, `ns_campaign`, `ns_linkname`); the remaining query sorted. A site's home page (empty path, no query) gets **no key**, because feeds that link every item to the home page would otherwise hide each other.
- **Headline key.** NFKC, lower case, apostrophes of every style removed (`won't` and `won’t` match), all other punctuation and symbols turned into spaces, whitespace collapsed. Under **4 words** gets **no key**. (A headline with no spaces, such as Chinese, is one word and never matches: accepted for now.)
- Both are the first 16 hex characters of SHA-256 (`u\n…` and `h\n…` prefixes keep the two key spaces apart), the width of TID-046's keys. New nullable columns `entries.url_key` and `entries.headline_key` (migration 0006).
- **A key shared by two items of one fetch is dropped** (stored as NULL), as in the churn guard: a feed pointing many items at one page, or reusing one headline, must not hide real articles.
- **Keys are computed only for the entries that are linked** (for a first fetch, the newest 10, not all 50). An entry nobody links can never be the earlier copy of anything and is never hidden, so it gets no keys and no index rows. This holds the first-fetch import cost down (decision 6).

### 2. Not linked, rather than linked-as-hidden (AC7)

A duplicate is stored in `entries` (shared, with its content, as today) but gets **no `user_entries` row** for a user who already has the story. Nothing is lost: the row exists, and a later fetch does not resurrect it because its GUID is known.

| Option | Rows written per hidden duplicate per subscriber | List and count queries |
|---|---|---|
| **Not linked (chosen)** | 0 (saves the 6 rows of a link) | Unchanged. No `is_duplicate` filter, so no change to the partial indexes or ADR 0008's read bounds |
| Linked, marked duplicate | 6 (+1 column) | Every list and count needs `AND NOT is_duplicate`; the partial unread indexes would have to carry it |

Consequences, accepted: read state is the visible copy's alone (AC3: a duplicate that arrives after the first copy was read never becomes unread; there is no second copy to keep in step); unread counts count the story once; and if the user unsubscribes from the feed that supplied the visible copy, the story from the other feed was never linked and does not appear. That is the same as a story that was never in the other feed's first 10.

### 3. The match: one set-based statement, no extra statements

The existing fan-out `INSERT INTO user_entries … SELECT … FROM entries e JOIN subscriptions s` gains two `NOT EXISTS` conditions (`apps/worker/src/db/dedup.ts`, `notDuplicateOf`). For candidate `e` and subscriber `s`, a duplicate is an entry `d` of **another feed** that the user already has in `user_entries` and that has

- the same `url_key` and `d.published_at` within the last **7 days**; or
- the same `headline_key`, `d.published_at` within **48 hours** of `e`'s, and within the last 7 days.

Statements per refresh are unchanged (the probes are subqueries of the link statement). The `entries` insert has two more bound columns, so a statement takes 8 rows instead of 9: a 50-item first fetch costs one more insert statement at most (11 statements, limit 15; D1's 50).

Both conditions are **cross-feed only**. Within one feed, GUID and TID-046's key decide; a feed that repeats a headline within 48 hours (a daily "Morning briefing: what to know today") or links several items to one page must not hide its own items. AC5 (same URL, new content) holds: the same feed with the same GUID adds nothing as before, and another feed's copy of an updated article is the same story. A new subscription (`createSubscription`, FR-SU-3) applies the same condition when it links the newest existing entries.

Two feeds fetched concurrently cannot both hide each other: D1 serialises the batches, so the second sees the first's `user_entries`. Two copies in one fetch are not compared with each other (the shared-key rule above applies instead).

### 4. Indexes: covering, partial, one row per keyed entry

```sql
CREATE INDEX entries_url_key      ON entries(url_key, published_at, feed_id)      WHERE url_key IS NOT NULL;
CREATE INDEX entries_headline_key ON entries(headline_key, published_at, feed_id) WHERE headline_key IS NOT NULL;
```

The probe is answered from the index alone (key, published range and `feed_id` are in it); the user's ownership check is one probe of `ue_entry` (entry id, user id), also covering. `EXPLAIN QUERY PLAN` is asserted in the tests (no scan). The statement uses `INDEXED BY` with `CROSS JOIN` so the planner cannot start from `user_entries`. Measured reads: about 4 per candidate and subscriber when both keys exist (3 with one key).

### 5. Existing entries: no backfill

SQLite cannot canonicalise a URL or hash in a migration, and rewriting the entries table would cost about 3 rows written per entry (index rows) at once. Entries that exist at migration time keep NULL keys and never match. The effect fades inside the 7-day window (48 hours for headlines): for about a week after the migration, a story already linked before it can still arrive again from a second feed. Production is not deployed yet (TID-024), so the migration runs on an empty database there. The migration is tested on a populated 0005 database: every row is kept and the new columns are NULL.

### 6. Cost (measured by the tests; spec §9.4, §9.5, §9.8 updated)

- **Per new keyed entry: +2 rows written** (one per key index; 5 rows instead of 3). A hidden duplicate costs those 5 but saves the 6 per subscriber of a link.
- **Per deleted entry (maintenance): +2 rows** (the index rows go with it). The local D1 simulator does not report index deletes in `meta`, so this is the billing rule, not a measurement.
- **Per day:** scenario A (400 entries): +800 inserts +800 deletes = **+1,600 rows, 5.7%** of the 28,000 written. Scenario B (800 entries): +3,200, **4.3%** of 75,000. Under the 10% target. No saving from hidden duplicates is counted.
- **Reads:** about 4 per candidate and subscriber: +1,600 a day in A, +9,600 in B (0.2% of the read quota).
- **An OPML import of 250 feeds:** +20 rows per feed (10 linked entries × 2): **+5,000 one-time**, so import day peaks near 82% instead of 77%. Only the 10 linked entries are keyed.
- Storage: two 16-character keys per keyed entry plus two index entries, about 100 bytes per entry (≈ 5 MB at 400 a day over 30 days plus tombstones).

### 7. Not decided here (out of scope in the story)

Fuzzy headline matching, "also in: Business" on a row, and clustering of related coverage. Stripping a publisher suffix (` - BBC News`) from headlines is not done: it is a fuzzy rule and would be easy to get wrong.

## Alternatives rejected

- **Per-row lookups from the Worker.** One read statement per candidate (up to 50) against the 50-statement limit, and more round trips. The set-based statement adds none.
- **A separate `duplicates` table.** More rows written (one per hidden copy per user) for nothing the not-linked choice does not already give.
- **A single combined key.** Two different matching rules (URL anywhere in 7 days, headline within 48 hours) need separate indexes anyway.
- **Backfilling recent entries in a maintenance step.** About 3 rows written and hashing CPU per entry, for an effect that disappears by itself within 7 days and does not exist at first deploy.
