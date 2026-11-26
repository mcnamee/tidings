import type { APIRequestContext, CDPSession, Page } from '@playwright/test';
import { axeViolations } from '../support/axe.ts';
import { clearListData, packTopics, seedListData, type SeedEntry } from '../support/list-data.ts';
import { scrollTo, scrollY } from '../support/scroll.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-078: the topic chip row on All articles and the Topics setting, against the real Worker and a seeded
// D1 (articles carry packed topics straight in `entries.topics`; tagging itself is TID-077). Runs on
// mobile-light and desktop-dark, and on both mobile themes when TID_078_SHOTS=<dir> is set, which also writes
// the review screenshots (docs/ux/reviews/tid-078). The edge swipes fake "installed" with navigator.standalone.

const ORIGIN = `http://localhost:${process.env.E2E_APP_PORT ?? 8788}`;
const NOW = Math.floor(Date.now() / 1000);
const AI = 13;
const F1 = 21;
const UK = 28;
const TECH = 12;
const ALL_SLUGS = [
  'ai',
  'formula-1',
  'uk-politics',
  'technology',
  'world-news',
  'middle-east',
  'ukraine-russia',
  'us-politics',
  'economy',
  'science',
  'space',
  'health',
  'sport',
  'gaming',
];

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(
    !['mobile-light', 'desktop-dark'].includes(testInfo.project.name) &&
      !(process.env.TID_078_SHOTS && testInfo.project.name.startsWith('mobile')),
    'mobile-light and desktop-dark only',
  );
  clearListData();
  const entries: SeedEntry[] = [];
  let t = 600;
  const add = (title: string, topics: number | undefined, isRead = false) =>
    entries.push({
      id: 9900 + entries.length,
      feedId: 9781,
      title,
      summary: `Summary of ${title}, long enough to take a line or two on a phone.`,
      contentHtml: `<p>Body of ${title}</p>`.repeat(30),
      publishedAt: NOW - (t += 120),
      isRead,
      ...(topics === undefined ? {} : { topics }),
    });
  // Newest first: a mix of topics, so a topic list is a sparse slice of All.
  for (let i = 1; i <= 19; i++) {
    add(`F1 story ${i}`, packTopics(F1));
    if (i % 3 === 0) add(`AI story ${i / 3}`, packTopics(AI, TECH));
    if (i % 7 === 0) add(`UK story ${i / 7}`, packTopics(UK, F1));
    if (i % 5 === 0) add(`Plain story ${i / 5}`, undefined);
  }
  add('F1 old story', packTopics(F1), true);
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9781, title: 'Topic Feed' }],
    entries,
  });
});
test.afterEach(async ({ page }) => {
  await setChips(page.request, []);
});
test.afterAll(() => clearListData());

async function setChips(request: APIRequestContext, topicChips: string[]) {
  // The Worker refuses a write with no Origin (spec 10.3); a browser always sends one.
  const res = await request.patch('/api/me', {
    data: { settings: { topicChips } },
    headers: { Origin: ORIGIN },
  });
  expect(res.status()).toBe(200);
}
async function chipsOnServer(request: APIRequestContext) {
  return ((await (await request.get('/api/me')).json()) as { settings: { topicChips?: string[] } })
    .settings.topicChips;
}
const mobileOnly = (name: string) =>
  test.skip(!name.startsWith('mobile'), 'the edge swipe is below lg: mobile projects');
const row = (page: Page) => page.getByRole('group', { name: 'Topics' });
const chip = (page: Page, name: string) => row(page).getByRole('button', { name, exact: true });
const titles = (page: Page) => page.getByRole('heading', { level: 2 }).allTextContents();
const story = (page: Page, title: string) =>
  page.getByRole('heading', { level: 2, name: title, exact: true });

