# 0008. List query read budgets: continuation pages and the folder view

- Status: Accepted
- Date: 2026-11-16
- Deciders: product-manager

## Context

TID-004's integration tests measured D1 `meta.rows_read` for the list queries in spec §8.6 on the seed data (500 entries, 10 feeds, 3 folders):

- All-unread, `limit` 50: page 1 reads 102 rows (= NFR-7's (limit + 1) × 2). Page 2+ reads **103** (DEF-001). The likely cause is that the row-value seek `(published_at, entry_id) < (?, ?)` uses only `published_at` as the index range bound. Rows at the boundary timestamp (at least the cursor row itself) are then read and discarded. Not independently confirmed.
- Folder view, `limit` 50, a 150-entry folder: **211** rows. The folder filter is `feed_id IN (SELECT … FROM subscriptions …)`, so SQLite seeks each feed's index range and sorts. A page reads every matching row in the folder below the cursor, plus (limit + 1) `entries` rows for the join, plus the folder's subscriptions. Cost grows with folder size.

Migration 0001 isn't deployed anywhere yet, so a schema change is still cheap. That is why this is decided now.

Undated items get `published_at = fetched_at` (§6.5), so up to 50 entries from one fetch can share a timestamp. Boundary ties are therefore real, not just theoretical.

## Options

**DEF-001 (continuation pages)**

1. Relax NFR-7 for continuation pages by the number of boundary rows.
2. Rewrite the seek as `published_at < ?p OR (published_at = ?p AND entry_id < ?i)`. SQLite may not keep a single ordered index range for an OR, so this could read more, not less. It would need its own spike for a saving of one row per page.

**Folder view**

1. Denormalise `folder_id` into `user_entries` with `ue_folder` and `ue_unread_folder` indexes. Folder pages would read ≤ (limit + 1) × 2. Costs: +2 rows written per new `user_entries` row (5 → 7) and +1 per mark-read. That is about +2,100 writes/day in scenario A (+2%) and +8,700 in B (+9%, taking B from 67% to about 76% of the scarcest quota). Moving a feed to another folder or deleting a folder rewrites every `user_entries` row for those feeds, about 3 rows written each. And a single `folder_id` column can't represent M3's multiple folders per feed (TID-043), so it would be redone then.
2. Accept the cost with a stated ceiling and a revisit trigger.

## Decision

**DEF-001: option 1.** NFR-7 becomes, for All and Feed views:

> rows_read ≤ (limit + 1) × 2 + T, where T = the number of the user's rows in the view whose `published_at` equals the cursor's `p` (T = 0 on the first page; T ≥ 1 on continuation pages because the cursor row itself is counted).

With unique timestamps that is 103 for `limit` 50. With a full tie group from one undated fetch it is at most 102 + 50. DEF-001 is resolved as "won't fix: budget relaxed". The tester keeps the ≤ 103 assertion for the seed data and adds a tied-timestamp case.

**Folder view: option 2, no denormalisation.** Writes are our scarcest daily quota (spec §9.8), reads are not (17% / 35%), and the schema would have to change again for tags in M3. Stated ceiling (new NFR-7b):

> Folder view: rows_read ≤ M + (limit + 1) + S + 10, where M = the user's `user_entries` in that folder matching the state filter (and, on continuation pages, at or below the cursor), and S = subscriptions in the folder. Observed 211 for M = 150, S = 3 (bound 214).

What that means at our load:

| Folder | Unread-only mode (default) | All-articles mode |
|---|---|---|
| Typical (≈ 15 feeds of 250, ≈ 25 new/day) | ≤ 1,000 unread backlog → ≤ ≈ 1,070 rows/page | ≈ 25 × 30 days ≈ 750 → ≈ 830 rows/page |
| Worst case (one folder holds every feed) | ≤ ≈ 1,070 rows/page | ≈ 12,000 retained entries → ≈ 12,100 rows/page |

Daily reads: the §9.5 allowance of 50 folder pages × 3,000 rows (150,000/day, 3% of the read quota) stays. Even the worst case (50 pages × 12,100 ≈ 605,000/day, 12%) fits, taking scenario A to about 26% of reads.

**Revisit trigger:** open an ADR to add a folder index (designed to work with M3 tags, for example a `user_entry_folders` side table) if any of these happen:
- D1 rows read exceed 50% of the daily quota on any day;
- `GET /api/entries?view=folder` p95 server time exceeds 200 ms (NFR-4) at baseline data;
- TID-043 (tags) is scheduled.

## Consequences

- Spec §8.6 and NFR-7 are updated. Migration 0001 is unchanged.
- TID-004 AC5 is amended; TID-018 AC5 gains the folder ceiling and a tied-timestamp case. The tester updates DEFECTS.md (DEF-001 → Won't fix) and the test comments.
- Folder pages stay O(folder size). The cost is reads, which we have plenty of; writes are untouched.

## Amendment 2026-11-17 (TID-049, DEF-050)

The folder query above read far more than its ceiling: the planner walked the user's whole unread or all view newest first, with a primary-key lookup per row to read `feed_id`, until it found `limit + 1` rows in the folder. Cost followed the view size and the folder's density, not M (measured 303 rows for a sparse folder, M = 75). The owner approved option (a): no migration, no extra writes.

**Query.** Keys first: select `(feed_id, published_at, entry_id)` for the folder's feeds from the covering partial index `ue_unread_feed` (unread) or `ue_feed` (all), ordered and limited to `limit + 1`; then join `user_entries` by primary key and `entries` by rowid for those keys only. Same rows, order and cursor rule as before (`(published_at, entry_id) < (?, ?)`); every step is scoped by `user_id`.

**Restated bound (NFR-7b).** Folder view: rows_read ≤ M + 3 × (limit + 1) + S + 20, M and S as above. The three terms of the page: the key scan reads about M keys, the sorter returns `limit + 1` keys, and the join reads two rows per key. ADR 0015 proposed `+ 10`; the measured overhead (sorter output slightly above `limit + 1`, one extra index read per feed seek, two reads per subscription for index plus row) needed `+ 20`. Margin is 4 to 8 rows on the tightest seed cases.

**Measured (`rows_read`, D1 local, limit 50, page 1), before then after:**

| Seed case | M | Before | After |
|---|---|---|---|
| seed-folder-1 unread | 125 | 211 | 290 |
| seed-folder-2 unread | 100 | 246 | 258 |
| seed-folder-3 unread | 75 | 303 | 244 |
| seed-folder-1 all | 150 | 225 | 300 |

The change helps sparse folders, and costs a dense folder about 100 more rows than before (the join back is 2 reads per page row, which the old plan got from the same walk). It is predictable: the cost no longer depends on the rest of the user's view. At the spec's scale (50 folder pages a day) the difference is a few thousand rows a day against a 5,000,000 quota. The All and Feed views are unchanged.
