import type { Page } from '@playwright/test';

// TID-069: the document (window) is the scroller on every layout; below lg the header and bottom
// bar are position: fixed over it. (TID-064 had a scrolling <main> below lg; it is gone.) While an
// article is open below lg, the document scrolls the article and the list is frozen underneath.

/** The current scroll offset of the page. */
export const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

/** Scrolls the page to `y`, or to its very end when `y` is 'end'. */
export const scrollTo = (page: Page, y: number | 'end'): Promise<void> =>
  page.evaluate(async (target) => {
    for (let i = 0; i < (target === 'end' ? 6 : 1); i++) {
      window.scrollTo(0, target === 'end' ? document.documentElement.scrollHeight : target);
      await new Promise((r) => setTimeout(r, 60));
    }
  }, y);

/** Scrolls the page by dy px, as a thumb flick would. */
export const scrollBy = (page: Page, dy: number): Promise<void> =>
  page.evaluate((delta) => window.scrollBy(0, delta), dy);
