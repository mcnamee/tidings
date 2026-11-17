import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-019 article view and read state, against the real Worker and a seeded D1. Written by the SE
// and not yet run: the tester owns running and extending it. Projects: mobile-light, mobile-dark
// (375x812), desktop-light, desktop-dark. Unit and component tests cover the rest of the ACs
// (apps/web/src/reader, apps/web/src/lib/sanitize.test.ts, apps/worker/test/entry-read.test.ts).

const NOW = Math.floor(Date.now() / 1000);

// AC5: the corpus. Each payload tries to set the global canary or open a dialog.
const PAYLOADS = [
  '<script>window.__pwned = 1; alert(1)</script>',
  '<img src="https://e2e.invalid/x.png" onerror="window.__pwned = 1; alert(2)">',
  '<a href="javascript:window.__pwned=1;alert(3)">js link</a>',
  '<iframe src="https://video.example/embed/1"></iframe>',
  '<iframe srcdoc="<script>parent.__pwned=1;alert(4)</script>"></iframe>',
  '<svg onload="window.__pwned=1;alert(5)"><circle r="1"/></svg>',
  '<style>body { display: none }</style>',
  '<form action="https://evil.example"><input name="p"><button>go</button></form>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<p>Marker paragraph</p>',
].join('\n');

const RELATIVE =
  '<p>Rel</p><a href="/about">about</a><img src="/img/big.png" width="3000" height="10">';

// The tree is always visible on desktop. At 375px the article screen has no menu button (it has
// Back), so the counts there are covered by ArticleView.test.tsx and after DEF-070 by Back.
const hasTree = (testInfo: import('@playwright/test').TestInfo) =>
  !testInfo.project.name.startsWith('mobile');
const allCount = (page: import('@playwright/test').Page) =>
  page.getByRole('link', { name: /^All articles \d+ unread$/ });

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [{ id: 'f1', name: 'Tech' }],
    subs: [{ id: 's1', feedId: 9201, title: 'Ars Technica', folderId: 'f1' }],
    entries: [
      {
        id: 9301,
        feedId: 9201,
        title: 'Corpus',
        author: 'A. Writer',
        url: 'https://example.com/blog/post/1',
        contentHtml: PAYLOADS,
        publishedAt: NOW - 3600,
      },
      {
        id: 9302,
        feedId: 9201,
        title: 'Relative',
        url: 'https://example.com/blog/post/2',
        contentHtml: RELATIVE,
        publishedAt: NOW - 7200,
      },
      {
        id: 9303,
        feedId: 9201,
        title: 'Vec<T> & <b>x</b>',
        author: '<img src=x onerror=alert(6)>',
        url: 'https://example.com/blog/post/3',
        contentHtml: '<p>Third</p>',
        publishedAt: NOW - 9000,
      },
    ],
  });
});
test.afterAll(() => clearListData());

