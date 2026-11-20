import type { CDPSession, Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';
import { scrollBy, scrollTo, scrollY } from '../support/scroll.ts';

// TID-054 (title opens the original), TID-026 (mark as read on scroll) and TID-055 (edge swipes in
// the installed app), against the real Worker and a seeded D1. Touch swipes are real touch events
// sent over CDP; "installed" is faked with navigator.standalone (what iOS sets). Mobile projects
// only for the gestures: they are off at desktop width.

const NOW = Math.floor(Date.now() / 1000);
const ROWS = 30;

test.beforeEach(() => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9401, title: 'Gesture Feed' }],
    entries: Array.from({ length: ROWS }, (_, i) => ({
      id: 9500 + i,
      feedId: 9401,
      title: `Row ${i + 1}`,
      url: i === 1 ? undefined : `https://example.com/gesture/${i + 1}`,
      contentHtml: `<p>Body ${i + 1}</p>`,
      publishedAt: NOW - 60 * (i + 1),
    })),
  });
});
test.afterAll(() => clearListData());

const mobileOnly = (name: string) => test.skip(!name.startsWith('mobile'), 'gestures are mobile');

async function installed(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
}

// Swipes start beyond the left-edge strip iOS keeps for its own swipe-back (IOS_EDGE_PX = 32).
/** One finger from (x0, y) to (x1, y), in steps 16 ms apart so it is a drag, not a flick. */
async function swipe(cdp: CDPSession, x0: number, x1: number, y = 400, steps = 12) {
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

/** Puts a finger down at x0 and drags to x1, then holds. Returns the release. */
async function hold(cdp: CDPSession, x0: number, x1: number, y = 400, steps = 12) {
  const pt = (x: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt(x0 + ((x1 - x0) * i) / steps),
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 150));
  return () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('TID-054: the title opens the original', () => {
  test('is a link in a new tab, and plain text without a URL', async ({ page }) => {
    await page.goto('/all/a/9500');
    const link = page.getByRole('link', { name: 'Row 1', exact: true });
    await expect(link).toHaveAttribute('href', 'https://example.com/gesture/1');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await page.keyboard.press('Tab'); // TID-069: focus rings are for keyboard use
    await link.focus();
    await expect(link).toHaveCSS('outline-style', 'solid');

    await page.goto('/all/a/9501');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 2', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Row 2', exact: true })).toHaveCount(0);
  });
});

test.describe('TID-026: mark as read on scroll', () => {
  test('rows scrolled past are marked read in batched calls and stay visible', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    const calls: string[][] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/entries/read-state') && req.method() === 'POST') {
        calls.push((req.postDataJSON() as { entryIds: string[] }).entryIds);
      }
    });
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();

    // Scroll down in steps, as a thumb would, until the first rows are above the header.
    for (let i = 0; i < 6; i++) {
      await scrollBy(page, 150);
      await page.waitForTimeout(50);
    }
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toHaveClass(
      /text-fg-muted/,
    );
    // Still in the unread-only list.
    await expect(
      page.getByRole('heading', { level: 2, name: 'Row 1', exact: true }),
    ).toBeAttached();
    await expect.poll(() => calls.length, { timeout: 6000 }).toBeGreaterThan(0);
    expect(calls.flat()).toContain('9500');
    expect(calls.every((c) => c.length >= 1)).toBe(true);
    // A row further down was not scrolled past.
    await expect(
      page.getByRole('heading', { level: 2, name: `Row ${ROWS}`, exact: true }),
    ).toHaveClass(/font-semibold/);
  });

  test('the same rows are read after a reload', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await scrollBy(page, 150);
      await page.waitForTimeout(50);
    }
    await page.waitForResponse((r) => r.url().endsWith('/api/entries/read-state'));
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toHaveCount(
      0,
    );
  });
});

