import { defineConfig } from 'vitest/config';

// Node tests. `*.workers.test.ts` need the real HTMLRewriter and run under vitest.workers.config.ts.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.workers.test.ts'] },
});
