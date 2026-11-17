-- TID-053 / ADR 0016: emailed one-time sign-in links.
-- Only the SHA-256 of the token is stored. At most one live link per user (the request handler
-- deletes earlier ones).
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX magic_links_user ON magic_links(user_id);

-- SQLite cannot change a CHECK in place: copy, drop, rename (documented 12-step procedure).
PRAGMA defer_foreign_keys = true;
CREATE TABLE sessions_new (
  id_hash          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  user_agent       TEXT,
  auth_method      TEXT NOT NULL DEFAULT 'passkey'
    CHECK (auth_method IN ('setup','passkey','recovery','email'))
);
INSERT INTO sessions_new
  (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method)
  SELECT id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method
  FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_user ON sessions(user_id);
