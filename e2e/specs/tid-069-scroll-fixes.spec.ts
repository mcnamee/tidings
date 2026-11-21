import type { CDPSession, Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';
import { scrollTo, scrollY } from '../support/scroll.ts';

// TID-069: the document is the scroller below lg (status-bar tap), the list resets on a list
// switch but not on Back from an article, the drawer opens from the very edge in the installed
// app, and focus rings show for the keyboard only. Real Worker and seeded D1.

const NOW = Math.floor(Date.now() / 1000);
const LONG = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1} of a long article.</p>`);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [
      { id: 's1', feedId: 9701, title: 'Feed A' },
      { id: 's2', feedId: 9702, title: 'Feed B' },
    ],
    entries: [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 9710 + i,
        feedId: 9701,
        title: `A Row ${i + 1}`,
        url: `https://example.com/a/${i + 1}`,
        contentHtml: LONG.join(''),
        publishedAt: NOW - 60 * (i + 1),
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 9760 + i,
        feedId: 9702,
        title: `B Row ${i + 1}`,
        url: `https://example.com/b/${i + 1}`,
        contentHtml: '<p>B body</p>',
        publishedAt: NOW - 60 * (i + 1) - 5,
      })),
    ],
  });
});
test.afterAll(() => clearListData());

const mobileOnly = (name: string) => test.skip(!name.startsWith('mobile'), 'mobile layout');

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

const headerTop = (page: Page) =>
  page
    .getByRole('banner')
    .first()
    .evaluate((el) => el.parentElement!.getBoundingClientRect().top);

test.describe('TID-069: the document scrolls, the bars stay put', () => {
  test('window.scrollY changes, the header stays at top 0 and the list has no bottom bar', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(
      page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true }),
    ).toBeVisible();
    expect(await scrollY(page)).toBe(0);
    await scrollTo(page, 800);
    expect(await scrollY(page)).toBeGreaterThan(400);
    expect(await headerTop(page)).toBe(0);
    // TID-074: lists have no bottom bar any more (the article view keeps its own).
    await expect(page.locator('#bottom-bar')).toBeEmpty();
    // No inner scroller any more.
    expect(
      await page.getByTestId('main-scroll').evaluate((el) => getComputedStyle(el).overflowY),
    ).toBe('visible');
  });

  test('an open article scrolls the document: header pinned, list frozen, Back restores the list exactly', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(
      page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true }),
    ).toBeVisible();
    await scrollTo(page, 700);
    const y = await scrollY(page);
    const row = page.getByRole('link', { name: /A Row/ }).and(page.locator(':visible'));
    const target = await row.evaluateAll((els) => {
      const el = els.find((e) => {
        const r = e.getBoundingClientRect();
        return r.top > 150 && r.bottom < window.innerHeight - 100;
      });
      return el?.getAttribute('href') ?? '';
    });
    expect(target).not.toBe('');
    await page.locator(`a[href="${target}"]`).click();
    await expect(page.getByRole('article')).toBeVisible();
    await expect(page.getByTestId('article-layer')).toHaveCSS('transform', 'none');
    expect(await scrollY(page)).toBe(0);
    await scrollTo(page, 500);
    expect(await scrollY(page)).toBeGreaterThan(300);
    expect(await headerTop(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Back' })).toBeInViewport();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/all(\?|$)/);
    expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(1);
    expect(await headerTop(page)).toBe(0);
  });
});

test.describe('TID-069: a list switch starts at the top', () => {
  test('choosing another list from the menu resets the scroll', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    // Feed A alone: scrolling All would also mark Feed B's rows read.
    await page.goto('/feeds/s1');
    await expect(
      page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true }),
    ).toBeVisible();
    await scrollTo(page, 900);
    expect(await scrollY(page)).toBeGreaterThan(500);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await drawer.getByRole('link', { name: /Feed B/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Feed B' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'B Row 1', exact: true }),
    ).toBeVisible();
    // TID-075: the page is a frozen card until the drawer's slide-out ends; then it scrolls again.
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    expect(await scrollY(page)).toBe(0);

    // Scrolled again, then All articles: also at the top.
    await scrollTo(page, 600);
    expect(await scrollY(page)).toBeGreaterThan(300);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await drawer.getByRole('link', { name: 'All articles' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    expect(await scrollY(page)).toBe(0);
  });
});

test.describe('TID-069: the drawer opens from the very edge in the installed app', () => {
  test('a swipe that starts at x=5 opens it', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    });
    await page.goto('/all');
    await expect(
      page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true }),
    ).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 5, 260);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  });

  test('choosing a list from the menu does not push history', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    });
    await page.goto('/all');
    await expect(
      page.getByRole('heading', { level: 2, name: 'A Row 1', exact: true }),
    ).toBeVisible();
    const before = await page.evaluate(() => history.length);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: /Feed B/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Feed B' })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(before);
  });
});

test.describe('TID-069: focus rings are for the keyboard', () => {
  const ring = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return {
        style: getComputedStyle(el).outlineStyle,
        tag: el.tagName,
        input: document.documentElement.dataset.input ?? '',
      };
    });

  test('no ring on the h1 or the Menu button after a pointer tap, a ring after Tab', async ({
    page,
  }, testInfo) => {
    await page.goto('/all');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await h1.click(); // a tap on the title focuses it (tabindex -1)
    expect(await ring(page)).toMatchObject({ tag: 'H1', style: 'none', input: '' });

    const menu = page.getByRole('banner').first().getByRole('button').first();
    await menu.click();
    const dialog = page.getByRole('dialog', { name: 'Navigation' });
    if (testInfo.project.name.startsWith('mobile')) {
      // The tap opened the drawer; closing it by tap hands focus back to Menu.
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close navigation' }).click();
      await expect(dialog).toHaveCount(0);
    }
    await menu.focus();
    expect(await ring(page)).toMatchObject({ tag: 'BUTTON', style: 'none', input: '' });

    await page.keyboard.press('Tab');
    const after = await ring(page);
    expect(after.input).toBe('keyboard');
    expect(after.style).toBe('solid');

    // A programmatically focused heading never shows one, even with the keyboard in use.
    await h1.evaluate((el) => (el as HTMLElement).focus());
    expect(await ring(page)).toMatchObject({ tag: 'H1', style: 'none' });

    // A pointer clears it again.
    await page.mouse.click(5, 5);
    await menu.focus();
    expect(await ring(page)).toMatchObject({ style: 'none', input: '' });
  });
});
