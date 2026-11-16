-- ADR 0010 item 1. How the session was created, so GET /api/auth/session can tell a
-- recovery-code session (which gets the "Add a new passkey" banner) from the rest.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'passkey'
  CHECK (auth_method IN ('setup','passkey','recovery'));
