-- TID-046, ADR 0013 decision 2, spec §6.5. GUID churn guard: the previous fetch's secondary keys
-- and a per-UTC-day counter of new entries. No index: the columns ride on the feed UPDATE a
-- changed fetch already makes, so they add no rows written.
ALTER TABLE feeds ADD COLUMN recent_keys TEXT;            -- JSON array of short hashes, at most 50
ALTER TABLE feeds ADD COLUMN new_entries_day INTEGER;     -- UTC day number (unix seconds / 86400)
ALTER TABLE feeds ADD COLUMN new_entries_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feeds ADD COLUMN warning_code TEXT
  CHECK (warning_code IS NULL OR warning_code IN ('new_item_cap'));
