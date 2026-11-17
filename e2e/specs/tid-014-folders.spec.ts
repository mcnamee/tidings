import type { Page } from '@playwright/test';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-014 golden path, against the real Worker and a local fixture feed server: add a feed, make a
// folder, move the feed into it, see it in the drawer, unsubscribe. AC9 (visual match) is the UX pass.

const FEED_PATH = '/feeds/rss2-basic.xml';
const FEED_TITLE = 'RSS 2.0 Basic Example';

/** The drawer: a modal dialog below 1024px, a permanent aside above it. */
async function drawer(page: Page, mobile: boolean) {
  if (!mobile) return page.locator('aside');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDrawer(page: Page, mobile: boolean) {
  if (mobile) await page.getByRole('button', { name: 'Close navigation' }).click();
}

/** Leaves the shared seeded owner with no folders or feeds, before and after. */
// State-changing requests need the app's Origin, or the CSRF guard refuses them with 403.
async function clean(page: Page, origin: string) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  const subs = (await (await page.request.get('/api/subscriptions')).json()) as {
    items: { id: string }[];
  };
  for (const s of subs.items) {
    const res = await page.request.delete(`/api/subscriptions/${s.id}`, { headers });
    expect(res.ok()).toBe(true);
  }
  const folders = (await (await page.request.get('/api/folders')).json()) as {
    items: { id: string }[];
  };
  for (const f of folders.items) {
    const res = await page.request.delete(`/api/folders/${f.id}`, { headers });
    expect(res.ok()).toBe(true);
  }
}

test.describe('TID-014 folders and subscription management', () => {
  test.beforeEach(async ({ page, baseURL }) => clean(page, baseURL!));
  test.afterEach(async ({ page, baseURL }) => clean(page, baseURL!));

  test('golden path: add a feed, create a folder, move the feed into it, see it in the drawer, unsubscribe', async ({
    page,
    fixtureServer,
  }, testInfo) => {
    const mobile = testInfo.project.name.startsWith('mobile');

    // Add the feed (TID-013), served by the fixture server.
    await page.goto('/manage/add');
    await page.getByLabel('Feed or website address').fill(fixtureServer.url(FEED_PATH));
    await page.getByRole('button', { name: 'Add feed' }).click();
    // A successful first fetch opens the feed's list (TID-013 AC1).
    await expect(page.getByRole('heading', { level: 1, name: FEED_TITLE })).toBeVisible();

    // Create a folder (AC1).
    await page.goto('/manage');
    await expect(page.getByRole('button', { name: `${FEED_TITLE}, options` })).toBeVisible();
    await page.getByRole('button', { name: 'New folder' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Folder name').fill('Tech');
    await sheet.getByRole('button', { name: 'Create folder' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Rename Tech' })).toBeVisible();

    // A duplicate in another case is refused inline (AC2).
    await page.getByRole('button', { name: 'New folder' }).click();
    await sheet.getByLabel('Folder name').fill('tech');
    await sheet.getByRole('button', { name: 'Create folder' }).click();
    await expect(sheet.getByRole('alert')).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toBeHidden();

    // Move the feed into it (AC4).
    await page.getByRole('button', { name: `${FEED_TITLE}, options` }).click();
    await sheet.getByRole('button', { name: 'Move to folder' }).click();
    await sheet.getByRole('button', { name: 'Tech' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: `${FEED_TITLE}, options` })).toContainText(
      'Tech',
    );

    // The drawer lists the folder, with the feed beneath it.
    const nav = await drawer(page, mobile);
    // Folders start collapsed in the drawer (TID-018 AC6); names may carry an unread count.
    const expand = nav.getByRole('button', { name: 'Expand Tech' });
    if (await expand.isVisible()) await expand.click();
    const folderLink = nav.getByRole('link', { name: /^Tech( \d+ unread)?$/ });
    const feedLink = nav.getByRole('link', { name: FEED_TITLE });
    await expect(folderLink).toBeVisible();
    await expect(feedLink).toBeVisible();
    const folderBox = await folderLink.boundingBox();
    const feedBox = await feedLink.boundingBox();
    expect(feedBox && folderBox && feedBox.y > folderBox.y && feedBox.x > folderBox.x).toBe(true);
    await closeDrawer(page, mobile);

    // The server agrees, so it is not only optimistic UI state.
    const subs = (await (await page.request.get('/api/subscriptions')).json()) as {
      items: { title: string; folderId: string | null }[];
    };
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0]?.folderId).not.toBeNull();

    // Unsubscribe after confirming (AC7). Cancel first changes nothing.
    await page.getByRole('button', { name: `${FEED_TITLE}, options` }).click();
    await sheet.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(
      sheet.getByRole('heading', { name: `Unsubscribe from ${FEED_TITLE}?` }),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: `${FEED_TITLE}, options` })).toBeVisible();

    await page.getByRole('button', { name: `${FEED_TITLE}, options` }).click();
    await sheet.getByRole('button', { name: 'Unsubscribe' }).click();
    await sheet.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByText("You aren't following any feeds yet.")).toBeVisible();
    const after = (await (await page.request.get('/api/subscriptions')).json()) as {
      items: unknown[];
    };
    expect(after.items).toEqual([]);

    // The folder stays, empty, and the drawer no longer lists the feed.
    const nav2 = await drawer(page, mobile);
    await expect(nav2.getByRole('link', { name: /^Tech( \d+ unread)?$/ })).toBeVisible();
    await expect(nav2.getByRole('link', { name: FEED_TITLE })).toHaveCount(0);
  });
});
