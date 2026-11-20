import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';
import { scrollTo } from '../support/scroll.ts';

// TID-063: a short list has room past its last row, so the last article can be scrolled up under
// the header and is marked read by mark-read-on-scroll. Real Worker and seeded D1; mobile only.

const NOW = Math.floor(Date.now() / 1000);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9801, title: 'End Feed' }],
    entries: Array.from({ length: 3 }, (_, i) => ({
      id: 9900 + i,
      feedId: 9801,
      title: `Short ${i + 1}`,
      url: `https://example.com/end/${i + 1}`,
      contentHtml: `<p>Body ${i + 1}</p>`,
      publishedAt: NOW - 60 * (i + 1),
    })),
  });
});
test.afterAll(() => clearListData());

test('at the end of a short list the last row scrolls above the header and is marked read', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'mobile only');
  await page.goto('/all');
  const last = page.getByRole('heading', { level: 2, name: 'Short 3', exact: true });
  await expect(last).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll to top' })).toBeVisible();

  await scrollTo(page, 'end');
  const headerBottom = await page
    .getByRole('banner')
    .first()
    .evaluate((el) => el.parentElement!.getBoundingClientRect().bottom);
  const lastBottom = await last.evaluate((el) => el.closest('li')!.getBoundingClientRect().bottom);
  // Fully past, with room to spare (iOS left the last row touching the header edge).
  expect(lastBottom).toBeLessThan(headerBottom - 16);

  // The message is centred in the end space, which is as tall as the scroll container.
  const mid = await page.evaluate(() => {
    const end = document.querySelector('[data-testid="list-end"]')!;
    const text = end.querySelector('button')!.getBoundingClientRect();
    const box = end.getBoundingClientRect();
    return { text: text.top + text.height / 2, box: box.top + box.height / 2 };
  });
  expect(Math.abs(mid.text - mid.box)).toBeLessThan(40);

  await expect(last).toHaveClass(/text-fg-muted/);
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeVisible();

  // Scroll to top goes back up, then refreshes (the read rows leave the unread-only list).
  const refreshed = page.waitForResponse((r) => r.url().includes('/api/entries'));
  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await refreshed;
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(1);
});
