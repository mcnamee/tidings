-- TID-021, spec 6.5 and 7.6. Indexes the hourly maintenance job needs so that every statement reads
-- about as many rows as it deletes (no table scans), chosen to add as few rows written as possible.

-- Retention of read items: only read, unstarred rows are in it, so an insert of an unread row
-- writes nothing extra and marking read adds one row written.
CREATE INDEX ue_read_old ON user_entries(published_at) WHERE is_read = 1 AND is_starred = 0;

-- FK cascade (entries -> user_entries) and the "no user references this entry" check. Without it
-- every entry delete scans user_entries. Adds one row written per new user_entries row.
CREATE INDEX ue_entry ON user_entries(entry_id);

-- Purge candidates: only entries still holding content. Same name and same write count as before
-- (one row per new entry); purged rows leave it, so tombstones are never re-scanned.
DROP INDEX entries_published;
CREATE INDEX entries_published ON entries(published_at) WHERE purged_at IS NULL;

-- Tombstone expiry. A row enters it once, when it is purged.
CREATE INDEX entries_tombstones ON entries(purged_at) WHERE purged_at IS NOT NULL;
