import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

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
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
