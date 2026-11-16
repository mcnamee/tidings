# 0003. Data store: D1 only, raw SQL, shared feeds with per-user article state

- Status: Accepted
- Date: 2026-11-16
- Deciders: product-manager

## Context

We need relational queries (unread counts per feed and folder, keyset pagination, joins) within the Free plan: D1 gives 5M rows read and 100k rows written per day and 500 MB per database; KV gives only 1,000 writes per day. Every index costs one extra row written per insert.

## Options

1. D1 only.
2. D1 + KV cache for lists/counts.
3. Durable Objects (SQLite) per user.

ORM vs raw SQL: Drizzle/Kysely vs prepared statements behind typed functions.

## Decision

- **D1 only.** No KV in MVP: its write quota is too small to be a useful cache, and TanStack Query plus IndexedDB persistence makes the client fast.
- **Raw SQL** in `apps/worker/src/db`, parameterised, with every user-data function taking `userId` first. Our budget is measured in rows read/written, so every query and index must be explicit and testable via `meta.rows_read`.
- **Shape:** `feeds` and `entries` are shared and deduplicated (one fetch per feed, however many subscribers); per-user state lives in `user_entries` (one row per user per article, created at ingestion) with partial indexes on `is_read = 0`. Unread counts read only unread rows.
- **No index on `feeds.next_fetch_at`**: the per-minute scan costs ~360k reads/day (7%) whereas the index would cost ~12k writes/day (12%), and writes are scarcer.
- **Dedup** by `UNIQUE(feed_id, guid_hash)`; purged entries remain as tombstones for 180 days so they aren't re-added.

## Consequences

- Writes are the first daily quota we'd approach (spec §9.4): ~25% at baseline.
- Folder views can't use index order across an `IN` list and read the whole folder's rows; acceptable at our scale, and denormalising `folder_id` is a known optimisation.
- Schema changes go through numbered migrations (`wrangler d1 migrations`).
