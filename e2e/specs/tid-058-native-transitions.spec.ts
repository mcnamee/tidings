import type { CDPSession, Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-058: native-feel transitions on a phone. Pulling a list down at the top stretches the list
// content and never moves the header; an article slides in from the right over the list (which
// shifts left) and slides out again on Back. Real touch events over CDP; browser mode (the
// transitions are visual, not gestures). Mobile projects only: desktop skips the slide.

const NOW = Math.floor(Date.now() / 1000);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9601, title: 'Transition Feed' }],
    entries: Array.from({ length: 12 }, (_, i) => ({
      id: 9700 + i,
      feedId: 9601,
      title: `Row ${i + 1}`,
      url: `https://example.com/t/${i + 1}`,
      contentHtml: `<p>Body ${i + 1}</p>`,
      publishedAt: NOW - 60 * (i + 1),
    })),
  });
});
test.afterAll(() => clearListData());

const mobileOnly = (name: string) => test.skip(!name.startsWith('mobile'), 'mobile only');

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', y?: number) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: y === undefined ? [] : [{ x: 200, y }],
  });

/** Records the article layer's and the list's left edge on every frame. */
async function sample(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __s: { layer: number | null; list: number }[] };
    w.__s = [];
    const tick = () => {
      const layer = document.querySelector('[data-testid=article-layer]');
      const list = document.querySelector('[data-testid=list-underlay]');
      w.__s.push({
        layer: layer ? layer.getBoundingClientRect().left : null,
        list: list ? list.getBoundingClientRect().left : 0,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const samples = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __s: { layer: number | null; list: number }[] }).__s.filter(
        (s) => s.layer !== null,
      ) as { layer: number; list: number }[],
  );

test.describe('TID-058: pull down keeps the header pinned', () => {
  test('the header stays at the top while the list content stretches, then springs back', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    const header = page.getByRole('banner').first();
    const list = page.getByRole('list').first();
    const top = () => header.evaluate((el) => el.getBoundingClientRect().top);
    const rowTop = () => list.evaluate((el) => el.getBoundingClientRect().top);
    const before = await rowTop();

    await touch(cdp, 'touchStart', 300);
    for (let y = 300; y <= 480; y += 20) {
      await touch(cdp, 'touchMove', y);
      await page.waitForTimeout(16);
      expect(await top()).toBe(0);
    }
    expect(await top()).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await rowTop()).toBeGreaterThan(before + 20);
    await expect(page.getByText('Release to refresh')).toBeVisible();
    await touch(cdp, 'touchEnd');
    await expect.poll(rowTop, { timeout: 5000 }).toBe(before);
    expect(await top()).toBe(0);
  });
});

test.describe('TID-058: the article slides in and out', () => {
  test('opening animates the layer from off-screen right to 0 over a list that shifts left; Back reverses', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    await sample(page);
    await page.locator('a[href^="/all/a/9700"]').click();
    await expect(page.getByTestId('article-layer')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused({ timeout: 3000 });

    const opened = await samples(page);
    expect(opened.length).toBeGreaterThan(1);
    expect(opened[0]!.layer).toBeGreaterThan(300); // starts off-screen right
    expect(opened.at(-1)!.layer).toBe(0);
    expect(Math.min(...opened.map((s) => s.list))).toBeGreaterThanOrEqual(-112.5); // parallax, at most 30%
    expect(opened.at(-1)!.list).toBe(0);
    expect(opened.map((s) => s.layer)).toEqual(
      [...opened.map((s) => s.layer)].sort((a, b) => b - a),
    );

    await sample(page);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/all$/);
    const closed = await samples(page);
    expect(closed.at(-1)!.layer).toBeGreaterThan(300); // went off-screen right before the route changed
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
  });

  test('a direct link opens with no slide', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.addInitScript(() => {
      const w = window as unknown as { __lefts: number[] };
      w.__lefts = [];
      const tick = () => {
        const l = document.querySelector('[data-testid=article-layer]');
        if (l) w.__lefts.push(l.getBoundingClientRect().left);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto('/all/a/9700');
    await expect(page.getByTestId('article-layer')).toBeVisible();
    await page.waitForTimeout(500);
    const lefts = await page.evaluate(() => (window as unknown as { __lefts: number[] }).__lefts);
    expect(lefts.length).toBeGreaterThan(0);
    expect(lefts.every((l) => l === 0)).toBe(true);
  });
});
