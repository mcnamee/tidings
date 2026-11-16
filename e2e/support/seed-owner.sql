-- Resting state of the E2E database: one owner, nobody signed in (see auth-state.ts).
INSERT INTO users (id, display_name, role, created_at)
VALUES ('e2e-seed-owner', 'Seed Owner', 'owner', 1760000000);
