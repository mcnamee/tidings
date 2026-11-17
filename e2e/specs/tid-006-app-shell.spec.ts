import type { Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-006 app shell and theming. Projects: mobile-light, mobile-dark, desktop-light, desktop-dark.

const ROUTES = [
  '/setup',
  '/login',
  '/recover',
  '/all',
  '/folders/f1',
  '/feeds/s1',
  '/all/a/e1',
  '/folders/f1/a/e1',
  '/feeds/s1/a/e1',
  '/manage',
  '/manage/add',
  '/manage/import',
  '/settings',
  '/no/such/page',
];

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

const inDialog = () => !!document.activeElement?.closest('[role=dialog]');

test.describe('TID-006 theming', () => {
  test('AC1: data-theme matches the OS at DOMContentLoaded, with no stored preference', async ({
    page,
  }, testInfo) => {
    const scheme = testInfo.project.name.endsWith('dark') ? 'dark' : 'light';
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const d = document.documentElement.dataset;
        (window as unknown as Record<string, unknown>).__dcl = [d.theme, d.themePref, d.textSize];
      });
    });
    await page.goto('/all');
    const dcl = await page.evaluate(() => (window as unknown as { __dcl: string[] }).__dcl);
    expect(dcl).toEqual([scheme, 'system', 'm']);
    await expect(page.locator('meta[name=theme-color]')).toHaveAttribute(
      'content',
      scheme === 'dark' ? '#1b1c20' : '#ffffff',
    );
  });

  test('AC1: the theme is already set while the stylesheet is still loading (no flash)', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.endsWith('dark'), 'only a dark OS can flash light');
    await page.route('**/assets/*.css', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    const nav = page.goto('/all', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await nav;
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('AC2: a stored preference beats the OS', async ({ page }, testInfo) => {
    const stored = testInfo.project.name.endsWith('dark') ? 'light' : 'dark';
    await page.addInitScript((v) => localStorage.setItem('tidings.theme', v), stored);
    await page.goto('/all');
    await expect(page.locator('html')).toHaveAttribute('data-theme', stored);
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', stored);
  });

  test('AC3: the theme follows live OS changes while the choice is system', async ({ page }) => {
    await page.goto('/all');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('AC3: OS changes are ignored while the choice is dark', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('tidings.theme', 'dark'));
    await page.goto('/all');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('TID-006 navigation drawer (mobile)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile'), 'drawer is below 1024px');
    await page.goto('/all');
  });

  test('AC4: opens from the header, traps focus, closes on Escape, scrim and Back', async ({
    page,
  }) => {
    const menu = page.getByRole('button', { name: 'Open navigation' });
    const dialog = page.getByRole('dialog', { name: 'Navigation' });

    await menu.click();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(inDialog)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(inDialog)).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(menu).toBeFocused();

    await menu.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(360, 400); // scrim, right of the 320px drawer
    await expect(dialog).toBeHidden();

    await menu.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
  });

  test('AC4: every tap target is at least 44 x 44 px', async ({ page }) => {
    const menu = page.getByRole('button', { name: 'Open navigation' });
    const box = await menu.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const controls = await page.getByRole('dialog').locator('a, button').all();
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const el of controls) {
      const b = await el.boundingBox();
      const name = (await el.innerText()) || (await el.getAttribute('aria-label'));
      expect(b?.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(b?.height, `${name} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('choosing a destination closes the drawer and focuses the new h1', async ({ page }) => {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
  });
});

test.describe('TID-006 sidebar (desktop)', () => {
  test('sidebar replaces the drawer at 1024px and up, and the skip link reaches main', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('desktop'), 'sidebar is 1024px and up');
    await page.goto('/all');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Feeds and folders' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });
});

test.describe('TID-006 routes, accessibility and headers', () => {
  for (const route of ROUTES) {
    test(`AC5: axe is clean and there is one h1 on ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoSeriousA11yViolations(page);
    });
  }

  test('AC6: SPA routes carry the spec headers and the console has no CSP violations', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(String(e)));
    for (const route of ['/all', '/settings', '/no/such/page']) {
      const res = await page.goto(route);
      const h = res?.headers() ?? {};
      expect(h['content-security-policy']).toBe(CSP);
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
      expect(h['cross-origin-opener-policy']).toBe('same-origin');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    expect(problems).toEqual([]);
  });

  test('"/" redirects to the last viewed list, falling back to /all', async ({ page }) => {
    // TID-018 AC11: the folder has to exist, or "/" falls back to /all.
    seedListData({ folders: [{ id: 'f9', name: 'Nine' }] });
    try {
      await page.goto('/');
      await expect(page).toHaveURL(/\/all$/);
      await page.goto('/folders/f9');
      await page.goto('/');
      await expect(page).toHaveURL(/\/folders\/f9$/);
    } finally {
      clearListData();
    }
  });

  test('offline shows the banner and online hides it', async ({ page, context }) => {
    await page.goto('/all');
    // The session check must have finished before the network goes away.
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("You're offline. Showing saved articles.")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("You're offline. Showing saved articles.")).toBeHidden();
  });
});

test.describe('TID-006 header Back (spec 11.2)', () => {
  // Opens the feed navigation (the drawer on mobile, the sidebar on desktop) and follows a link.
  async function followNavLink(page: Page, project: string, name: string) {
    if (project.startsWith('mobile')) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('dialog').getByRole('link', { name, exact: true }).first().click();
    } else {
      await page
        .getByRole('navigation', { name: 'Feeds and folders' })
        .getByRole('link', { name, exact: true })
        .first()
        .click();
    }
  }

  // Article links do not exist yet (lists are placeholders), so enter the article the way the router
  // does: a history entry that carries a router key, which is what marks "opened inside the app".
  async function pushInAppEntry(page: Page, to: string) {
    await page.evaluate((url) => {
      history.pushState({ usr: null, key: 'e2e-in-app', idx: history.length }, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, to);
  }

  for (const [sub, link] of [
    ['/manage/add', 'Add a feed'],
    ['/manage/import', 'Import from Inoreader'],
  ] as const) {
    test(`AC8: ${sub} opened from inside the app goes one entry back`, async ({
      page,
    }, testInfo) => {
      await page.goto('/all');
      await followNavLink(page, testInfo.project.name, link);
      await expect(page).toHaveURL(new RegExp(`${sub}$`));
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/all$/);
    });

    test(`AC8: ${sub} opened directly goes to /manage with replace`, async ({ page }) => {
      await page.goto(sub);
      const before = await page.evaluate(() => history.length);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(/\/manage$/);
      // replace: the entry count is unchanged (a push would add one).
      expect(await page.evaluate(() => history.length)).toBe(before);
    });
  }

  for (const [list, article] of [
    ['/all', '/all/a/e1'],
    ['/folders/f1', '/folders/f1/a/e1'],
    ['/feeds/s1', '/feeds/s1/a/e1'],
  ] as const) {
    test(`AC9: ${article} opened directly goes to ${list}`, async ({ page }) => {
      await page.goto(article);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page).toHaveURL(new RegExp(`${list}$`));
    });
  }

  test('AC9: an article opened from inside the app goes one entry back', async ({ page }) => {
    await page.goto('/feeds/s1');
    await pushInAppEntry(page, '/all');
    await pushInAppEntry(page, '/all/a/e1');
    await expect(page).toHaveURL(/\/all\/a\/e1$/);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/all$/);
  });
});
