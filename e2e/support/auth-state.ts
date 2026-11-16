import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Auth state of the shared local D1 between tests.
 *
 * One `wrangler dev` and one throwaway D1 serve every project, and first-run setup can only
 * succeed once per database. So the suite's resting state is "an owner exists" (set when the
 * server starts, see playwright.config.ts), which is what every spec except the setup ones
 * expects. Setup specs call `resetToSetupRequired()` before each test and put the owner back
 * afterwards with `seedOwner()`.
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
  d1(['--command', AUTH_TABLES.map((t) => `DELETE FROM ${t};`).join(' ')]);
}

/** Resting state: one owner, nobody signed in. */
export function seedOwner(): void {
  resetToSetupRequired();
  d1([
    '--command',
    "INSERT INTO users (id, display_name, role, created_at) VALUES ('e2e-seed-owner', 'Seed Owner', 'owner', 1760000000);",
  ]);
}