async function installed(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
}
async function hold(cdp: CDPSession, x0: number, x1: number, y: number, steps = 12) {
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

test('Settings, Topics: choose topics, put them in order by keyboard and by drag, and the chips follow', async ({
  page,
}, testInfo) => {
  await page.goto('/all');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  await expect(row(page)).toHaveCount(0); // none chosen: no row

  await page.goto('/settings');
  const link = page.getByRole('link', { name: /^Topics\s*None chosen/ });
  await link.click();
  await expect(page).toHaveURL('/settings/topics');
  await expect(page.getByRole('heading', { level: 1, name: 'Topics' })).toBeVisible();
  const chosen = page.getByRole('list', { name: 'On the chips' });
  await expect(page.getByText('No topics chosen. All articles has no chip row.')).toBeVisible();

  for (const name of ['AI', 'Formula 1', 'UK politics']) {
    await page.getByRole('button', { name: `Add ${name} to chips`, exact: true }).click();
  }
  await expect(chosen.getByRole('listitem')).toHaveCount(3);
  // Keyboard path: Move AI down once (Formula 1, AI, UK politics), announced.
  await page.getByRole('button', { name: 'Move AI down', exact: true }).click();
  await expect(page.getByTestId('topics-status')).toHaveText('AI moved to position 2 of 3.');
  await expect(page.getByRole('button', { name: 'Move AI down', exact: true })).toBeFocused();
  await expect.poll(() => chipsOnServer(page.request)).toEqual(['formula-1', 'ai', 'uk-politics']);

  // Mouse or touch: drag UK politics to the top by its grip.
  const grip = page.getByTestId('grip-uk-politics');
  const from = (await grip.boundingBox())!;
  const top = (await chosen.getByRole('listitem').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, top.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(chosen.getByRole('listitem').first()).toContainText('UK politics');
  await expect(page.getByTestId('topics-status')).toHaveText(
    'UK politics moved to position 1 of 3.',
  );
  await expect.poll(() => chipsOnServer(page.request)).toEqual(['uk-politics', 'formula-1', 'ai']);
  expect(await axeViolations(page)).toEqual([]);

  // Every chosen row's controls are 44 px.
  for (const b of await chosen.getByRole('button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL('/settings');
  await expect(page.getByTestId('topics-summary')).toHaveText(
    '3 chosen: UK politics, Formula 1, AI',
  );

  // The chips show on All articles in that order, and survive a reload (they are on the server).
  await page.goto('/all');
  await expect(row(page)).toBeVisible();
  await expect(row(page).getByRole('button')).toHaveText(['All', 'UK politics', 'Formula 1', 'AI']);
  await expect(chip(page, 'All topics')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(row(page).getByRole('button')).toHaveText(['All', 'UK politics', 'Formula 1', 'AI']);
  void testInfo;
});

test('chips filter All articles, the URL and header follow, and opening an article then Back returns to the same filtered list at the same place', async ({
  page,
}) => {
  await setChips(page.request, ['ai', 'formula-1', 'uk-politics']);
  await page.goto('/all');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  // The row sits first in the list, one line, every chip a 44 px target.
  const rowBox = (await row(page).boundingBox())!;
  for (const b of await row(page).getByRole('button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await axeViolations(page)).toEqual([]);

  await chip(page, 'Formula 1').click();
  await expect(page).toHaveURL('/all?topic=formula-1');
  await expect(chip(page, 'Formula 1')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'All topics')).toHaveAttribute('aria-pressed', 'false');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  await expect(story(page, 'AI story 1')).toHaveCount(0);
  const shown = await titles(page);
  expect(shown.length).toBeGreaterThan(19);
  // F1 is in any of an article's slots: the two UK stories tagged [UK, F1] are in the list too.
  expect(shown.filter((x) => x.startsWith('F1 story')).length).toBe(19);
  expect(shown.filter((x) => x.startsWith('UK story')).length).toBe(2);
  expect(shown.some((x) => x.startsWith('AI story') || x.startsWith('Plain'))).toBe(false);
  await expect(page.getByRole('banner').first()).toContainText('Formula 1');
  await expect(page).toHaveTitle('Formula 1 - All articles - Tidings');

  // Scroll down, open an article, Back (the header button): same chip, same list, same scroll position.
  await scrollTo(page, 700);
  const y = await scrollY(page);
  const visible = page
    .getByRole('heading', { level: 2, name: /^F1 story/ })
    .filter({ has: page.locator(':scope') });
  const target = await visible.evaluateAll((els) => {
    const el = els.find((e) => {
      const r = e.getBoundingClientRect();
      return r.top > 150 && r.bottom < window.innerHeight - 20;
    });
    return el?.textContent ?? null;
  });
  expect(target).not.toBeNull();
  await story(page, target!).click();
  await expect(page).toHaveURL(/\/all\/a\/\d+\?state=unread&topic=formula-1$/);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL('/all?topic=formula-1');
  await expect(chip(page, 'Formula 1')).toHaveAttribute('aria-pressed', 'true');
  await expect(story(page, 'F1 story 1')).toHaveCount(1);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(y - 3);
  expect(Math.abs((await scrollY(page)) - y)).toBeLessThanOrEqual(3);

  // "All" clears it; a deep link selects the chip; an unknown topic falls back to All without an error.
  await chip(page, 'All topics').click();
  await expect(page).toHaveURL('/all');
  await expect(story(page, 'AI story 1')).toBeVisible();
  // (Scrolling past rows marked some of them read, so ask for read ones too.)
  await page.goto('/all?topic=uk-politics&state=all');
  await expect(chip(page, 'UK politics')).toHaveAttribute('aria-pressed', 'true');
  await expect(story(page, 'UK story 1')).toBeVisible();
  await page.goto('/all?topic=not-a-topic');
  await expect(chip(page, 'All topics')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL('/all');
  await expect(story(page, 'AI story 1')).toBeVisible();
  // Folder and feed views never have the row.
  await page.goto('/feeds/s1?topic=ai');
  await expect(story(page, 'AI story 1')).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await expect(page).toHaveURL('/feeds/s1');
});

test('Unread only applies within a topic, and Mark all as read marks only that topic', async ({
  page,
}) => {
  await setChips(page.request, ['ai', 'formula-1']);
  await page.goto('/all?topic=formula-1');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  // Unread only off: the read F1 article is in the list.
  await page.getByRole('button', { name: 'Filters' }).click();
  const panel = page.getByRole('dialog', { name: 'Filters' });
  await panel.getByRole('switch', { name: 'Unread only' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/all?topic=formula-1&state=all');
  await expect(story(page, 'F1 old story')).toBeAttached();
  await page.getByRole('button', { name: 'Filters' }).click();
  await panel.getByRole('switch', { name: 'Unread only' }).click();
  await page.keyboard.press('Escape');
  await expect(story(page, 'F1 old story')).toHaveCount(0);

  await page.getByRole('button', { name: 'Mark all as read' }).click();
  // 19 Formula 1 articles and the UK stories that carry the F1 tag: 21 loaded unread, so it asks first.
  const sheet = page.getByRole('dialog', { name: /^Mark \d+ Formula 1 articles as read\?$/ });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^Mark \d+ as read$/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Formula 1 articles as read/ }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing unread in Formula 1' })).toBeVisible();
  await expect(page.getByText(/within about an hour/)).toHaveCount(0);
  // The chip row stays, and Show all topics goes back.
  await expect(chip(page, 'Formula 1')).toHaveAttribute('aria-pressed', 'true');

  // Articles of other topics stay unread.
  const ai = await (
    await page.request.get('/api/entries?view=all&state=unread&topic=ai&limit=50')
  ).json();
  expect(ai.items.length).toBe(6);
  const plain = await (
    await page.request.get('/api/entries?view=all&state=unread&limit=100')
  ).json();
  expect(plain.items.some((i: { title: string }) => i.title.startsWith('Plain'))).toBe(true);
  expect(plain.items.some((i: { title: string }) => i.title.startsWith('F1 story'))).toBe(false);
  await page.getByRole('button', { name: 'Show all topics' }).click();
  await expect(page).toHaveURL('/all?state=unread');
  await expect(story(page, 'AI story 1')).toBeVisible();
});

test('a topic page that comes back empty with a cursor keeps loading until it finds rows (scan limit)', async ({
  page,
}) => {
  await setChips(page.request, ['ai', 'formula-1']);
  // The API's own scan cannot be shrunk from here, so the browser is told the first page was empty with a
  // cursor (what a topic deep in the list does) and the follow-up request is answered for real.
  let requests = 0;
  await page.route(/\/api\/entries\?.*topic=ai/, async (route) => {
    requests++;
    const url = new URL(route.request().url());
    if (!url.searchParams.has('cursor')) {
      return route.fulfill({
        json: { items: [], nextCursor: 'ZmFrZQ', asOf: new Date().toISOString(), sort: 'newest' },
      });
    }
    url.searchParams.delete('cursor');
    return route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  await page.goto('/all?topic=ai');
  await expect(story(page, 'AI story 1')).toBeVisible();
  await expect(page.getByText(/Nothing unread in/)).toHaveCount(0);
  expect(requests).toBe(2);
});

test('the chip row scrolls sideways without opening the menu or scrolling the list; the left edge still opens the menu', async ({
  page,
}, testInfo) => {
  mobileOnly(testInfo.project.name);
  await installed(page);
  await setChips(page.request, ALL_SLUGS);
  await page.goto('/all');
  await expect(row(page)).toBeVisible();
  await expect(story(page, 'F1 story 1')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const box = (await row(page).boundingBox())!;
  const y = box.y + box.height / 2;
  const scrollLeft = () => row(page).evaluate((e) => e.scrollLeft);
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  // 14 chips are wider than 375 px, and the right edge fades (the row can scroll).
  expect(await row(page).evaluate((e) => e.scrollWidth > e.clientWidth + 100)).toBe(true);
  await expect(row(page)).toHaveAttribute('data-fade-end', 'true');
  const pageY = await scrollY(page);

  // A swipe left on the row scrolls the chips, and neither the menu nor the list moves.
  await hold(cdp, 300, 80, y);
  expect(await scrollLeft()).toBeGreaterThan(100);
  await expect(drawer).toHaveCount(0);
  expect(await scrollY(page)).toBe(pageY);
  await expect(row(page)).toHaveAttribute('data-fade-start', 'true');

  // A swipe right from the middle of the row scrolls it back, and does not open the menu.
  const left = await scrollLeft();
  await hold(cdp, 100, 300, y);
  expect(await scrollLeft()).toBeLessThan(left - 50);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('list-underlay')).toHaveCSS('transform', 'none');

  // From the very edge, over the same row, the swipe still opens the menu.
  await hold(cdp, 10, 260, y);
  await expect(drawer).toBeVisible();
  await page.getByTestId('drawer-scrim').click({ position: { x: 20, y: 300 } });
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('#nav-drawer')).toHaveCount(0);

  // Elsewhere on the page the menu swipe works as before.
  await hold(cdp, 120, 300, y + 300);
  await expect(drawer).toBeVisible();
});

test('desktop: the chips are one row at the top of the column, keyboard-operable, with scroll buttons for a long row', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'desktop layout');
  await setChips(page.request, ['ai', 'formula-1', 'uk-politics']);
  await page.goto('/all');
  await expect(row(page)).toBeVisible();
  await expect(chip(page, 'All topics')).toHaveAttribute('aria-pressed', 'true');
  await chip(page, 'AI').focus();
  await page.keyboard.press('ArrowRight');
  await expect(chip(page, 'Formula 1')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/all?topic=formula-1');
  await expect(chip(page, 'Formula 1')).toHaveAttribute('aria-pressed', 'true');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  await expect(story(page, 'AI story 1')).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // A long row has a scroll button at the end (mouse users with no horizontal wheel); it scrolls the row.
  await setChips(page.request, ALL_SLUGS);
  await page.goto('/all');
  await expect(row(page)).toBeVisible();
  const next = page.getByTestId('topic-chips').locator('button[aria-hidden="true"]').first();
  await expect(next).toBeVisible();
  await next.click();
  await expect.poll(() => row(page).evaluate((e) => e.scrollLeft)).toBeGreaterThan(100);
  await page.goto('/settings/topics');
  await expect(page.getByRole('list', { name: 'On the chips' }).getByRole('listitem')).toHaveCount(
    14,
  );
  expect(await axeViolations(page)).toEqual([]);
});

test('review screenshots', async ({ page }, testInfo) => {
  const dir = process.env.TID_078_SHOTS;
  test.skip(!dir || !testInfo.project.name.startsWith('mobile'), 'only when TID_078_SHOTS is set');
  const theme = testInfo.project.name.replace('mobile-', '');
  await setChips(page.request, ['ai', 'formula-1', 'uk-politics']);
  await page.goto('/all');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  await page.screenshot({ path: `${dir}/375-${theme}-chips-none-selected.png` });

  await chip(page, 'Formula 1').click();
  await expect(chip(page, 'Formula 1')).toHaveAttribute('aria-pressed', 'true');
  await expect(story(page, 'F1 story 1')).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${dir}/375-${theme}-chips-one-selected.png` });

  await scrollTo(page, 420);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/375-${theme}-chips-scrolled-header.png` });

  await setChips(page.request, ALL_SLUGS);
  await page.goto('/all?topic=ai');
  await expect(row(page)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${dir}/375-${theme}-chips-many-fade.png`,
    clip: { x: 0, y: 0, width: 375, height: 220 },
  });

  await setChips(page.request, ['ai', 'formula-1', 'uk-politics']);
  await page.goto('/settings/topics');
  await expect(page.getByRole('list', { name: 'On the chips' })).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/375-${theme}-topics.png` });
  await page.screenshot({ path: `${dir}/375-${theme}-topics-full.png`, fullPage: true });

  await page.goto('/all?topic=ai&state=unread');
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/375-${theme}-chips-empty-topic.png` });
});
