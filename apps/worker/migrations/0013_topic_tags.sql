-- TID-077, ADR 0021 (as amended), spec 6.1 and 7.9. Topic tagging: where an article's topics live, and
-- the system topics' embeddings for the fallback.
--
-- entries.topics: one packed integer per entry, NOT indexed (so ADD COLUMN writes nothing and tagging
-- costs one row written per article, the UPDATE). NULL = not tagged. Bits 0-7, 8-15 and 16-23 are the
-- first, second and third topic ID (most relevant first, 0 = empty slot); bits 24-25 are the source
-- (1 model, 2 embedding fallback). A value with only source bits means tagged, no topic.
ALTER TABLE entries ADD COLUMN topics INTEGER;

-- The system topics' embeddings (same model and 388-byte base64 form as entry_embeddings), recomputed
-- when a row's version is below TOPICS_VERSION. 28 rows, replaced, never swept.
CREATE TABLE topic_vectors (
  topic_id INTEGER PRIMARY KEY,
  version  INTEGER NOT NULL,
  vec      TEXT NOT NULL
) WITHOUT ROWID;

-- No backfill and no queue: the hourly tag step finds recent untagged entries itself (the newest 2,000
-- entry IDs whose topics is NULL and that are linked unread), so the entries already stored are tagged
-- by its first runs, newest first, inside the daily cap.
