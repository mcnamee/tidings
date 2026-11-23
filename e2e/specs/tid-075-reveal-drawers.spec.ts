import type { CDPSession, Page } from '@playwright/test';
import { clearListData, seedListData } from '../support/list-data.ts';
import { closeFilters, openFilters } from '../support/filters.ts';
import { scrollTo, scrollY } from '../support/scroll.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-075: the navigation drawer and the Filters panel are revealed under the page (the page card
// slides aside, the panel is fixed beneath), and the header is a blurred translucent bar. Against
// the real Worker and a seeded D1. Touch swipes are real touch events sent over CDP; "installed"
// is faked with navigator.standalone (what iOS sets). The reveal is below lg: mobile projects.
// From lg the Filters panel stays an overlay (desktop-light checks that).
// TID_075_SHOTS=<dir> also writes the review screenshots (mobile projects), see docs/ux/reviews/tid-075.

const NOW = Math.floor(Date.now() / 1000);
const ROWS = 24;
const IMAGE = 'https://img.e2e.test/busy.svg';

// A deliberately busy picture: black and white checks and stripes, the worst case under a header.
const BUSY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><pattern id="c" width="60" height="60" patternUnits="userSpaceOnUse"><rect width="30" height="30" fill="#000"/><rect x="30" y="30" width="30" height="30" fill="#000"/><rect x="30" width="30" height="30" fill="#fff"/><rect y="30" width="30" height="30" fill="#fff"/></pattern></defs>
<rect width="1200" height="630" fill="url(#c)"/>
<circle cx="300" cy="300" r="220" fill="#e11d48" opacity="0.8"/><circle cx="800" cy="320" r="260" fill="#facc15" opacity="0.85"/>
</svg>`;

test.beforeEach(async ({ page }) => {
  clearListData();
  seedListData({
    folders: [],
    subs: [{ id: 's1', feedId: 9751, title: 'Reveal Feed' }],
    entries: Array.from({ length: ROWS }, (_, i) => ({
      id: 9800 + i,
      feedId: 9751,
      title: `Reveal row ${i + 1}`,
      summary: `Summary of reveal row ${i + 1}, long enough to take a line or two on a phone.`,
      imageUrl: IMAGE,
      contentHtml: `<p>Body ${i + 1}</p>`.repeat(40),
      publishedAt: NOW - 60 * (i + 1),
    })),
  });
  await page.route('https://img.e2e.test/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: BUSY_SVG }),
  );
});
test.afterAll(() => clearListData());

const mobileOnly = (name: string) =>
  test.skip(!name.startsWith('mobile'), 'the reveal is below lg: mobile projects');

async function installed(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
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
  await new Promise((r) => setTimeout(r, 150)); // rest, so the release is not a flick
  return () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function swipe(cdp: CDPSession, x0: number, x1: number, y = 400) {
  await (
    await hold(cdp, x0, x1, y)
  )();
}

const firstRow = (page: Page) =>
  page.getByRole('heading', { level: 2, name: 'Reveal row 1', exact: true });
const tx = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m41);
const headerBox = async (page: Page) => (await page.getByRole('banner').first().boundingBox())!;

test.describe('left drawer, revealed', () => {
  test('the page card (header included) moves 320 px aside over a fixed panel; the strip closes it; scroll is kept', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    await scrollTo(page, 300);
    const y = await scrollY(page);
    expect(y).toBeGreaterThan(100);
    const under = page.getByTestId('list-underlay');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    await expect(under).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 320, 0)');
    // The fixed header moved with the card, the panel sits still at its final place beneath it.
    expect((await headerBox(page)).x).toBeCloseTo(320, 0);
    const panel = await page.locator('#nav-drawer').boundingBox();
    expect(panel!.x).toBeCloseTo(0, 0);
    expect(panel!.width).toBeCloseTo(320, 0);
    // The page's corner nearest the panel is rounded, and the document is not scrolled (frozen).
    await expect(under).toHaveCSS('border-top-left-radius', '28px');
    expect(await scrollY(page)).toBe(0);
    // The page contents are inert; the visible strip of the card is the way out.
    expect(await page.getByRole('main').evaluate((e) => !!e.closest('[inert]'))).toBe(true);

    await page.getByTestId('drawer-scrim').click({ position: { x: 20, y: 300 } });
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
    await expect(page.locator('#nav-drawer')).toHaveCount(0); // after the slide-out
    await expect(under).toHaveCSS('transform', 'none');
    expect(await scrollY(page)).toBe(y); // exactly where it was
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
    expect((await headerBox(page)).x).toBeCloseTo(0, 0);
  });

  test('edge swipe drags the page with the finger, 40% opens it, a swipe left on the strip closes it', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await installed(page);
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    const under = page.getByTestId('list-underlay');

    // Cancel: a short drag follows the finger and springs back.
    const cancel = await hold(cdp, 46, 100, 400, 10);
    const mid = await tx(page, 'list-underlay');
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(120);
    expect((await headerBox(page)).x).toBeCloseTo(mid, 0);
    await cancel();
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    await expect(under).toHaveCSS('transform', 'none');

    // Commit: past 40% it finishes the slide.
    await swipe(cdp, 46, 240);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
    await expect(under).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 320, 0)');

    // A swipe left starting on the visible strip drags the page back; a short one springs open again.
    await swipe(cdp, 350, 330);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
    await expect(under).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 320, 0)');
    await swipe(cdp, 350, 120);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    await expect(under).toHaveCSS('transform', 'none');
  });

  test('with reduced motion it opens and closes with no slide', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByTestId('list-underlay')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, 320, 0)',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-drawer')).toHaveCount(0, { timeout: 500 });
  });

  test('Escape, the close button and a link each slide it out and leave the page usable', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    const opened = async () => {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    };
    await opened();
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    await opened();
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    await opened();
    await page.locator('#nav-drawer').getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator('#nav-drawer')).toHaveCount(0);
    await expect(page.getByTestId('list-underlay')).toHaveCSS('transform', 'none');
    expect(await scrollY(page)).toBe(0);
  });
});

test.describe('right Filters panel, revealed (mirrored)', () => {
  test('the page card slides left over a fixed panel; the strip closes it', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    await scrollTo(page, 300);
    const y = await scrollY(page);
    const under = page.getByTestId('list-underlay');

    const panel = await openFilters(page);
    await expect(under).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -320, 0)');
    await expect(under).toHaveCSS('border-top-right-radius', '28px');
    const box = await panel.boundingBox();
    expect(box!.x + box!.width).toBeCloseTo(375, 0);
    expect(box!.width).toBeCloseTo(320, 0);
    expect((await headerBox(page)).x).toBeCloseTo(-320, 0);

    // The visible strip is the card's right 55 px.
    await page.getByTestId('filter-scrim').click({ position: { x: 345, y: 300 } });
    await closeFilters(page);
    await expect(under).toHaveCSS('transform', 'none');
    expect(await scrollY(page)).toBe(y);
    await expect(page.getByRole('button', { name: 'Filters' })).toBeFocused();
  });

  test('a swipe right on the strip or the panel drags the page back and closes it', async ({
    page,
  }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await openFilters(page);
    const release = await hold(cdp, 150, 250);
    const x = await tx(page, 'list-underlay');
    expect(x).toBeGreaterThan(-320);
    expect(x).toBeLessThan(-150);
    await release();
    await closeFilters(page).catch(() => undefined);
    await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
    await expect(page.getByTestId('list-underlay')).toHaveCSS('transform', 'none');
  });
});

test.describe('from lg', () => {
  test('the Filters panel stays an overlay: the page does not move', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-light', 'desktop-light only');
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    await openFilters(page);
    await expect(page.getByTestId('filter-scrim')).toBeVisible();
    await expect(page.locator('.filter-panel')).toBeVisible();
    await expect(page.getByTestId('list-underlay')).toHaveCSS('transform', 'none');
    await closeFilters(page);
  });
});

test.describe('translucent header', () => {
  test('is blurred, translucent, clear of the first row at rest, and the list scrolls under it', async ({
    page,
  }) => {
    await page.goto('/all');
    await expect(firstRow(page)).toBeVisible();
    const header = page.getByRole('banner').first();
    const css = await header.evaluate((e) => {
      const s = getComputedStyle(e);
      return { filter: s.backdropFilter, image: s.backgroundImage };
    });
    expect(css.filter).toContain('blur(24px)');
    expect(css.filter).toContain('saturate(1.6)');
    // A gradient from the solid canvas at the top edge (runs on from the status bar) to the
    // translucent glass at the bottom.
    expect(css.image).toContain('linear-gradient');
    const alphas = [...css.image.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
      return parts.length === 4 ? Number(parts[3]) : 1;
    });
    expect(alphas[0]).toBe(1);
    const last = alphas[alphas.length - 1]!;
    expect(last).toBeGreaterThan(0.5);
    expect(last).toBeLessThan(1);

    // At rest the first row starts below the header's bottom edge (not hidden under it).
    const bottom = (await headerBox(page)).y + (await headerBox(page)).height;
    const top = (await page.locator('li[data-entry-id]').first().boundingBox())!.y;
    expect(top).toBeGreaterThanOrEqual(bottom - 1);
    // Scrolled, a row passes under the header (it is above the header's bottom edge, still painted).
    await scrollTo(page, 200);
    const under = await page.evaluate(() => {
      const h = document.querySelector('header')!.getBoundingClientRect();
      return [...document.querySelectorAll('li[data-entry-id]')].some((li) => {
        const r = li.getBoundingClientRect();
        return r.top < h.bottom && r.bottom > h.top;
      });
    });
    expect(under).toBe(true);
  });

  test('the article header is translucent too', async ({ page }, testInfo) => {
    mobileOnly(testInfo.project.name);
    await page.goto('/all/a/9800');
    await expect(page.getByRole('article')).toBeVisible();
    const filter = await page
      .getByRole('banner')
      .first()
      .evaluate((e) => getComputedStyle(e).backdropFilter);
    expect(filter).toContain('blur(24px)');
  });
});

test('review screenshots', async ({ page }, testInfo) => {
  const dir = process.env.TID_075_SHOTS;
  test.skip(!dir || !testInfo.project.name.startsWith('mobile'), 'only when TID_075_SHOTS is set');
  const theme = testInfo.project.name.replace('mobile-', '');
  await installed(page);
  await page.goto('/all');
  await expect(firstRow(page)).toBeVisible();
  await page.waitForTimeout(500); // images
  await page.screenshot({ path: `${dir}/375-${theme}-list.png` });
  await scrollTo(page, 330);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/375-${theme}-header-blur.png` });
  await scrollTo(page, 0);

  const cdp = await page.context().newCDPSession(page);
  const release = await hold(cdp, 46, 210, 500, 14);
  await page.screenshot({ path: `${dir}/375-${theme}-drawer-mid-drag.png` });
  await release();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/375-${theme}-drawer-open.png` });
  await page.keyboard.press('Escape');
  await expect(page.locator('#nav-drawer')).toHaveCount(0);

  const panel = await openFilters(page);
  await page.waitForTimeout(500);
  await expect(panel).toBeVisible();
  await page.screenshot({ path: `${dir}/375-${theme}-filters-open.png` });
  const rel2 = await hold(cdp, 150, 220, 500, 8);
  await page.screenshot({ path: `${dir}/375-${theme}-filters-mid-drag.png` });
  await rel2(); // short of 40%: springs back open
  await closeFilters(page);

  await page.goto('/all/a/9800');
  await expect(page.getByRole('article')).toBeVisible();
  await scrollTo(page, 200);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/375-${theme}-article-header.png` });
});
