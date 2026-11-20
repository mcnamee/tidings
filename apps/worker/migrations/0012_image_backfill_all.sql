-- TID-072 (owner request, 2026-11-20): one-time backfill that also covers READ entries, now that the
-- image step enriches read entries too (they still show in All, Starred and folders). Queues entries
-- fetched in the last 3 days with no image, a plain-http image or a URL that looks weak (0010/0011
-- patterns). Newest 500 at most, about 500 rows written once; the 600-page daily cap bounds the work.
INSERT OR IGNORE INTO image_queue (entry_id)
SELECT e.id FROM entries e
 WHERE e.url IS NOT NULL AND e.purged_at IS NULL
   AND e.fetched_at >= CAST(strftime('%s', 'now') AS INTEGER) - 259200
   AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id)
   AND (
        e.image_url IS NULL
     OR lower(e.image_url) GLOB 'http:*'
     OR instr(lower(e.image_url), 'icon') > 0
     OR instr(lower(e.image_url), 'logo') > 0
     OR instr(lower(e.image_url), 'favicon') > 0
     OR instr(lower(e.image_url), 'avatar') > 0
     OR instr(lower(e.image_url), 'gravatar') > 0
     OR instr(lower(e.image_url), 'sprite') > 0
     OR instr(lower(e.image_url), 'placeholder') > 0
     OR instr(lower(e.image_url), '/topics/') > 0
     OR instr(lower(e.image_url), '/topic/') > 0
     OR lower(e.image_url) GLOB '*[_-][0-9][0-9].[a-z][a-z][a-z]*'
     OR lower(e.image_url) GLOB '*[_-][12][0-9][0-9].[a-z][a-z][a-z]*'
     OR lower(e.image_url) GLOB '*[_-][0-9][0-9]x[0-9]*'
     OR lower(e.image_url) GLOB '*[_-][12][0-9][0-9]x[0-9]*'
   )
 ORDER BY e.id DESC
 LIMIT 500;
