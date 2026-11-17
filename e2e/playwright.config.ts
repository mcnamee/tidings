import { defineConfig } from '@playwright/test';
import { E2E_SETUP_TOKEN, SEED_OWNER_FILE } from './support/auth-state.ts';
import { FIXTURE_PORT } from './support/ports.ts';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8788);
const baseURL = `http://localhost:${APP_PORT}`;
const CI = !!process.env.CI;

const mobile = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};
const desktop = { viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: './specs',
  // One app instance and one local D1 are shared by every project, and the fixture feed server
  // listens on a fixed port, so tests run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Cloud sessions can't download Playwright's Chromium, so use a preinstalled Chrome when set.
    ...(process.env.CHROME_PATH
      ? { launchOptions: { executablePath: process.env.CHROME_PATH } }
      : {}),
  },
  projects: [
    { name: 'mobile-light', use: { browserName: 'chromium', ...mobile, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { browserName: 'chromium', ...mobile, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { browserName: 'chromium', ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { browserName: 'chromium', ...desktop, colorScheme: 'dark' } },
  ],
  // Builds the SPA, then serves SPA + Worker + a throwaway local D1 from one `wrangler dev`.
  // APP_ORIGIN must be http://localhost:* for ALLOW_FETCH_HOSTS to be accepted (spec §10.3).
  webServer: {
    command:
      'rm -rf .wrangler-state && ' +
      // The OPML preview mirrors the server's ALLOW_FETCH_HOSTS (TID-016 fix batch).
      `VITE_ALLOW_FETCH_HOSTS=127.0.0.1:${FIXTURE_PORT} npm run build -w @tidings/web && ` +
      'npm run db:migrate:local -w @tidings/worker -- --persist-to ../../e2e/.wrangler-state && ' +
      'cd ../apps/worker && ' +
      // Resting state: an owner exists, so only the setup specs see a fresh instance (auth-state.ts).
      `wrangler d1 execute tidings --local --persist-to ../../e2e/.wrangler-state --file ${SEED_OWNER_FILE} && ` +
      `wrangler dev --port ${APP_PORT} --infer-origin-from-routes=false --persist-to ../../e2e/.wrangler-state ` +
      `--var APP_ORIGIN:${baseURL} --var RP_ID:localhost --var RP_NAME:Tidings-E2E ` +
      // Passed here, not read from apps/worker/.dev.vars, so a developer's real token is never used.
      `--var SETUP_TOKEN:${E2E_SETUP_TOKEN} ` +
      // TID-053: a fake recipient, and capture mode (outgoing mail is recorded in D1, never sent;
      // the Worker honours it only for a http://localhost origin).
      '--var MAGIC_LINK_EMAIL:owner@example.test --var E2E_CAPTURE_EMAIL:1 ' +
      `--var ALLOW_FETCH_HOSTS:127.0.0.1:${FIXTURE_PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    env: { WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
