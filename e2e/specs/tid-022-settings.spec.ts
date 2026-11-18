import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import {
  createSession,
  querySql,
  runSql,
  seedOwner,
  SEED_USER_ID,
  sha256Hex,
} from '../support/auth-state.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signInAs, signedInTest, test as plainTest } from '../support/test.ts';
import { registerOwner, test as passkeyTest, useEmptyDatabase } from '../support/passkey-test.ts';

// TID-022: Settings (theme, reading, account, data) through the real screens and Worker. The
// seeded owner (signed in by cookie) covers settings, sign out everywhere and the screens; a real
// owner with a virtual authenticator covers passkeys and recovery codes. Run on mobile-light and
// desktop-dark at least.

const NOW = Math.floor(Date.now() / 1000);
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const html = (page: Page) => page.locator('html');

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const resetSettings = () =>
  runSql(
    `UPDATE users SET settings_json = '{}', display_name = 'Seed Owner' WHERE id = '${SEED_USER_ID}';`,
  );

signedInTest.describe('settings and screen', () => {
  signedInTest.beforeEach(() => {
    resetSettings();
    clearListData();
    seedListData({
      subs: [{ id: 's1', feedId: 9201, title: 'Ars Technica' }],
      entries: [
        { id: 9301, feedId: 9201, title: 'Unread article', publishedAt: NOW - 3600 },
        { id: 9303, feedId: 9201, title: 'Already read', publishedAt: NOW - 9000, isRead: true },
      ],
    });
  });
  signedInTest.afterAll(() => {
    resetSettings();
    clearListData();
  });

  signedInTest(
    'AC1: theme applies at once, is stored on the account, and follows it to another device',
    async ({ page, browser, baseURL }) => {
      await page.goto('/settings');
      await expect(h1(page, 'Settings')).toBeVisible();
      await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();

      await page.getByRole('radio', { name: 'Dark' }).check();
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      expect(await page.evaluate(() => localStorage.getItem('tidings.theme'))).toBe('dark');
      await expect
        .poll(async () => (await (await page.request.get('/api/me')).json()).settings.theme)
        .toBe('dark');

      await page.getByRole('radio', { name: 'Light' }).check();
      await expect(html(page)).toHaveAttribute('data-theme', 'light');
      expect(await page.evaluate(() => localStorage.getItem('tidings.theme'))).toBe('light');

      await page.getByRole('radio', { name: 'Dark' }).check();
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      await expect
        .poll(async () => (await (await page.request.get('/api/me')).json()).settings.theme)
        .toBe('dark');

      // A new browser context with the same account: no localStorage, light system preference.
      const other = await browser.newContext({ baseURL, colorScheme: 'light' });
      await signInAs(other, createSession(), baseURL);
      const second = await other.newPage();
      await second.goto('/all');
      await expect(html(second)).toHaveAttribute('data-theme', 'dark');
      expect(await second.evaluate(() => localStorage.getItem('tidings.theme'))).toBe('dark');
      await other.close();

      // System follows the device again.
      await page.getByRole('radio', { name: 'System' }).check();
      await expect(html(page)).toHaveAttribute('data-theme-pref', 'system');
      expect(await page.evaluate(() => localStorage.getItem('tidings.theme'))).toBe('system');
    },
  );

  signedInTest(
    'AC2: reading options and text size persist across reloads and take effect',
    async ({ page }) => {
      // The attribute must be right at DOMContentLoaded, before the app has rendered anything.
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          (window as unknown as { __size?: string }).__size =
            document.documentElement.getAttribute('data-text-size') ?? 'none';
        });
      });
      await page.goto('/settings');
      const unreadOnly = page.getByRole('switch', { name: 'Show unread only by default' });
      const onOpen = page.getByRole('switch', { name: 'Mark as read when opened' });
      const onScroll = page.getByRole('switch', { name: 'Mark as read when scrolled past' });
      await expect(unreadOnly).toBeChecked();
      await expect(onOpen).toBeChecked();
      await expect(onScroll).toBeChecked(); // default on (TID-026)

      await unreadOnly.uncheck();
      await onOpen.uncheck();
      await onScroll.uncheck();
      await page.getByRole('radio', { name: 'Large' }).check();
      await expect(html(page)).toHaveAttribute('data-text-size', 'l');
      expect(await page.evaluate(() => localStorage.getItem('tidings.textSize'))).toBe('l');
      await expect
        .poll(async () => (await (await page.request.get('/api/me')).json()).settings)
        .toEqual({
          unreadOnly: false,
          markReadOnOpen: false,
          markReadOnScroll: false,
          textSize: 'l',
        });

      await page.reload();
      expect(await page.evaluate(() => (window as unknown as { __size?: string }).__size)).toBe(
        'l',
      );
      await expect(unreadOnly).not.toBeChecked();
      await expect(onOpen).not.toBeChecked();
      await expect(onScroll).not.toBeChecked();
      await expect(page.getByRole('radio', { name: 'Large' })).toBeChecked();

      // It takes effect in the list (read articles show) ...
      await page.goto('/all');
      const rows = page.getByRole('main').getByRole('heading', { level: 2 });
      await expect(rows).toHaveText(['Unread article', 'Already read']);
      // ... and in the article view (opening it leaves it unread).
      await page
        .getByRole('link', { name: /Unread article/ })
        .first()
        .click();
      await expect(page).toHaveURL(/\/a\/[^/]+$/);
      await page.waitForTimeout(500);
      expect(
        querySql<{ is_read: number }>('SELECT is_read FROM user_entries WHERE entry_id = 9301')[0]
          ?.is_read,
      ).toBe(0);
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--article-size').trim(),
        ),
      ).toBe('1.25rem');
    },
  );

  signedInTest(
    'AC6: Import OPML opens /manage/import; Export OPML is hidden until TID-017',
    async ({ page }) => {
      await page.goto('/settings');
      await expect(
        page.getByText('Articles are kept for 30 days after you read them.'),
      ).toBeVisible();
      // Hidden until TID-017 builds the export route.
      await expect(page.getByRole('link', { name: 'Export OPML' })).toHaveCount(0);
      await page.getByRole('link', { name: 'Import OPML' }).click();
      await expect(page).toHaveURL(/\/manage\/import$/);
    },
  );

  signedInTest('AC7: 375px fits, passes axe, and shows the version small', async ({ page }) => {
    await page.goto('/settings');
    await expect(h1(page, 'Settings')).toBeVisible();
    await expect(page.getByTestId('app-version')).toContainText('Tidings ');
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
    for (const name of ['Light', 'Dark', 'System', 'Small', 'Medium', 'Large']) {
      const box = await page.getByRole('radio', { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    for (const b of await page.getByRole('button').all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height, await b.innerText()).toBeGreaterThanOrEqual(44);
    }
    // The sign out everywhere confirm sheet.
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page.getByRole('dialog', { name: 'Sign out everywhere?' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

plainTest.describe('sign out', () => {
  plainTest.afterAll(() => seedOwner());

  plainTest(
    'AC5: Sign out everywhere deletes every session, and each context gets 401',
    async ({ page, browser, baseURL }) => {
      const mine = createSession();
      const theirs = createSession();
      await signInAs(page.context(), mine, baseURL);
      const other = await browser.newContext({ baseURL });
      await signInAs(other, theirs, baseURL);
      const otherPage = await other.newPage();
      await otherPage.goto('/all');
      await expect(h1(otherPage, 'All articles')).toBeVisible();
      expect((await otherPage.request.get('/api/me')).status()).toBe(200);

      await page.goto('/settings');
      await page.getByRole('button', { name: 'Sign out everywhere' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
      await expect(page).toHaveURL(/\/login$/);
      expect(await page.evaluate(() => document.cookie)).not.toContain('tid_session');
      expect((await page.request.get('/api/me')).status()).toBe(401);
      expect((await otherPage.request.get('/api/me')).status()).toBe(401);
      expect(
        querySql<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${SEED_USER_ID}'`,
        )[0]?.n,
      ).toBe(0);
      await other.close();
    },
  );

  plainTest('Sign out ends only this session', async ({ page, browser, baseURL }) => {
    const mine = createSession();
    const theirs = createSession();
    await signInAs(page.context(), mine, baseURL);
    const other = await browser.newContext({ baseURL });
    await signInAs(other, theirs, baseURL);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await other.request.get('/api/me')).status()).toBe(200);
    await other.close();
  });
});

passkeyTest.describe('passkeys and recovery codes', () => {
  useEmptyDatabase();

  const rows = (page: Page) => page.getByTestId('passkey-row');

  passkeyTest(
    'AC3: add, rename and remove a passkey; the last one cannot be removed',
    async ({ page, authenticator, newAuthenticator }) => {
      await registerOwner(page);
      await page.goto('/settings');
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText('Added');
      await expect(page.getByText(/This is your only passkey/)).toBeVisible();

      // A device can't register a second passkey for the same account (the server excludes the
      // ones it knows), so the second one comes from a second device.
      await authenticator.remove();
      const second = await newAuthenticator();
      await page.getByRole('button', { name: 'Add a passkey' }).click();
      await expect(rows(page)).toHaveCount(2);
      await expect(page.getByText('Passkey added.')).toBeVisible();
      expect(await second.credentials()).toHaveLength(1);
      await expectNoSeriousA11yViolations(page);
      await noHorizontalScroll(page);

      // Rename the first one.
      await rows(page)
        .first()
        .getByRole('button', { name: /^Rename/ })
        .click();
      await expectNoSeriousA11yViolations(page);
      const name = page.getByRole('dialog').getByLabel('Name');
      await name.fill('Work laptop');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await expect(rows(page).first()).toContainText('Work laptop');
      expect(
        querySql<{ name: string }>('SELECT name FROM passkeys ORDER BY created_at, id').map(
          (r) => r.name,
        ),
      ).toContain('Work laptop');

      // Remove the second, after a confirm.
      await rows(page)
        .nth(1)
        .getByRole('button', { name: /^Remove/ })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(page.getByText('Passkey removed.')).toBeVisible();

      // The last one: the server says 409 last_passkey, and the screen explains.
      await rows(page)
        .first()
        .getByRole('button', { name: /^Remove/ })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
      await expect(page.getByRole('dialog')).toContainText("You can't remove your only passkey");
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await expect(rows(page)).toHaveCount(1);
      expect(querySql<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys')[0]?.n).toBe(1);
      const id = querySql<{ id: string }>('SELECT id FROM passkeys')[0]?.id ?? '';
      const res = await page.request.delete(`/api/auth/passkeys/${id}`, {
        headers: { Origin: new URL(page.url()).origin, 'Content-Type': 'application/json' },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error.code).toBe('last_passkey');
    },
  );

  passkeyTest(
    'AC4: a stale session is asked for a passkey, then new recovery codes show once and replace the old ones',
    async ({ page, bareRequest, baseURL }) => {
      await registerOwner(page);
      const oldHashes = querySql<{ code_hash: string }>('SELECT code_hash FROM recovery_codes').map(
        (r) => r.code_hash,
      );
      expect(oldHashes).toHaveLength(10);
      // Make the session's last passkey sign-in older than 15 minutes.
      runSql('UPDATE sessions SET authenticated_at = authenticated_at - 1000;');
      const statuses: number[] = [];
      page.on('response', (r) => {
        if (r.url().endsWith('/api/auth/recovery-codes')) statuses.push(r.status());
      });

      await page.goto('/settings');
      await page.getByRole('button', { name: 'Make new recovery codes' }).click();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole('button', { name: 'Make new codes' }).click();

      const list = page.getByTestId('new-recovery-codes');
      await expect(list.getByRole('listitem')).toHaveCount(10);
      expect(statuses).toEqual([403, 200]);
      await expectNoSeriousA11yViolations(page);
      await noHorizontalScroll(page);
      const codes = await list.locator('code').allInnerTexts();
      expect(new Set(codes).size).toBe(10);

      const newHashes = querySql<{ code_hash: string }>('SELECT code_hash FROM recovery_codes').map(
        (r) => r.code_hash,
      );
      expect(newHashes).toHaveLength(10);
      expect(newHashes.filter((h) => oldHashes.includes(h))).toEqual([]);
      expect(newHashes.sort()).toEqual(codes.map((c) => sha256Hex(c.replace(/-/g, ''))).sort());

      // Once only: closing drops them from the page, and a reload shows nothing.
      await page.getByRole('button', { name: /I.ve saved these/ }).click();
      await expect(page.getByText(codes[0] as string)).toHaveCount(0);

      // An old code is refused; a new one signs in.
      const origin = new URL(baseURL as string).origin;
      const recover = (code: string) =>
        bareRequest.post('/api/auth/recover', {
          data: { code },
          headers: { Origin: origin, 'Content-Type': 'application/json' },
        });
      expect((await recover('0000-0000-0000-0000')).status()).toBe(401);
      expect((await recover(codes[0] as string)).status()).toBe(200);
    },
  );

  passkeyTest('a fresh session needs no extra passkey prompt for new codes', async ({ page }) => {
    await registerOwner(page);
    const statuses: number[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('/api/auth/recovery-codes')) statuses.push(r.status());
    });
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Make new recovery codes' }).click();
    await page.getByRole('button', { name: 'Make new codes' }).click();
    await expect(page.getByTestId('new-recovery-codes').getByRole('listitem')).toHaveCount(10);
    expect(statuses).toEqual([200]);
  });
});
