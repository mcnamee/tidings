import { defineConfig } from 'vitest/config';

// Node unit tests for the E2E support code and fixtures. Playwright specs live in ./specs and are
// run by `npm run test:e2e`, never by vitest.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
