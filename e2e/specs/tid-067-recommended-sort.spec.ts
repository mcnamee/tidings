import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-067: the Recommended sort control. The E2E Worker runs with `wrangler dev --local`, so it has
// no Workers AI binding: Recommended must fall back to newest first and say so, never break the list.

const NOW = Math.floor(Date.now() / 1000);

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9811, title: 'Sort Feed' }],
    entries: Array.from({ length: 4 }, (_, i) => ({
      id: 9910 + i,
      feedId: 9811,
      title: `Sorted ${i + 1}`,
      url: `https://example.com/sort/${i + 1}`,
      contentHtml: `<p>Body ${i + 1}</p>`,
      publishedAt: NOW - 600 * (i + 1),
    })),
  });
});
test.afterAll(() => clearListData());

test('Recommended falls back to newest first (no note) when nothing can be recommended yet (no AI locally), and can be turned off', async ({
  page,
}) => {
  await page.goto('/all');
  const titles = () => page.getByRole('heading', { level: 2 }).allTextContents();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Sorted 1', exact: true }),
  ).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Recommended' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('sort-note')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // No note while it falls back to newest first (owner, 2026-11-19).
  await expect(page.getByTestId('sort-note')).toHaveCount(0);
  // Newest first, whole list intact, and the header controls still fit the viewport.
  expect(await titles()).toEqual(['Sorted 1', 'Sorted 2', 'Sorted 3', 'Sorted 4']);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const box = await toggle.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);

  // Remembered across a reload (it is a setting, saved on the server).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Recommended' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('heading', { level: 2, name: 'Sorted 1', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Recommended' }).click();
  await expect(page.getByRole('button', { name: 'Recommended' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByTestId('sort-note')).toHaveCount(0);

  // The switch in Settings is the same setting.
  await page.goto('/settings');
  const sw = page.getByRole('switch', { name: 'Sort unread lists by recommended' });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  await page.goto('/all');
  await expect(page.getByRole('button', { name: 'Recommended' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Leave the setting as it was.
  await page.getByRole('button', { name: 'Recommended' }).click();
  await expect(page.getByRole('button', { name: 'Recommended' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
