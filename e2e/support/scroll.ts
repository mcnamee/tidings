import type { Page } from '@playwright/test';

// TID-064: below lg the signed-in shell's <main> is the scroll container and the document never
// scrolls; from lg the document scrolls. These helpers read and move whichever one scrolls.

/** The current scroll offset of the page's scroller. */
export const scrollY = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('[data-testid="main-scroll"]');
    return main && getComputedStyle(main).overflowY === 'auto' ? main.scrollTop : window.scrollY;
  });

/** Scrolls the page's scroller to `y`, or to its very end when `y` is 'end'. */
export const scrollTo = (page: Page, y: number | 'end'): Promise<void> =>
  page.evaluate(async (target) => {
    const main = document.querySelector<HTMLElement>('[data-testid="main-scroll"]');
    const inner = main !== null && getComputedStyle(main).overflowY === 'auto';
    for (let i = 0; i < (target === 'end' ? 6 : 1); i++) {
      if (inner) main.scrollTo(0, target === 'end' ? main.scrollHeight : target);
      else window.scrollTo(0, target === 'end' ? document.documentElement.scrollHeight : target);
      await new Promise((r) => setTimeout(r, 60));
    }
  }, y);

/** Scrolls the page scroller by dy px, as a thumb flick would. */
export const scrollBy = (page: Page, dy: number): Promise<void> =>
  page.evaluate((delta) => {
    const main = document.querySelector<HTMLElement>('[data-testid="main-scroll"]');
    if (main && getComputedStyle(main).overflowY === 'auto') main.scrollBy(0, delta);
    else window.scrollBy(0, delta);
  }, dy);
