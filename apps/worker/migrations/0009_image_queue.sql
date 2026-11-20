-- TID-071, ADR 0019, spec 6.1. Preview images for articles whose feed gave none: the work queue
-- the image step drains (a few article pages per run, in its own invocation).
--
-- One row per entry that was linked unread, has a url and no image. The refresh inserts it once, when
-- the entry is first stored (INSERT OR IGNORE; entries are never re-inserted, so a row that was
-- processed and deleted is never queued again: every page is tried at most once, success or failure).
-- The step deletes the row when it has tried, skipped (read, old, has an image) or given up on the
-- entry. Cost per enriched entry: 3 rows written (insert, UPDATE entries.image_url, delete); 2 for a
-- failed page. No index beyond the primary key, which in a WITHOUT ROWID table is the row itself.
CREATE TABLE image_queue (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- One-time backfill for the entries already in production: unread, no image, fetched in the last 3
-- days, newest 300 at most (about 300 rows written, once).
INSERT OR IGNORE INTO image_queue (entry_id)
SELECT e.id FROM entries e
 WHERE e.image_url IS NULL AND e.url IS NOT NULL AND e.purged_at IS NULL
   AND e.fetched_at >= CAST(strftime('%s', 'now') AS INTEGER) - 259200
   AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0)
 ORDER BY e.id DESC
 LIMIT 300;
