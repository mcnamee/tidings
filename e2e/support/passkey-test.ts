import { type Page } from '@playwright/test';
import { E2E_SETUP_TOKEN, resetToSetupRequired, seedOwner } from './auth-state.ts';
import { expect, test as base } from './test.ts';
import {
  addVirtualAuthenticator,
  type VirtualAuthenticator,
  type VirtualAuthenticatorOptions,
} from './virtual-authenticator.ts';

/**
 * `test` for specs that need a real passkey: a virtual authenticator, and an owner whose passkey
 * is stored on both sides (registered through the real setup screen), signed out.
 *
 * Setup can succeed once per database, so every test starts from an empty one and the resting
 * state is restored afterwards (see auth-state.ts). Call `useEmptyDatabase()` once per spec file.
 */
export const test = base.extend<{
  authenticator: VirtualAuthenticator;
  newAuthenticator: (options?: VirtualAuthenticatorOptions) => Promise<VirtualAuthenticator>;
  ensureAuthenticator: void;
}>({
  newAuthenticator: async ({ page }, use) => {
    const made: VirtualAuthenticator[] = [];
    await use(async (options) => {
      const a = await addVirtualAuthenticator(page, options);
      made.push(a);
      return a;
    });
    for (const a of made) await a.remove().catch(() => undefined);
  },
  authenticator: async ({ newAuthenticator }, use) => {
    await use(await newAuthenticator());
  },
  // Fixtures are lazy: this one runs for every test, so each has an authenticator, not only the
  // ones that name it (setup needs it to create the passkey).
  ensureAuthenticator: [
    async ({ authenticator }, use) => {
      void authenticator;
      await use();
    },
    { auto: true },
  ],
});

export function useEmptyDatabase(): void {
  test.beforeEach(() => resetToSetupRequired());
  test.afterAll(() => seedOwner());
}

export const OWNER_NAME = 'Matt E2E';

/** The real setup journey: creates the owner and a passkey on the authenticator, ends signed in. */
export async function registerOwner(page: Page): Promise<void> {
  await page.goto('/setup');
  await page.getByLabel('Your name').fill(OWNER_NAME);
  await page.getByLabel('Setup token', { exact: true }).fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Save your recovery codes' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: "I've saved these" }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/all$/);
}

/**
 * An owner with a passkey, signed out on a device that has never had a session: the browser
 * cookie and the device hint are dropped, the passkey stays on the authenticator and in D1.
 */
export async function registerOwnerSignedOut(page: Page): Promise<void> {
  await registerOwner(page);
  // Clear this origin's storage, then leave the app before dropping the cookie. Otherwise the
  // open /all page sees the session end, redirects itself to /login with a "return to /all"
  // state, and on a slow runner that history state survives the test's own goto('/login')
  // (same URL), so sign-in returns to /all instead of the stored list.
  await page.evaluate(() => localStorage.clear());
  await page.goto('about:blank');
  await page.context().clearCookies();
  // Back on the app origin with a fresh document, so callers can use storage straight away.
  await page.goto('/login');
}

export { expect };
