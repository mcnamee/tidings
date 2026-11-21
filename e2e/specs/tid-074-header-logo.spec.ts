import { expect, signedInTest as test } from '../support/test.ts';

// Owner, 2026-11-21: All articles shows the Tidings logo, vertically centred with the header icons.
test('the All articles logo is centred with the header icons', async ({ page }) => {
  await page.goto('/all');
  await expect(page.getByTestId('header-logo')).toBeVisible();
  const mid = await page.evaluate(() => {
    const c = (el: Element | null) => {
      const b = el!.getBoundingClientRect();
      return (b.top + b.bottom) / 2;
    };
    const logo = document.querySelector('[data-testid="header-logo"]')!;
    return {
      menu: c(document.querySelector('header button svg')),
      mark: c(logo.querySelector('svg')),
    };
  });
  expect(Math.abs(mid.mark - mid.menu)).toBeLessThanOrEqual(1);
});
