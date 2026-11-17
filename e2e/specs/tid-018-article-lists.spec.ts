import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-018 article lists, against the real Worker and a seeded D1. Projects: mobile-light,
// mobile-dark (375x812), desktop-light, desktop-dark. AC10 (axe, both themes) and AC14 (feed text
// is text) are the E2E-marked criteria; the rest are covered by the Worker and component tests.

const NOW = Math.floor(Date.now() / 1000);
const XSS_TITLE = 'Vec<T> & <b>x</b>';
const XSS_SUMMARY = '<script>alert(1)</script><img src=x onerror=alert(2)>';

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [{ id: 'f1', name: 'Tech' }],
    subs: [
      { id: 's1', feedId: 9201, title: 'Ars Technica', folderId: 'f1' },
      { id: 's2', feedId: 9202, title: 'Loose Feed' },
    ],
    entries: [
      {
        id: 9301,
        feedId: 9201,
        title: 'First article',
        summary: 'A short summary',
        publishedAt: NOW - 3600,
      },
      { id: 9302, feedId: 9201, title: XSS_TITLE, summary: XSS_SUMMARY, publishedAt: NOW - 7200 },
      { id: 9303, feedId: 9202, title: 'Already read', publishedAt: NOW - 9000, isRead: true },
    ],
  });
});
test.afterAll(() => clearListData());

test('AC1: the three views show their own articles, newest first', async ({ page }) => {
  await page.goto('/all');
  const rows = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(rows).toHaveText(['First article', XSS_TITLE]);

  await page.goto('/folders/f1');
  await expect(page.getByRole('heading', { level: 1, name: 'Tech' })).toBeVisible();
  await expect(rows).toHaveText(['First article', XSS_TITLE]);

  await page.goto('/feeds/s2');
  await expect(page.getByRole('heading', { level: 1, name: 'Loose Feed' })).toBeVisible();
  await expect(page.getByText('All caught up')).toBeVisible();
  await page.getByRole('button', { name: 'Show all articles' }).click();
  await expect(rows).toHaveText(['Already read']);
});

test('AC14: markup in an article title and summary is shown as text and runs nothing', async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto('/all');
  const heading = page.getByRole('heading', { level: 2, name: XSS_TITLE });
  await expect(heading).toHaveText(XSS_TITLE);
  const item = page.getByRole('main').getByRole('listitem').filter({ has: heading });
  await expect(item).toContainText(XSS_SUMMARY);
  await expect(item.locator('b, script, img')).toHaveCount(0);
  await expect(page.getByRole('main').locator('script')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
});

for (const route of ['/all', '/folders/f1', '/feeds/s1']) {
  test(`AC10: axe is clean on ${route}`, async ({ page }, testInfo) => {
    // DEF-051: on desktop the sidebar is always on screen, and its "Name, N unread" aria-labels fail
    // axe's label-content-name-mismatch. Flips red when fixed: remove this line then.
    test.fail(testInfo.project.name.startsWith('desktop'), 'DEF-051');
    await page.goto(route);
    await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
}

test('AC10: axe is clean on the drawer with folders, feeds and counts', async ({
  page,
}, testInfo) => {
  test.fail(true, 'DEF-051: "Tech, 2 unread" does not contain the visible text "Tech 2"');
  await page.goto('/all');
  if (testInfo.project.name.startsWith('mobile')) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await expect(page.getByRole('link', { name: /^Tech, 2 unread$/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('AC10: no horizontal scroll at 375px', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), '375px is the mobile projects');
  await page.goto('/all');
  await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
