import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { runSql, seedOwner, SEED_USER_ID, sha256Hex } from '../support/auth-state.ts';
import { expect, test } from '../support/passkey-test.ts';

// TID-009: sign in with a recovery code, then add a passkey on the same device (the work
// computer), through the real screens and Worker. Starts from the resting state (an owner exists,
// nobody signed in) plus ten known recovery codes.
const CODES = Array.from(
  { length: 10 },
  (_, i) => `K${i}Q2-M9XD-4TRP-8WZ${i}`, // digits stand in for the alphabet: all valid Crockford characters
);

test.beforeEach(() => {
  seedOwner(); // also clears rate-limit counters
  const rows = CODES.map(
    (code, i) =>
      `('e2e-rc-${i}', '${SEED_USER_ID}', '${sha256Hex(code.replace(/-/g, ''))}', 1760000000)`,
  ).join(', ');
  runSql(`INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES ${rows};`);
});
test.afterAll(() => seedOwner());

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const banner = (page: Page) => page.getByTestId('passkey-banner');

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function submitCode(page: Page, code: string) {
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('golden path: recover (any case, no dashes), banner persists across reload, add a passkey, sign in with it', async ({
  page,
  context,
  authenticator,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Lost your passkey?' }).click();
  await expect(page).toHaveURL(/\/recover$/);
  await expect(h1(page, 'Use a recovery code')).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Recovery code' });
  expect((await field.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  // Lower case, no dashes (AC1).
  await submitCode(page, CODES[0]!.replace(/-/g, '').toLowerCase());
  await expect(page).toHaveURL(/\/all$/);
  await expect(h1(page, 'All articles')).toBeFocused();
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-tid_session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, path: '/' });

  // The persistent banner, with how many codes are left.
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText('You signed in with a recovery code.');
  await expect(banner(page)).toContainText('9 of 10 recovery codes left.');
  await expectNoSeriousA11yViolations(page);
  await noHorizontalScroll(page);
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session).toMatchObject({ mustAddPasskey: true, recoveryCodesRemaining: 9 });

  // It survives navigation and a reload (the flag comes from the server).
  await page.goto('/manage');
  await expect(banner(page)).toBeVisible();
  await page.reload();
  await expect(banner(page)).toBeVisible();

  // Add the passkey right here.
  expect(await authenticator.credentials()).toHaveLength(0);
  await page.getByRole('button', { name: 'Add a new passkey' }).click();
  await expect(page.getByText('Passkey added. You can sign in with it next time.')).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  expect(await authenticator.credentials()).toHaveLength(1);
  await page.reload();
  await expect(h1(page, 'Manage feeds')).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  expect(await (await page.request.get('/api/auth/session')).json()).toMatchObject({
    mustAddPasskey: false,
  });

  // The new passkey signs in from a clean browser state.
  await context.clearCookies();
  await page.goto('/login');
  await page.getByRole('button', { name: /Sign in with a passkey/ }).click();
  await expect(page).toHaveURL(/\/(all|manage)$/);
  await expect(banner(page)).toHaveCount(0);
  const passkeySession = await (await page.request.get('/api/auth/session')).json();
  expect(passkeySession).toMatchObject({ user: { id: SEED_USER_ID }, mustAddPasskey: false });
});

test('a used code and an unknown code get the same message; the value is kept and selected', async ({
  page,
}) => {
  await page.goto('/recover');
  await submitCode(page, CODES[1]!);
  await expect(page).toHaveURL(/\/all$/);
  await page.context().clearCookies();

  const wrong = "That code didn't work. Check it and try again. Each code works only once.";
  for (const code of [CODES[1]!, 'AAAA-BBBB-CCCC-DDDD']) {
    await page.goto('/recover');
    await submitCode(page, code);
    await expect(page.getByText(wrong)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Recovery code' })).toHaveValue(code);
    await expect(page.getByRole('textbox', { name: 'Recovery code' })).toBeFocused();
    await expect(page).toHaveURL(/\/recover$/);
  }
  await expectNoSeriousA11yViolations(page);
  await noHorizontalScroll(page);
});

test('the 11th failed attempt shows the rate-limit banner with a wait time', async ({ page }) => {
  await page.goto('/recover');
  for (let i = 0; i < 10; i++) {
    await submitCode(page, `AAAA-BBBB-CCCC-DD${i}${i}`);
    await expect(page.getByText("That code didn't work.", { exact: false })).toBeVisible();
  }
  await submitCode(page, CODES[2]!);
  await expect(page.getByText(/Too many attempts\. Try again in \d+ minutes?\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page).toHaveURL(/\/recover$/);
  await expectNoSeriousA11yViolations(page);
});

test('HEAD /api/health works without a session, other HEAD routes are still 401', async ({
  request,
}) => {
  const head = await request.head('/api/health');
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe('');
  expect((await request.head('/api/folders')).status()).toBe(401);
});
