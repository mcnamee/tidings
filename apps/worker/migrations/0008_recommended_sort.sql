-- TID-067, ADR 0018 (stage 2), spec 6.3. Recommended sort: embeddings, the interest profile and the
-- work queue that fills them. Existing rows are untouched (ADD COLUMN writes nothing).
--
-- entry_embeddings: one compact vector per embedded entry, as base64 TEXT (not BLOB: D1 hands a BLOB
-- to the Worker as a JSON array of 388 integers: measured 4 ms against under 1 ms to parse 1,000 rows).
-- The text is a 4-byte float32 scale followed by 384 int8 values, 388 bytes, 520 base64 characters.
-- Cascades from entries, and maintenance also drops it when the entry's content is purged.
CREATE TABLE entry_embeddings (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  vec      TEXT NOT NULL
) WITHOUT ROWID;

-- embed_queue: entries that were linked to a user and wait for an embedding (inserted by the refresh
-- fan-out and by a new subscription, drained by the embed step). `tries` counts failed AI calls;
-- three failures park the row (it stays, unread, until the entry is deleted).
CREATE TABLE embed_queue (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  tries    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- The signal carries the entry's embedding (copied when recorded, or filled in later), so the
-- profile survives the entry's purge. Same text format as entry_embeddings.vec.
ALTER TABLE engagement ADD COLUMN embedding TEXT;
-- The profile reads a user's most recent signals. One extra index row per signal write (spec 9.4).
CREATE INDEX engagement_user_last ON engagement(user_id, last_at);

-- user_profiles: the per-user interest profile, a unit vector as base64 float32 (1,536 bytes).
-- `signals` is how many signals fed it; below the minimum the list stays newest first.
CREATE TABLE user_profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vec         TEXT NOT NULL,
  signals     INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
) WITHOUT ROWID;