test('AC5: the XSS corpus runs nothing and leaves no forbidden element', async ({ page }) => {
  const dialogs: string[] = [];
  const errors: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/all/a/9301');
  const content = page.getByTestId('article-content');
  await expect(content.getByText('Marker paragraph')).toBeVisible();
  await page.waitForTimeout(300);

  for (const selector of ['script', 'iframe', 'style', 'form', 'input', 'svg', 'base', 'meta']) {
    await expect(content.locator(selector), selector).toHaveCount(0);
  }
  await expect(content.locator('[onerror], [onload], [srcdoc]')).toHaveCount(0);
  await expect(content.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(content.getByRole('link', { name: 'Open embedded content' })).toHaveAttribute(
    'href',
    'https://video.example/embed/1',
  );
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('AC6: relative links resolve, images are lazy and never overflow at 375px', async ({
  page,
}) => {
  await page.goto('/all/a/9302');
  const content = page.getByTestId('article-content');
  await expect(content.getByRole('link', { name: 'about' })).toHaveAttribute(
    'href',
    'https://example.com/about',
  );
  const img = content.locator('img');
  await expect(img).toHaveAttribute('src', 'https://example.com/img/big.png');
  await expect(img).toHaveAttribute('loading', 'lazy');
  await expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('AC11: markup in the title and author is shown as text', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto('/all/a/9303');
  const article = page.getByRole('article');
  await expect(article.getByRole('heading', { level: 2 })).toHaveText('Vec<T> & <b>x</b>');
  await expect(article).toContainText('<img src=x onerror=alert(6)>');
  await expect(article.locator('img, b')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
});

test('AC2, AC4: opening marks read (optimistic), Mark as unread undoes it', async ({ page }) => {
  await page.goto('/all');
  await page.getByRole('link', { name: /Corpus/ }).click();
  await expect(page.getByRole('button', { name: 'Mark as unread' })).toBeVisible({ timeout: 1000 });
  await page.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toBeVisible();
  await page.reload();
  // The server kept the last state: unread, and a reload re-opens it, which marks it read again.
  await expect(page.getByRole('button', { name: 'Mark as unread' })).toBeVisible();
});

// DEF-070: Next crashes the screen in Chromium (window.scrollTo returns a Promise). Remove `.fail` when fixed.
test.fail(
  'AC7: Next and Previous replace, and Back returns to the list in one step',
  async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('/all');
    await page.getByRole('link', { name: /Corpus/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Relative' })).toBeVisible();
    await page.waitForTimeout(700); // the failing effect cleanup runs after paint
    expect(pageErrors).toEqual([]);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('link', { name: /Corpus/ })).toBeVisible();
  },
);

test('axe is clean on an article', async ({ page }) => {
  await page.goto('/all/a/9303');
  await expect(page.getByRole('article')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

// DEF-071: feed images usually have no alt text, and the sanitiser leaves them as they are, so axe
// reports a critical image-alt violation. Remove `.fail` when the sanitiser adds alt="".
test.fail('DEF-071: axe is clean on an article whose feed image has no alt', async ({ page }) => {
  await page.goto('/all/a/9302');
  await expect(page.getByRole('article')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

// ---- Tester additions (TID-019) ----

test('AC2: opening drops the unread count at once and sends PATCH {isRead:true}', async ({
  page,
}, testInfo) => {
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH')
      patches.push(`${r.url().replace(/^.*\/api/, '/api')} ${r.postData()}`);
  });
  await page.goto('/all');
  if (hasTree(testInfo)) {
    await expect(allCount(page)).toHaveAccessibleName('All articles 3 unread');
  }
  await page.getByRole('link', { name: /Corpus/ }).click();
  await expect(page.getByRole('button', { name: 'Mark as unread' })).toBeVisible({ timeout: 1000 });
  await expect.poll(() => patches).toEqual(['/api/entries/9301 {"isRead":true}']);
  if (hasTree(testInfo)) {
    await expect(allCount(page)).toHaveAccessibleName('All articles 2 unread');
  }
});

test('AC3: a failing PATCH rolls the state and counts back and shows a toast', async ({
  page,
}, testInfo) => {
  await page.route('**/api/entries/9301', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":{"code":"internal","message":"x"}}',
        })
      : route.continue(),
  );
  await page.goto('/all');
  if (hasTree(testInfo)) {
    await expect(allCount(page)).toHaveAccessibleName('All articles 3 unread');
  }
  await page.getByRole('link', { name: /Corpus/ }).click();
  await expect(page.getByText("Couldn't update that article. Try again.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toBeVisible();
  if (hasTree(testInfo)) {
    await expect(allCount(page)).toHaveAccessibleName('All articles 3 unread');
  }
});

// DEF-070, as above.
test.fail(
  'AC7: Back returns to the list at the same scroll position after Next and Previous',
  async ({ page }) => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: 9400 + i,
      feedId: 9201,
      title: `Scroll row ${String(i).padStart(2, '0')}`,
      contentHtml: `<p>Body ${i}</p>`,
      publishedAt: NOW - 100 - i,
    }));
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    seedListData({ entries: many });
    await page.goto('/all');
    const row = page.getByRole('link', { name: /Scroll row 25/ });
    await row.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(200);
    await row.click();
    await expect(page.getByRole('heading', { level: 2, name: 'Scroll row 25' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Scroll row 26' })).toBeVisible();
    await page.waitForTimeout(700); // the failing effect cleanup runs after paint
    expect(pageErrors).toEqual([]);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('link', { name: /Scroll row 25/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 150);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before + 150);
  },
);

const HOSTILE = [
  '<p>Hostile marker</p>',
  '<a href=" javascript:window.__pwned=1;alert(1)">lead space</a>',
  '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><script>parent.__pwned=1;alert(2)</script></svg>#x"/></svg>',
  '<style>@import url(https://e2e.invalid/x.css);</style>',
  '<form><button formaction="javascript:window.__pwned=1;alert(3)">go</button></form>',
  '<p style="background:url(https://e2e.invalid/t.gif)">css url</p>',
  '<svg></p><style><a id="</style><img src=1 onerror=window.__pwned=1;alert(4)>">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__pwned=1;alert(5)&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1;alert(6)>">',
  '<details open ontoggle="window.__pwned=1;alert(7)"><summary>d</summary></details>',
].join('\n');

test('hostile mXSS, namespace and CSS payloads run nothing in Chromium', async ({ page }) => {
  seedListData({
    entries: [
      {
        id: 9501,
        feedId: 9201,
        title: 'Hostile',
        url: 'https://example.com/h',
        contentHtml: HOSTILE,
        publishedAt: NOW - 50,
      },
    ],
  });
  const dialogs: string[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/all/a/9501');
  const content = page.getByTestId('article-content');
  await expect(content.getByText('Hostile marker')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(
    content.locator('script, style, svg, math, form, input, button, noscript, iframe'),
  ).toHaveCount(0);
  await expect(
    content.locator('[style], [onerror], [ontoggle], [formaction], [id], [class]'),
  ).toHaveCount(0);
  await expect(content.locator('a[href^="javascript:"], a[href^=" "]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(requests.filter((u) => u.includes('e2e.invalid'))).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('huge and deeply nested content renders without crashing and stays inside 375px', async ({
  page,
}) => {
  // At the 100 KB cap on stored content (spec 6.2), swapped into the API response because it is too long for the D1 CLI.
  const huge = '<p>lorem ipsum <a href="/a">link</a> <img src="/i.png" width="4000"></p>'.repeat(
    1_400,
  );
  const nested = '<div>'.repeat(20_000) + 'Deep marker' + '<script>window.__pwned=1</script>';
  seedListData({
    entries: [
      {
        id: 9601,
        feedId: 9201,
        title: 'Huge',
        url: 'https://example.com/huge',
        contentHtml: '<p>x</p>',
        publishedAt: NOW - 60,
      },
      {
        id: 9602,
        feedId: 9201,
        title: 'Nested',
        url: 'https://example.com/nested',
        contentHtml: '<p>x</p>',
        publishedAt: NOW - 61,
      },
    ],
  });
  for (const [id, html] of [
    ['9601', huge],
    ['9602', nested],
  ] as const) {
    await page.route(`**/api/entries/${id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      return route.fulfill({ response: res, json: { ...body, contentHtml: html } });
    });
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto('/all/a/9601');
  await expect(page.getByTestId('article-content').locator('p').first()).toBeVisible({
    timeout: 20_000,
  });
  expect(Date.now() - t0).toBeLessThan(5_000);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto('/all/a/9602');
  await expect(page.getByTestId('article-content')).toContainText('Deep marker', {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('hostile entry IDs in the URL show "not found" and send no write', async ({ page }) => {
  test.setTimeout(120_000);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`);
  });
  for (const id of ['0', '-1', '99999999999999999999', "1'%20OR%201=1--", '%3Cscript%3E']) {
    await page.goto(`/all/a/${id}`);
    await expect(page.getByRole('heading', { name: /couldn't find that article/ })).toBeVisible({
      timeout: 15_000,
    });
  }
  expect(writes).toEqual([]);
});

// DEF-072: a 404 is retried three times with back-off, so "We couldn't find that article" appears
// after about 7 s and the skeleton shows meanwhile. Remove `.fail` when a 4xx is not retried.
test.fail('DEF-072: a missing article says so within 2 s', async ({ page }) => {
  await page.goto('/all/a/999999');
  await expect(page.getByRole('heading', { name: /couldn't find that article/ })).toBeVisible({
    timeout: 2000,
  });
});
