import { expect, signedInTest as test } from '../support/test.ts';

// TID-016 golden path against the real Worker: upload a small OPML file on /manage/import, read the
// preview, import, and see the feeds (and folder) in /manage. The feeds point at the local fixture
// server (never the real network), and the e2e Worker has no cron, so nothing is fetched here.

// State-changing requests need the app's Origin, or the CSRF guard refuses them with 403.
async function clean(page: import('@playwright/test').Page, origin: string) {
  const json = { 'Content-Type': 'application/json', Origin: origin };
  const subs = (await (await page.request.get('/api/subscriptions')).json()) as {
    items: { id: string }[];
  };
  for (const s of subs.items) {
    const r = await page.request.delete(`/api/subscriptions/${s.id}`, { headers: json });
    expect(r.ok()).toBe(true);
  }
  const folders = (await (await page.request.get('/api/folders')).json()) as {
    items: { id: string }[];
  };
  for (const f of folders.items)
    expect((await page.request.delete(`/api/folders/${f.id}`, { headers: json })).ok()).toBe(true);
}

test.describe('TID-016 OPML import', () => {
  test.beforeEach(async ({ page, baseURL }) => clean(page, baseURL!));
  test.afterEach(async ({ page, baseURL }) => clean(page, baseURL!));

  test('golden path: choose an OPML file, preview it, import, see the feeds in Manage', async ({
    page,
    fixtureServer,
  }) => {
    const url = (name: string) => fixtureServer.url(`/feeds/${name}`);
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><head><title>Subscriptions</title></head><body>
  <outline text="Tech" title="Tech">
    <outline type="rss" text="Alpha Imported" title="Alpha Imported" xmlUrl="${url('rss2-basic.xml')}"/>
    <outline type="rss" text="Bravo Imported" title="Bravo Imported" xmlUrl="${url('atom-basic.xml')}"/>
  </outline>
  <outline type="rss" text="Charlie Imported" title="Charlie Imported" xmlUrl="${url('rdf-basic.xml')}"/>
  <outline type="rss" text="Broken" title="Broken" xmlUrl="not a url"/>
</body></opml>`;

    await page.goto('/manage');
    await page.getByRole('link', { name: 'Import from OPML' }).click();
    await expect(page).toHaveURL(/\/manage\/import$/);
    await expect(page.getByRole('heading', { name: 'Choose your file' })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'small.opml',
      mimeType: 'text/x-opml',
      buffer: Buffer.from(opml),
    });

    // The preview comes before anything is sent (AC1): 4 outlines with a feed, 1 folder, 1 invalid.
    await expect(page.getByRole('heading', { name: 'Found 4 feeds in 1 folder' })).toBeVisible();
    await expect(page.getByText('0 already subscribed')).toBeVisible();
    await expect(page.getByText('1 invalid')).toBeVisible();
    const subsBefore = (await (await page.request.get('/api/subscriptions')).json()) as {
      items: unknown[];
    };
    expect(subsBefore.items).toHaveLength(0);

    await page.getByRole('button', { name: 'Import 3 feeds' }).click();
    await expect(page.getByRole('heading', { name: 'Fetching your feeds' })).toBeVisible();
    await expect(page.getByText('Fetched 0 of 3 feeds')).toBeVisible();
    await expect(page.getByText('3 feeds added')).toBeVisible();
    await expect(page.getByText('1 feed could not be imported')).toBeVisible();

    // The feeds are in Manage, and the OPML title is the feed's name.
    await page.goto('/manage');
    for (const title of ['Alpha Imported', 'Bravo Imported', 'Charlie Imported'])
      await expect(page.getByRole('button', { name: `${title}, options` })).toBeVisible();

    // Folder matched by name, nothing fetched.
    const folders = (await (await page.request.get('/api/folders')).json()) as {
      items: { name: string }[];
    };
    expect(folders.items.map((f) => f.name)).toEqual(['Tech']);
  });
});
