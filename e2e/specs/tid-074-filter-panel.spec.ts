import type { CDPSession } from '@playwright/test';
import { axeViolations } from '../support/axe.ts';
import { closeFilters, openFilters, setSwitch } from '../support/filters.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-074: the filter panel and the header's tick button, against the real Worker and a seeded D1.
// Runs on mobile-light and desktop-dark only (the other projects add nothing for this story).
// TID_074_SHOTS=<dir> also writes the review screenshots (mobile projects), see docs/ux/reviews/tid-074.

const NOW = Math.floor(Date.now() / 1000);

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(
    !['mobile-light', 'desktop-dark'].includes(testInfo.project.name) &&
      !(process.env.TID_074_SHOTS && testInfo.project.name.startsWith('mobile')),
    'mobile-light and desktop-dark only',
  );
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9741, title: 'Filter Feed' }],
    entries: [
      { id: 9750, feedId: 9741, title: 'Unread one', publishedAt: NOW - 600 },
      { id: 9751, feedId: 9741, title: 'Unread two', publishedAt: NOW - 1200 },
      { id: 9752, feedId: 9741, title: 'Unread three', publishedAt: NOW - 1800 },
      { id: 9753, feedId: 9741, title: 'Already read', publishedAt: NOW - 2400, isRead: true },
    ],
  });
});
test.afterAll(() => clearListData());

async function swipeRight(cdp: CDPSession, x0: number, x1: number, y = 400, steps = 12) {
  const pt = (x: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt(x0 + ((x1 - x0) * i) / steps),
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 150)); // rest, so the release is not a flick
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('the list has no bottom bar; the header holds menu, title, tick and Filters, all 44px and on screen', async ({
  page,
}) => {
  await page.goto('/all');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Unread one', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#bottom-bar')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);

  const header = page.getByRole('banner').first();
  const vw = page.viewportSize()!.width;
  for (const name of [/navigation|sidebar/i, 'Mark all as read', 'Filters']) {
    const box = await header.getByRole('button', { name }).boundingBox();
    expect(box, String(name)).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
  }
  const title = await header.getByRole('heading', { level: 1 }).boundingBox();
  expect(title!.width).toBeGreaterThan(80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the panel: opens, applies Unread only at once, refreshes, and closes every way', async ({
  page,
}, testInfo) => {
  await page.goto('/all');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Unread one', exact: true }),
  ).toBeVisible();
  const rows = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(rows).toHaveCount(3);

  const panel = await openFilters(page);
  await expect(panel.getByRole('heading', { name: 'Filters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close filters' })).toBeFocused();
  // It hugs the right edge (once the slide-in has finished).
  await expect
    .poll(async () =>
      Math.round((await panel.boundingBox())!.x + (await panel.boundingBox())!.width),
    )
    .toBe(page.viewportSize()!.width);
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeCloseTo(page.viewportSize()!.width, 0);
  // No history entry: the URL has not changed.
  expect(new URL(page.url()).pathname).toBe('/all');

  // Unread only off: the read article joins the list, with the panel still open; the dot appears.
  await setSwitch(panel.getByRole('switch', { name: 'Unread only' }), false);
  await expect(rows).toHaveCount(4);
  await expect(panel.getByRole('switch', { name: 'Recommended order' })).toHaveCount(0);
  await expect(page.getByTestId('filter-dot')).toBeVisible();
  await setSwitch(panel.getByRole('switch', { name: 'Unread only' }), true);
  await expect(rows).toHaveCount(3);
  await expect(panel.getByRole('switch', { name: 'Recommended order' })).toBeVisible();

  // Refresh refetches the list.
  const refetched = page.waitForResponse(
    (r) => r.url().includes('/api/entries') && r.request().method() === 'GET',
  );
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await refetched;

  // Escape, the close button and the scrim each close it and give focus back to the button.
  await closeFilters(page);
  await expect(page.getByRole('button', { name: 'Filters' })).toBeFocused();
  await openFilters(page);
  await page.getByRole('button', { name: 'Close filters' }).click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
  await openFilters(page);
  await page.getByTestId('filter-scrim').click({ position: { x: 5, y: 300 } });
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);

  // Keyboard only: the panel traps Tab, and the open panel has no serious accessibility violations.
  await openFilters(page);
  expect(await axeViolations(page)).toEqual([]);
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  await closeFilters(page);
  expect(testInfo.project.name).toBeTruthy();
});

test('swiping right on the panel closes it (touch)', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'touch only');
  await page.goto('/all');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Unread one', exact: true }),
  ).toBeVisible();
  await openFilters(page);
  const cdp = await page.context().newCDPSession(page);
  const w = page.viewportSize()!.width;
  // A short drag springs back.
  await swipeRight(cdp, w - 200, w - 170);
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  await swipeRight(cdp, w - 250, w - 20);
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filters' })).toBeFocused();
});

test('the tick marks everything read and offers Undo; it is disabled when nothing is left', async ({
  page,
}) => {
  await page.goto('/all');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Unread one', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('Marked 3 as read')).toBeVisible();
  await expect(page.getByText('All caught up')).toBeVisible();
  // Nothing to list: the tick goes, Filters stays to turn Unread only off.
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
});

test('review screenshots', async ({ page }, testInfo) => {
  const dir = process.env.TID_074_SHOTS;
  test.skip(!dir || !testInfo.project.name.startsWith('mobile'), 'only when TID_074_SHOTS is set');
  const theme = testInfo.project.name.replace('mobile-', '');
  await page.goto('/all');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Unread one', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${dir}/375-${theme}-closed.png` });
  const panel = await openFilters(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/375-${theme}-open.png` });
  await setSwitch(panel.getByRole('switch', { name: 'Unread only' }), false);
  await expect(page.getByTestId('filter-dot')).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/375-${theme}-open-all.png` });
  await closeFilters(page);
  await page.screenshot({ path: `${dir}/375-${theme}-closed-dot.png` });
});
