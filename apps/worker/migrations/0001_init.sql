-- ── Users & auth ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  settings_json TEXT NOT NULL DEFAULT '{}',   -- validated by zod (UserSettings)
  created_at    INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,             -- credential ID, base64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                         -- JSON array
  device_type   TEXT,                         -- 'singleDevice' | 'multiDevice'
  backed_up     INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,               -- also stored in a short-lived __Host- cookie
  user_id     TEXT,                           -- NULL for setup and sign-in
  purpose     TEXT NOT NULL CHECK (purpose IN ('setup','login','add_passkey')),
  challenge   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL                -- now + 300
);

CREATE TABLE recovery_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,           -- hex SHA-256 of normalised code
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE sessions (
  id_hash          TEXT PRIMARY KEY,          -- hex SHA-256 of the cookie token; raw token never stored
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,          -- last passkey/recovery auth, for step-up checks
  expires_at       INTEGER NOT NULL,          -- sliding, see §10.2
  absolute_expires_at INTEGER NOT NULL,
  user_agent       TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE rate_limits (                    -- fixed-window counters for auth endpoints
  key           TEXT PRIMARY KEY,             -- e.g. 'recover:ip:203.0.113.9'
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- ── Feeds (shared) ───────────────────────────────────────────
CREATE TABLE feeds (
  id                 INTEGER PRIMARY KEY,
  url                TEXT NOT NULL UNIQUE,    -- canonical, §6.4
  site_url           TEXT,
  title              TEXT,
  description        TEXT,
  etag               TEXT,
  last_modified      TEXT,
  body_hash          TEXT,                    -- SHA-256 of last 200 body
  fetch_interval_s   INTEGER NOT NULL DEFAULT 1800,
  next_fetch_at      INTEGER NOT NULL,        -- deliberately NOT indexed, see §9.4
  last_attempt_at    INTEGER,
  last_success_at    INTEGER,                 -- last 200 or 304 after an error, or last 200 with changes
  last_new_entry_at  INTEGER,
  error_count        INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,                    -- 'http_404','timeout','too_large','parse_error','cpu_limit','blocked_address',...
  last_status        INTEGER,
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','ok','failing','dead','gone')),
  created_at         INTEGER NOT NULL
);

-- ── Per-user organisation ───────────────────────────────────
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL COLLATE NOCASE,
  position    INTEGER NOT NULL DEFAULT 0,     -- unused in MVP (alphabetical), used in M2
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id       INTEGER NOT NULL REFERENCES feeds(id),
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title_override TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, feed_id)
);
CREATE INDEX subscriptions_feed ON subscriptions(feed_id);          -- fan-out to subscribers
CREATE INDEX subscriptions_user_folder ON subscriptions(user_id, folder_id);

-- ── Articles (shared) ────────────────────────────────────────
CREATE TABLE entries (
  id            INTEGER PRIMARY KEY,
  feed_id       INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid_hash     TEXT NOT NULL,                -- dedup key, §6.3
  url           TEXT,                         -- http(s) only, else NULL
  title         TEXT,
  author        TEXT,
  summary       TEXT,                         -- plain text, ≤ 300 chars
  content_html  TEXT,                         -- raw, UNSANITISED, ≤ 100 KB; NULL after purge
  image_url     TEXT,                         -- http(s) only
  published_at  INTEGER NOT NULL,             -- clamped to ≤ fetched_at
  fetched_at    INTEGER NOT NULL,
  purged_at     INTEGER,                      -- content removed; row kept as dedup tombstone
  UNIQUE (feed_id, guid_hash)
);
CREATE INDEX entries_published ON entries(published_at);           -- cleanup scans

-- ── Per-user article state ───────────────────────────────────
CREATE TABLE user_entries (
  user_id      TEXT NOT NULL,
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  feed_id      INTEGER NOT NULL,              -- denormalised for view filters
  published_at INTEGER NOT NULL,              -- denormalised for ordering
  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0,    -- M2 UI; column exists now
  read_at      INTEGER,
  PRIMARY KEY (user_id, entry_id)
) WITHOUT ROWID;
CREATE INDEX ue_all        ON user_entries(user_id, published_at DESC, entry_id DESC);
CREATE INDEX ue_feed       ON user_entries(user_id, feed_id, published_at DESC, entry_id DESC);
CREATE INDEX ue_unread_all ON user_entries(user_id, published_at DESC, entry_id DESC) WHERE is_read = 0;
CREATE INDEX ue_unread_feed ON user_entries(user_id, feed_id, published_at DESC, entry_id DESC) WHERE is_read = 0;
