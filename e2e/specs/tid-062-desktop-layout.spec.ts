import type { Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-062: collapsible desktop sidebar and the magazine card grid. Desktop projects only (1280px
// wide). /api/entries is mocked so the cards have images without a network.

const NOW = Date.now();
const svg = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="hsl(${hue} 45% 60%)"/></svg>`,
  )}`;

const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  id: `9${400 + i}`,
  subscriptionId: 's1',
  feedTitle: 'Ars Technica',
  title:
    i % 4 === 3
      ? `Text only story ${i}`
      : `A reasonably long magazine headline number ${i} that wraps over a few lines`,
  author: null,
  url: `https://example.com/${i}`,
  summary: null,
  imageUrl: i % 4 === 3 ? null : svg(i * 31),
  publishedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
  isRead: i === 5,
  isStarred: false,
}));

async function mockEntries(page: Page) {
  await page.route('**/api/entries?*', (route) =>
    route.fulfill({
      json: { items: ITEMS, nextCursor: null, asOf: new Date(NOW).toISOString() },
    }),
  );
}

const columns = (page: Page) =>
  page
    .getByTestId('article-grid')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9201, title: 'Ars Technica' }],
    entries: [],
  });
});
test.afterAll(() => clearListData());

test.beforeEach((_fixtures, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'desktop layout only');
});

test('the Menu button hides and restores the sidebar, and the choice is remembered', async ({
  page,
}) => {
  await mockEntries(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/all');
  const sidebar = page.locator('#sidebar');
  const toggle = page.getByRole('button', { name: 'Hide sidebar' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toBeVisible();
  const before = (await page.getByRole('main').boundingBox())!.width;

  await toggle.focus();
  await page.keyboard.press('Enter');
  const show = page.getByRole('button', { name: 'Show sidebar' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(show).toBeFocused();
  await expect(sidebar).toHaveJSProperty('inert', true);
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(0);
  expect((await page.getByRole('main').boundingBox())!.width).toBeGreaterThan(before + 250);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  await show.click();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
  await expect(sidebar).toBeVisible();
});

test('the list is a card grid: 3 columns at 1280, 2 at 1100 with the sidebar, 3 when hidden', async ({
  page,
}) => {
  await mockEntries(page);
  await page.goto('/all');
  await expect(page.getByTestId('article-grid').locator('li')).toHaveCount(12);
  expect(await columns(page)).toBe(3);
  await page.setViewportSize({ width: 1100, height: 800 });
  expect(await columns(page)).toBe(2);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect.poll(() => columns(page)).toBe(3);

  const cards = page.getByTestId('article-grid').locator('li');
  // Text-only cards have no image box; image cards are 16:9 on top of the title.
  const textCard = cards.filter({ hasText: 'Text only story 3' });
  await expect(textCard.locator('img')).toHaveCount(0);
  const img = cards.first().locator('img');
  const box = (await img.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
  await expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
});

// Review screenshots for docs/ux/reviews (run with TID062_SHOTS=1 on desktop-light).
test('review screenshots', async ({ page }) => {
  test.skip(!process.env.TID062_SHOTS, 'only when capturing screenshots');
  await mockEntries(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/all');
  await expect(page.getByTestId('article-grid').locator('li')).toHaveCount(12);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '../docs/ux/reviews/tid-062-desktop-sidebar.png' });
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '../docs/ux/reviews/tid-062-desktop-collapsed.png' });
});

test('the article layer covers the content column, or the whole width when hidden', async ({
  page,
}) => {
  await mockEntries(page);
  await page.goto('/all');
  await page.getByTestId('article-grid').locator('a').first().click();
  const layer = page.getByTestId('article-layer');
  await expect(layer).toBeVisible();
  expect((await layer.boundingBox())!.x).toBe(288);
  await page.goBack();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.getByTestId('article-grid').locator('a').first().click();
  await expect(layer).toBeVisible();
  expect((await layer.boundingBox())!.x).toBe(0);
});
