-- TID-061, ADR 0017, spec 6.3. Cross-feed duplicate keys: 16 hex characters each, computed by the
-- Worker at insert time (SQLite cannot canonicalise a URL or hash). Both are NULL when the entry has
-- nothing safe to match on (no usable link, or a headline under 4 words), and for every entry that
-- already exists: there is no backfill, so older rows never match and the effect fades within the
-- 7-day lookup window. ADD COLUMN and creating these indexes on existing rows write no index rows.
ALTER TABLE entries ADD COLUMN url_key TEXT;
ALTER TABLE entries ADD COLUMN headline_key TEXT;

-- Covering for the lookup: (key, published_at range, feed_id) is answered from the index alone, and
-- the matching user_entries row is one primary-key probe. Partial, so keyless entries cost nothing.
-- Each adds one row written per keyed new entry (and one per delete).
CREATE INDEX entries_url_key ON entries(url_key, published_at, feed_id) WHERE url_key IS NOT NULL;
CREATE INDEX entries_headline_key ON entries(headline_key, published_at, feed_id)
  WHERE headline_key IS NOT NULL;
