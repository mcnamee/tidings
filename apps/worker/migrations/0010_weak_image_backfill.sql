-- TID-072, ADR 0020. One-time backfill for the entries already in production whose stored image
-- looks weak by its URL alone (an icon, logo, avatar, sprite, topic artwork or a small size baked
-- into the name, such as Slashdot's twitter_icon_large.png and topics/china_64.png): queue them so
-- the image step looks for a better picture (the article page, then the entry's outbound link).
--
-- Unread, fetched in the last 3 days, newest 300 at most (about 300 rows written, once). Nothing in
-- `entries` is touched here. The step replaces an image only with a better one, and clears it when
-- it is an icon or default and nothing better exists. Entries already queued are left as they are.
INSERT OR IGNORE INTO image_queue (entry_id)
SELECT e.id FROM entries e
 WHERE e.image_url IS NOT NULL AND e.url IS NOT NULL AND e.purged_at IS NULL
   AND e.fetched_at >= CAST(strftime('%s', 'now') AS INTEGER) - 259200
   AND EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id AND ue.is_read = 0)
   AND (
        instr(lower(e.image_url), 'icon') > 0
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
 LIMIT 300;
