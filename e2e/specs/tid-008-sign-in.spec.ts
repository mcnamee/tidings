import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { runSql, seedOwner } from '../support/auth-state.ts';
import {
  expect,
  OWNER_NAME,
  registerOwnerSignedOut,
  test,
  useEmptyDatabase,
} from '../support/passkey-test.ts';

// TID-008: passkey sign-in through the real screens and Worker with Chromium's virtual
// authenticator, in all four projects. Each test starts from an empty database, registers the
// owner through the setup screen (so the passkey exists on both sides), and signs out.
useEmptyDatabase();

const signInButton = (page: Page) => page.getByRole('button', { name: /Sign in with a passkey/ });
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const main = (page: Page) => page.getByRole('main');

async function openLogin(page: Page) {
  await page.goto('/login');
  await expect(h1(page, 'Sign in')).toBeVisible();
  await expect(signInButton(page)).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('AC1: sign in with a passkey', () => {
  test('one tap lands on /all with a new session cookie, focus on the h1, history replaced', async ({
    page,
    context,
    authenticator,
  }) => {
    await registerOwnerSignedOut(page);
    await openLogin(page);
    // Nothing started by itself and nothing is focused.
    expect(await authenticator.credentials()).toHaveLength(1);
    await expect(page.locator(':focus')).toHaveCount(0);
    const historyBefore = await page.evaluate(() => history.length);

    await signInButton(page).click();
    await expect(page).toHaveURL(/\/all$/);
    await expect(h1(page, 'All articles')).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);

    const cookie = (await context.cookies()).find((c) => c.name === '__Host-tid_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.value.length).toBeGreaterThanOrEqual(40);
    // The challenge cookie is spent.
    expect((await context.cookies()).find((c) => c.name === '__Host-tid_chal')).toBeUndefined();

    const me = await page.request.get('/api/auth/session');
    expect(await me.json()).toMatchObject({ user: { displayName: OWNER_NAME, role: 'owner' } });
    // The signature counter was used.
    expect((await authenticator.credentials())[0]?.signCount).toBeGreaterThanOrEqual(1);
  });

  test('lands on the last list viewed on this device', async ({ page }) => {
    await registerOwnerSignedOut(page);
    await openLogin(page);
    // The stored list must exist, or "/" falls back to /all (TID-018 AC11), so give the owner a
    // real folder to come back to.
    runSql(
      "INSERT INTO folders (id, user_id, name, created_at) SELECT 'f-last', id, 'Last list', 0 FROM users LIMIT 1;",
    );
    try {
      await page.evaluate(() => localStorage.setItem('tidings.lastList', '/folders/f-last'));
      await signInButton(page).click();
      await expect(page).toHaveURL(/\/folders\/f-last$/);
    } finally {
      runSql("DELETE FROM folders WHERE id = 'f-last';");
    }
  });

  test('a signed-out visit to a shell route comes back to it after sign-in', async ({ page }) => {
    await registerOwnerSignedOut(page);
    await page.goto('/manage');
    await expect(page).toHaveURL(/\/login$/);
    await expect(h1(page, 'Sign in')).toBeVisible();
    // A first visit on this device: no "session ended" banner.
    await expect(page.getByText('Your session ended.')).toHaveCount(0);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/manage$/);
    await expect(h1(page, 'Manage feeds')).toBeFocused();
  });

  test('on a device that had a session, the redirect says it ended, and sign-in still restores the route', async ({
    page,
  }) => {
    await registerOwnerSignedOut(page);
    await page.evaluate(() => localStorage.setItem('tidings.hasSession', '1'));
    await page.goto('/feeds/s9');
    await expect(page).toHaveURL(/\/login$/);
    await expect(main(page).getByText('Your session ended. Sign in again.')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/feeds\/s9$/);
  });
});

test.describe('failures', () => {
  test('a cancelled prompt is an info banner with the recovery link; a retry succeeds', async ({
    page,
    authenticator,
  }) => {
    await registerOwnerSignedOut(page);
    await openLogin(page);
    await authenticator.setUserVerified(false); // the biometric fails: the prompt is rejected
    await signInButton(page).click();
    const info = main(page).getByRole('status').filter({ hasText: 'Sign-in was cancelled.' });
    await expect(info).toContainText(
      'Sign-in was cancelled. Try again. No passkey on this device? Use a recovery code.',
    );
    await expect(info.getByRole('link', { name: 'Use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await expect(signInButton(page)).toBeFocused();
    expect((await page.context().cookies()).some((c) => c.name === '__Host-tid_session')).toBe(
      false,
    );
    await expectNoSeriousA11yViolations(page);
    await noHorizontalScroll(page);

    await authenticator.setUserVerified(true);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/all$/);
  });

  test('a passkey the server does not know is "That passkey didn\'t work", with no session', async ({
    page,
  }) => {
    await registerOwnerSignedOut(page);
    runSql('DELETE FROM passkeys;');
    await openLogin(page);
    await signInButton(page).click();
    const banner = main(page).getByRole('alert').filter({ hasText: "That passkey didn't work." });
    await expect(banner).toContainText(
      "That passkey didn't work. Try again, or use a recovery code.",
    );
    await expect(banner.getByRole('link', { name: 'use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await expect(signInButton(page)).toBeFocused();
    expect((await page.context().cookies()).some((c) => c.name === '__Host-tid_session')).toBe(
      false,
    );
    await expect(page).toHaveURL(/\/login$/);
    await expectNoSeriousA11yViolations(page);
  });

  test('rate limited: the wait is shown and the button is blocked', async ({ page }) => {
    await registerOwnerSignedOut(page);
    await page.route('**/api/auth/login/options', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '90' },
        json: { error: { code: 'rate_limited', message: 'Too many attempts' } },
      }),
    );
    await openLogin(page);
    await signInButton(page).click();
    await expect(
      main(page)
        .getByRole('alert')
        .filter({ hasText: 'Too many attempts. Try again in 2 minutes.' }),
    ).toBeVisible();
    await expect(signInButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expectNoSeriousA11yViolations(page);
  });

  test('a browser without passkeys gets the explanation and a recovery button', async ({
    page,
  }) => {
    seedOwner(); // an owner exists, so /login is not redirected to /setup
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
    });
    await page.goto('/login');
    await expect(main(page).getByText("This browser can't use passkeys.")).toBeVisible();
    await expect(signInButton(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Use a recovery code' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('layout (login.md 7)', () => {
  test('button 48px, link 44px, no horizontal scroll, axe clean', async ({ page }) => {
    await registerOwnerSignedOut(page);
    await openLogin(page);
    expect((await signInButton(page).boundingBox())?.height).toBeGreaterThanOrEqual(47.5);
    expect(
      (await page.getByRole('link', { name: 'Lost your passkey?' }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(43.5);
    await expect(page).toHaveTitle('Sign in - Tidings');
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });
});
