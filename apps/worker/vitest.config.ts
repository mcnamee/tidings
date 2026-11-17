import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
// @ts-expect-error plain .mjs script without type declarations
import { buildSeedSql } from './scripts/seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Every Worker test runs inside workerd against a local D1. Migrations in
// ./migrations are read here (Node side) and applied per test file by
// test/setup.ts, on top of the per-file isolated storage the pool provides.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SEED_SQL: (buildSeedSql as () => string)(),
            // A throwaway value for tests only; production sets the real secret with wrangler.
            SETUP_TOKEN: 'test-setup-token-0123456789abcdef-xyz',
            // A fake address for tests only (TID-053). The real one is a wrangler secret.
            MAGIC_LINK_EMAIL: 'owner@example.test',
            RESEND_API_KEY: 're_test_not_a_real_key',
          },
        },
      }),
    ],
    test: {
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
