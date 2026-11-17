import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { querySql, runSql, seedOwner, SESSION_COOKIE } from '../support/auth-state.ts';
import { expect, test } from '../support/test.ts';

// TID-053: emailed sign-in link, through the real screens and Worker. Outgoing mail is captured in
// D1 by the E2E server (E2E_CAPTURE_EMAIL, localhost only) and read back here. Runs from the
// resting state (an owner exists, nobody signed in).
const ADDRESS = 'owner@example.test';

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

test.beforeEach(() => {
  seedOwner(); // also clears rate-limit counters
  runSql('DROP TABLE IF EXISTS e2e_outbox;');
});
test.afterAll(() => {
  runSql('DROP TABLE IF EXISTS e2e_outbox;');
  seedOwner();
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function outboxCount(): number {
  try {
    return querySql('SELECT 1 FROM e2e_outbox').length;
  } catch {
    return 0; // the table is created by the first captured message
  }
}

/** The link in the newest captured message. */
async function capturedLink(): Promise<string> {
  let link = '';
  await expect
    .poll(
      () => {
        try {
          const rows = querySql<{ raw: string }>(
            'SELECT raw FROM e2e_outbox ORDER BY id DESC LIMIT 1',
          );
          link = /https?:\/\/\S+#token=[A-Za-z0-9_-]+/.exec(rows[0]?.raw ?? '')?.[0] ?? '';
        } catch {
          link = '';
        }
        return link;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  return link;
}

async function requestLink(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByLabel('Email address')).toBeFocused();
  await page.getByLabel('Email address').fill(`  ${ADDRESS.toUpperCase()} `);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test('golden path: request, open the link, tap Sign in, land on /all; the link then fails', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await expect(h1(page, 'Sign in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByLabel('Email address')).toBeFocused();
  await expectNoSeriousA11yViolations(page);
  await noHorizontalScroll(page);
  await page.getByLabel('Email address').fill(`  ${ADDRESS.toUpperCase()} `);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  const link = await capturedLink();
  expect(link).toContain('/login/email#token=');
  const message = querySql<{ to_addr: string; raw: string }>('SELECT to_addr, raw FROM e2e_outbox');
  expect(message).toHaveLength(1);
  expect(message[0]?.to_addr).toBe(ADDRESS);
  expect(message[0]?.raw).toContain('Subject: Your Tidings sign-in link');

  // A mail scanner's GET (no fragment is ever sent) gets the page shell and consumes nothing.
  const scan = await page.request.get(link.split('#')[0] ?? '');
  expect(scan.status()).toBe(200);
  expect(await scan.text()).toContain('<div id="root">');
  expect(querySql('SELECT 1 FROM magic_links WHERE used_at IS NOT NULL')).toHaveLength(0);
  expect(querySql("SELECT 1 FROM sessions WHERE auth_method = 'email'")).toHaveLength(0);

  const verifyCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/email/verify')) verifyCalls.push(r.url());
  });
  await page.goto(link);
  await expect(h1(page, 'Sign in to Tidings')).toBeVisible();
  // The fragment is gone from the address bar, and nothing has been consumed yet.
  expect(new URL(page.url()).hash).toBe('');
  expect(verifyCalls).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeFocused();
  await expectNoSeriousA11yViolations(page);
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/all$/);
  expect(verifyCalls).toHaveLength(1);
  const cookie = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(querySql("SELECT 1 FROM sessions WHERE auth_method = 'email'")).toHaveLength(1);
  expect(page.url()).not.toContain('token');

  // The same link in a fresh browser context: already used.
  const other = await browser.newContext(test.info().project.use);
  const second = await other.newPage();
  await second.goto(link);
  await second.getByRole('button', { name: 'Sign in' }).click();
  await expect(h1(second, 'This link has expired')).toBeVisible();
  await expectNoSeriousA11yViolations(second);
  await second.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(second).toHaveURL(/\/login$/);
  await other.close();
});

test('a wrong address shows the same Check your email state and nothing is sent', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.getByLabel('Email address').fill('someone.else@example.test');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(querySql('SELECT 1 FROM magic_links')).toHaveLength(0);
  expect(outboxCount()).toBe(0);
});

test('Send another link replaces the first: the earlier link is refused', async ({ page }) => {
  await requestLink(page);
  const first = await capturedLink();
  await page.getByRole('button', { name: 'Send another link' }).click();
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect.poll(outboxCount).toBe(2);
  await page.goto(first);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(h1(page, 'This link has expired')).toBeVisible();
});

test('/login/email with no token shows the expired state at once', async ({ page }) => {
  await page.goto('/login/email');
  await expect(h1(page, 'This link has expired')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
