-- TID-066, ADR 0018, spec 6.3. The owner's engagement signals: one row per user x entry, holding
-- when the entry was opened in the article view and when its original website was opened. Points
-- are derived (opened 1 + clicked 2, each counted once), never stored. Deliberately no foreign key
-- to entries or feeds: the row must outlive the entry's content purge and tombstone. It carries a
-- copy of the entry's title, feed_id, url and url_key taken at write time, which is what a later
-- ranker needs. No secondary index: the 180-day retention sweep scans this small table once a day,
-- which costs far fewer rows than a second index row written on every signal (spec 9.4).
CREATE TABLE engagement (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id   INTEGER NOT NULL,
  feed_id    INTEGER NOT NULL,
  title      TEXT,
  url        TEXT,
  url_key    TEXT,
  opened_at  INTEGER,                 -- first open, epoch seconds; NULL = never opened
  clicked_at INTEGER,                 -- first click-through to the original; NULL = never
  last_at    INTEGER NOT NULL,        -- latest of the two; the retention clock
  PRIMARY KEY (user_id, entry_id)
) WITHOUT ROWID;