test.describe('TID-055: swipe gestures in the installed app', () => {
  test('a left-edge swipe opens the drawer; swiping it left closes it', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);

    await swipe(cdp, 5, 260); // TID-069: from the very edge
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS('transform', 'none');

    await swipe(cdp, 260, 40);
    await expect(drawer).toHaveCount(0);

    // Short and slow: snaps back, no drawer.
    await swipe(cdp, 46, 90, 400, 20);
    await expect(drawer).toHaveCount(0);
    // Vertical scroll from the edge is left alone.
    const before = await scrollY(page);
    await swipe(cdp, 48, 48, 600);
    expect(await scrollY(page)).toBe(before);
  });

  test('in a browser tab the edge swipe does nothing', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 46, 300);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  });

  test('on an article an edge swipe past 35% goes back one step to the list', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await page.goto('/all');
    await page.locator('a[href^="/all/a/9502"]').click();
    await expect(page.getByRole('article')).toBeVisible();
    const cdp = await page.context().newCDPSession(page);

    await swipe(cdp, 46, 120, 400, 20); // 20%: snaps back
    await expect(page).toHaveURL(/\/all\/a\/9502/);
    await expect(page.getByRole('article')).toBeVisible();

    await swipe(cdp, 46, 240); // 52%
    await expect(page).toHaveURL(/\/all(\?|$)/);
    await expect(page.getByRole('heading', { level: 2, name: 'Row 3', exact: true })).toBeVisible();
    // The page is back in place, not left off to the side.
    await expect(page.locator('main')).toBeInViewport();
  });

  test('with reduced motion the drawer still opens, nothing is dragged', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installed(page);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 46, 260);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  });

  test('the drawer keeps going from the finger to open: same element, no second slide-in', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);

    const release = await hold(cdp, 46, 240);
    // Mid-drag: a peeking panel, partly out, with no entrance animation of its own.
    await page.evaluate(() => {
      const el = document.getElementById('nav-drawer');
      if (!el) throw new Error('no peeking drawer');
      const w = window as unknown as { __d: Element; __s: { same: boolean; left: number }[] };
      w.__d = el;
      w.__s = [];
      const tick = () => {
        const cur = document.getElementById('nav-drawer');
        w.__s.push({ same: cur === w.__d, left: cur?.getBoundingClientRect().left ?? NaN });
        requestAnimationFrame(tick);
      };
      tick();
    });
    expect(
      await page.evaluate(() => document.getElementById('nav-drawer')?.getAnimations().length),
    ).toBe(0);
    await release();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    await page.waitForTimeout(500);
    const samples = await page.evaluate(
      () => (window as unknown as { __s: { same: boolean; left: number }[] }).__s,
    );
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((x) => x.same)).toBe(true);
    // Never moves back toward the edge once released (no jump), and ends fully open.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.left).toBeGreaterThanOrEqual(samples[i - 1]!.left - 0.5);
    }
    expect(samples.at(-1)!.left).toBe(0);
    expect(
      await page.evaluate(() => document.getElementById('nav-drawer')?.getAnimations().length),
    ).toBe(0);

    // And a swipe-close goes straight out: same element, only ever moving left.
    await page.evaluate(() => {
      const w = window as unknown as { __d: Element; __s: { same: boolean; left: number }[] };
      w.__s = [];
    });
    await swipe(cdp, 260, 40);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
    const out = await page.evaluate(
      () => (window as unknown as { __s: { same: boolean; left: number }[] }).__s,
    );
    const lefts = out.filter((x) => x.same && !Number.isNaN(x.left)).map((x) => x.left);
    for (let i = 1; i < lefts.length; i++)
      expect(lefts[i]!).toBeLessThanOrEqual(lefts[i - 1]! + 0.5);
  });

  test('swipe back from an article shows the list underneath, then lands on it unmoved', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 2, name: 'Row 1', exact: true })).toBeVisible();
    await scrollTo(page, 400);
    const y = await scrollY(page);
    expect(y).toBeGreaterThan(100);
    const href = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/all/a/"]')]
          .find((a) => a.getBoundingClientRect().top > 200)
          ?.getAttribute('href') ?? '',
    );
    await page.locator(`a[href="${href}"]`).click();
    await expect(page.getByRole('article')).toBeVisible();
    // One heading set exposed; the list is there but inert and hidden.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const under = page.getByTestId('list-underlay');
    await expect(under).toHaveAttribute('inert', '');
    // TID-069: the article is the document scroller (at the top); the list is frozen under it.
    expect(await scrollY(page)).toBe(0);
    await expect(page.getByTestId('main-scroll')).toHaveCSS('top', `-${y}px`);
    const cdp = await page.context().newCDPSession(page);

    // Cancel: the article slides back, the list returns underneath.
    const cancel = await hold(cdp, 46, 100, 400, 20);
    await expect(under).toBeInViewport();
    expect(await under.evaluate((e) => (e as HTMLElement).style.transform)).toMatch(
      /translateX\(-/,
    );
    await cancel();
    await expect(page.getByRole('article')).toBeVisible();
    await expect(page.getByTestId('article-layer')).toHaveCSS('transform', 'none');
    await expect(under).toHaveCSS('transform', 'none');

    // Mid-drag: the list is visible beneath, shifted left, and the scrim is lighter than at rest.
    const end = await hold(cdp, 46, 240);
    const layerX = await page
      .getByTestId('article-layer')
      .evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m41);
    const underX = await under.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m41);
    expect(layerX).toBeGreaterThan(100);
    expect(underX).toBeLessThan(0);
    expect(underX).toBeGreaterThan(-0.3 * 375);
    const scrim = await page
      .getByTestId('article-scrim')
      .evaluate((e) => Number((e as HTMLElement).style.opacity));
    expect(scrim).toBeGreaterThan(0);
    expect(scrim).toBeLessThan(1);
    await end();

    await expect(page).toHaveURL(/\/all(\?|$)/);
    await expect(page.getByTestId('article-layer')).toHaveCount(0);
    await expect(under).toHaveCSS('transform', 'none');
    expect(await scrollY(page)).toBe(y);
  });
});
