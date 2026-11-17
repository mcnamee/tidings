import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { SEED_SESSION_TOKEN, SESSION_COOKIE } from './auth-state.ts';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { FIXTURE_PORT } from './ports.ts';

/**
 * Project `test`: adds a `fixtureServer` fixture (the local feed server on FIXTURE_PORT, reset before
 * each test). Specs import { test, expect } from '../support/test.ts' instead of '@playwright/test'.
 * The browser context starts signed out.
 */
export const test = base.extend<
  { fixtureServer: FixtureServer; bareRequest: APIRequestContext },
  { fixtureServerWorker: FixtureServer }
>({
  // `request` behaves like the SPA's own fetch: a browser always sends `Origin` on a POST, and the
  // Worker's CSRF check (spec 10.3) refuses a mutation without one. Specs that test that refusal
  // use `bareRequest`, which sends nothing extra, or set `Origin` per call.
  request: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext({
      ...(baseURL ? { baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } } : {}),
    });
    await use(context);
    await context.dispose();
  },
  bareRequest: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext(baseURL ? { baseURL } : {});
    await use(context);
    await context.dispose();
  },
  fixtureServerWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startFixtureServer({ port: FIXTURE_PORT });
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  fixtureServer: async ({ fixtureServerWorker }, use) => {
    fixtureServerWorker.reset();
    await use(fixtureServerWorker);
  },
});

/**
 * `test` with the browser context already signed in, for every spec that visits a shell route
 * (TID-008: the shell redirects a signed-out visitor to /login). The cookie belongs to the session
 * the server seeds at start-up (auth-state.ts), so no test goes through the passkey UI just to get
 * in. `page.request` shares it; the bare `request` fixture does not, which is how a test makes a
 * signed-out API call.
 *
 * Do not sign out with this session: tests that sign out or end their session create their own
 * with `createSession()` and `signInAs()`.
 */
export const signedInTest = test.extend({
  context: async ({ context, baseURL }, use) => {
    await signInAs(context, SEED_SESSION_TOKEN, baseURL);
    await use(context);
  },
});

/** Puts a session cookie, as the server sets it, into a browser context. */
export async function signInAs(
  context: BrowserContext,
  token: string,
  baseURL: string | undefined,
): Promise<void> {
  if (!baseURL) throw new Error('baseURL is not set');
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      // domain and path, not url: Chromium rejects a __Host- cookie added by url.
      domain: new URL(baseURL).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

/** Answers `GET /api/auth/session` as a signed-in owner, for pages served without the Worker. */
export async function mockSignedInSession(page: Page): Promise<void> {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: { id: 'e2e-seed-owner', displayName: 'Seed Owner', role: 'owner', settings: {} },
        setupRequired: false,
        mustAddPasskey: false,
      },
    }),
  );
}

export { expect };
