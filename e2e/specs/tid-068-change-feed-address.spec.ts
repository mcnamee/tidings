import type { Page } from '@playwright/test';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-068 golden path, against the real Worker and the local fixture feed server: follow a feed,
// change its address from Manage to another feed, see the new feed's title, and get the same
// inline error as Add feed for a page with several feeds.

const OLD_PATH = '/feeds/rss2-basic.xml';
const OLD_TITLE = 'RSS 2.0 Basic Example';
const NEW_PATH = '/feeds/atom-basic.xml';
const NEW_TITLE = 'Atom Basic Example';

async function clean(page: Page, origin: string) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  const subs = (await (await page.request.get('/api/subscriptions')).json()) as {
    items: { id: string }[];
  };
  for (const s of subs.items) {
    const res = await page.request.delete(`/api/subscriptions/${s.id}`, { headers });
    expect(res.ok()).toBe(true);
  }
}

test.describe('TID-068 change a feed address', () => {
  test.beforeEach(async ({ page, baseURL }) => clean(page, baseURL!));
  test.afterEach(async ({ page, baseURL }) => clean(page, baseURL!));

  test('golden path: change the address, see the new feed; a private address is refused and a page with several feeds offers a choice', async ({
    page,
    fixtureServer,
  }) => {
    await page.goto('/manage/add');
    await page.getByLabel('Feed or website address').fill(fixtureServer.url(OLD_PATH));
    await page.getByRole('button', { name: 'Add feed' }).click();
    await expect(page.getByRole('heading', { level: 1, name: OLD_TITLE })).toBeVisible();

    await page.goto('/manage');
    await page.getByRole('button', { name: `${OLD_TITLE}, options` }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Change feed address' }).click();
    await expect(sheet.getByRole('heading', { name: 'Change feed address' })).toBeVisible();
    await expect(sheet.getByText(fixtureServer.url(OLD_PATH))).toBeVisible();

    // A private address is refused under the field, with the Add feed copy.
    await sheet.getByLabel('New feed or website address').fill('http://169.254.169.254/latest');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet.getByText('This address is not allowed.')).toBeVisible();

    // A page with two feeds: choose between them, like Add feed. "Atom feed" is atom-basic.xml.
    await sheet
      .getByLabel('New feed or website address')
      .fill(fixtureServer.url('/feeds/not-a-feed.html'));
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'We found 2 feeds on this site' }),
    ).toBeVisible();
    await sheet.getByRole('button', { name: /Atom feed/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: `${NEW_TITLE}, options` })).toBeVisible();
    await expect(page.getByRole('button', { name: `${OLD_TITLE}, options` })).toHaveCount(0);

    // The subscription is the same one: still a single feed in the list.
    const subs = (await (await page.request.get('/api/subscriptions')).json()) as {
      items: { feedUrl: string }[];
    };
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0]?.feedUrl).toBe(fixtureServer.url(NEW_PATH));
  });
});
