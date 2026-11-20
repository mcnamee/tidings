import type { CDPSession, Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';
import { scrollTo, scrollY } from '../support/scroll.ts';

// TID-070: in the installed app an article never leaves a history entry (iOS's own edge swipe-back
// would animate the page away over a blank snapshot). Opening replaces the list's entry, Back and
// the edge swipe replace the article's with the list's, and the list scroll is restored. In a
// browser tab history is normal. Real Worker and seeded D1.

const NOW = Math.floor(Date.now() / 1000);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9801, title: 'Feed A' }],
    entries: Array.from({ length: 30 }, (_, i) => ({
      id: 9810 + i,
      feedId: 9801,
      title: `A Row ${i + 1}`,
      url: `https://example.com/a/${i + 1}`,
      contentHtml: '<p>Body</p>',
      publishedAt: NOW - 60 * (i + 1),
    })),
  });
});
test.afterAll(() => clearListData());

const mobileOnly = (name: string) => test.skip(!name.startsWith('mobile'), 'mobile layout');
const installed = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });

async function swipe(cdp: CDPSession, x0: number, x1: number, y = 400, steps = 12) {
  const pt = (x: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt(x0 + ((x1 - x0) * i) / steps),
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Scrolls the list, opens a row well inside the viewport, returns the scroll and history length before. */
async function scrollAndOpen(page: Page) {
  await page.goto('/all');
  await expect(page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true })).toBeVisible();
  await scrollTo(page, 600);
  const y = await scrollY(page);
  const href = await page
    .getByRole('link', { name: /A Row/ })
    .and(page.locator(':visible'))
    .evaluateAll((els) => {
      const el = els.find((e) => {
        const r = e.getBoundingClientRect();
        return r.top > 150 && r.bottom < window.innerHeight - 100;
      });
      return el?.getAttribute('href') ?? '';
    });
  expect(href).not.toBe('');
  const before = await page.evaluate(() => history.length);
  await page.locator(`a[href="${href}"]`).click();
  await expect(page.getByRole('article')).toBeVisible();
  return { y, before };
}

test.describe('TID-070: installed app', () => {
  test('opening an article does not add a history entry', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    const { before } = await scrollAndOpen(page);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('an edge swipe from x=5 goes back with the list underneath and its scroll restored', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    const { y, before } = await scrollAndOpen(page);
    await expect(page.getByTestId('article-layer')).toHaveCSS('transform', 'none');
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 5, 300);
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/all(\?|$)/);
    expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => history.length)).toBe(before);
    await expect(page.getByTestId('list-underlay')).not.toHaveAttribute('inert');
  });

  test('a short swipe from x=5 snaps back and stays on the article', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await scrollAndOpen(page);
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 5, 80, 400, 20);
    await expect(page.getByRole('article')).toBeVisible();
    await expect(page).toHaveURL(/\/a\//);
  });

  test('the Back button goes to the list with the scroll restored and no new entry', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    const { y, before } = await scrollAndOpen(page);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/all(\?|$)/);
    expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });
});

test.describe('TID-070: browser tab', () => {
  test('opening pushes and the browser Back returns to the list at its scroll', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    const { y, before } = await scrollAndOpen(page);
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    await page.goBack();
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/all(\?|$)/);
    expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(1);
  });
});
