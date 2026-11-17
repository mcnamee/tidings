import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Auth state of the shared local D1 between tests.
 *
 * One `wrangler dev` and one throwaway D1 serve every project, and first-run setup can only
 * succeed once per database. So the suite's resting state is "an owner exists, with one signed-in
 * session" (set when the server starts, see playwright.config.ts), which is what every spec except
 * the setup and sign-in ones expects. Those call `resetToSetupRequired()` before each test and put
 * the resting state back afterwards with `seedOwner()`.
 *
 * Signed-in specs do not go through the passkey UI each time: `signedInTest` in test.ts puts the
 * seeded session's cookie into the browser context. Specs that sign out, or end the session, use
 * `createSession()` for one of their own so the shared one survives.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(here, '../../apps/worker');
const STATE_DIR = path.resolve(here, '../.wrangler-state');

/**
 * The SETUP_TOKEN the E2E server is started with. Not a secret: it only protects a throwaway
 * local database. Real deployments use `wrangler secret put SETUP_TOKEN`.
 */
export const E2E_SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? 'e2e-only-setup-token-0123456789abcdef';

/** Resting state, used by playwright.config.ts when the server starts. */
export const SEED_OWNER_FILE = '../../e2e/support/seed-owner.sql';

export const SEED_USER_ID = 'e2e-seed-owner';

/**
 * Cookie value of the seeded session. Not a secret (throwaway database). Its SHA-256 is the
 * `id_hash` in seed-owner.sql; `e2e/test/auth-state.test.ts` keeps the two in step.
 */
export const SEED_SESSION_TOKEN = 'e2e-seed-session-token-0123456789abcdefghij';

export const SESSION_COOKIE = '__Host-tid_session';

function d1(args: string[]): void {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'tidings', '--local', '--persist-to', STATE_DIR, ...args],
    {
      cwd: WORKER_DIR,
      stdio: 'pipe',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    },
  );
}

/** Runs a read-only query against the E2E database and returns its rows (TID-053 email capture). */
export function querySql<T = Record<string, unknown>>(statement: string): T[] {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'tidings',
      '--local',
      '--persist-to',
      STATE_DIR,
      '--json',
      '--command',
      statement,
    ],
    {
      cwd: WORKER_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    },
  );
  const parsed = JSON.parse(out) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

/** Runs SQL against the E2E database. For test setup only: never build it from page input. */
export function runSql(statement: string): void {
  d1(['--command', statement]);
}

const AUTH_TABLES = [
  'sessions',
  'recovery_codes',
  'passkeys',
  'webauthn_challenges',
  'rate_limits',
  'users',
];

/** Empty database: the app reports `setupRequired: true`. Also clears rate-limit counters. */
export function resetToSetupRequired(): void {
  runSql(AUTH_TABLES.map((t) => `DELETE FROM ${t};`).join(' '));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** SQL that inserts a session for `userId` valid from now, with a given cookie token. */
export function sessionInsertSql(
  token: string,
  userId: string,
  expiresInSeconds = 2592000,
): string {
  const now = "CAST(strftime('%s', 'now') AS INTEGER)";
  return (
    'INSERT INTO sessions (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at, user_agent, auth_method) ' +
    `VALUES ('${sha256Hex(token)}', '${userId}', ${now}, ${now}, ${now} + ${expiresInSeconds}, ${now} + 15552000, 'e2e', 'passkey');`
  );
}

/** Resting state: one owner and one signed-in session (SEED_SESSION_TOKEN). */
export function seedOwner(): void {
  resetToSetupRequired();
  runSql(
    `INSERT INTO users (id, display_name, role, created_at) VALUES ('${SEED_USER_ID}', 'Seed Owner', 'owner', 1760000000); ` +
      sessionInsertSql(SEED_SESSION_TOKEN, SEED_USER_ID),
  );
}

/**
 * A session of its own for the seeded owner, for a test that signs out or ends it. Returns the
 * cookie value. The token is random hex, so it is safe to put in SQL.
 */
export function createSession(expiresInSeconds?: number): string {
  const token = `e2e-${randomBytes(24).toString('hex')}`;
  runSql(sessionInsertSql(token, SEED_USER_ID, expiresInSeconds));
  return token;
}

/** Deletes one session row, as the server would on sign out or expiry. */
export function deleteSessionRow(token: string): void {
  runSql(`DELETE FROM sessions WHERE id_hash = '${sha256Hex(token)}';`);
}
