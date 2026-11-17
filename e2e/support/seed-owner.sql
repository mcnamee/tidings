-- Resting state of the E2E database: one owner with one long-lived signed-in session whose cookie
-- value is SEED_SESSION_TOKEN (see auth-state.ts; e2e/test/auth-state.test.ts checks the hash).
INSERT INTO users (id, display_name, role, created_at)
VALUES ('e2e-seed-owner', 'Seed Owner', 'owner', 1760000000);

INSERT INTO sessions
  (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method)
VALUES (
  'ebe35faa9ec395263418089f7831c98619af8d7a1f7471b9d24553137c2c90a9',
  'e2e-seed-owner',
  CAST(strftime('%s', 'now') AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER) + 2592000,
  CAST(strftime('%s', 'now') AS INTEGER) + 15552000,
  'e2e seed session',
  'passkey'
);
