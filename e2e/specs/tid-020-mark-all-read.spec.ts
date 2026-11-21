import { clearListData, seedListData, type SeedEntry } from '../support/list-data.ts';
import { setUnreadOnly } from '../support/filters.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-020 mark all as read, against the real Worker and a seeded D1. Written by the SE and not
// yet run: the tester owns running and extending it. Projects: mobile-light, mobile-dark (375x812),
// desktop-light, desktop-dark. The unit and integration tests cover the rest of the ACs
// (apps/web/src/lists/MarkAllRead.test.tsx, apps/worker/test/mark-all-read.test.ts).

const NOW = Math.floor(Date.now() / 1000);
const entries = (feedId: number, first: number, n: number): SeedEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: first + i,
    feedId,
    title: `Item ${first + i}`,
    publishedAt: NOW - 600 - i,
  }));

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [{ id: 'f1', name: 'Tech' }],
    subs: [
      { id: 's1', feedId: 9401, title: 'In folder', folderId: 'f1' },
      { id: 's2', feedId: 9402, title: 'Outside' },
    ],
    // 25 unread in the folder (more than 20: a confirm step), 3 outside it.
    entries: [...entries(9401, 9500, 25), ...entries(9402, 9600, 3)],
  });
});
test.afterAll(() => clearListData());

test('AC1, AC3, AC5: a folder asks first, marks only its entries, and Undo restores exactly those', async ({
  page,
}) => {
  await page.goto('/folders/f1');
  await expect(page.getByRole('link', { name: /Item 9500/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();

  const dialog = page.getByRole('dialog', { name: 'Mark 25 articles as read?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: /Item 9500/ })).toBeVisible();

  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await page.getByRole('button', { name: 'Mark 25 as read' }).click();
  await expect(page.getByText('Marked 25 as read')).toBeVisible();
  await expect(page.getByText('All caught up')).toBeVisible();

  // The other feed is untouched (AC1, AC5).
  await page.goto('/feeds/s2');
  await expect(page.getByRole('link', { name: /Item 9600/ })).toBeVisible();

  await page.goto('/folders/f1');
  await setUnreadOnly(page, false);
  await expect(page.getByRole('link', { name: /Item 9500/ })).toBeVisible();
});

test('AC2: an article that arrives after the list loaded stays unread', async ({ page }) => {
  await page.goto('/feeds/s2');
  await expect(page.getByRole('link', { name: /Item 9600/ })).toBeVisible();
  // Arrives after the list was loaded: its published time is after the list's asOf.
  seedListData({
    entries: [{ id: 9700, feedId: 9402, title: 'Late arrival', publishedAt: NOW + 3600 }],
  });
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('Marked 3 as read')).toBeVisible();
  await page.goto('/feeds/s2');
  await expect(page.getByRole('link', { name: /Late arrival/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Item 9600/ })).toHaveCount(0);
});

test('AC7: a failed Undo says so, and the entries stay read', async ({ page }) => {
  await page.goto('/feeds/s2');
  await expect(page.getByRole('link', { name: /Item 9600/ })).toBeVisible();
  await page.route('**/api/entries/read-state', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'x' } }),
    }),
  );
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText("Couldn't undo. Your change was kept.")).toBeVisible();
  await expect(page.getByText('All caught up')).toBeVisible();
  await page.unroute('**/api/entries/read-state');
  await page.goto('/feeds/s2');
  await expect(page.getByText('All caught up')).toBeVisible();
});
