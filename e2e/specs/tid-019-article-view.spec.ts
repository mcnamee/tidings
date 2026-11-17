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

test('AC7: Next and Previous replace, and Back returns to the list in one step', async ({
  page,
}) => {
  await page.goto('/all');
  await page.getByRole('link', { name: /Corpus/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Relative' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/all$/);
  await expect(page.getByRole('link', { name: /Corpus/ })).toBeVisible();
});

test('axe is clean on an article', async ({ page }) => {
  await page.goto('/all/a/9302');
  await expect(page.getByRole('article')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
