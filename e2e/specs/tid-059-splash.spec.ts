import { expect, signedInTest } from '../support/test.ts';

// TID-059 launch screen. Automation normally skips the 1 s minimum; this overrides that.
// Runs in every project, so both themes are covered by the light and dark projects.
signedInTest(
  'the launch screen shows on load for at least 1 s, then is removed',
  async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __TIDINGS_SPLASH_MIN__: boolean }).__TIDINGS_SPLASH_MIN__ = true;
    });
    const started = Date.now();
    await page.goto('/all');
    const splash = page.locator('#splash');
    await expect(splash).toBeAttached();
    await expect(splash).toHaveAttribute('aria-hidden', 'true');

    // The splash sits on the resolved theme's surface colour (CSSOM, so no inline style attribute).
    const colours = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--c-surface)';
      document.body.append(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const el = document.getElementById('splash');
      return { surface, splash: el ? getComputedStyle(el).backgroundColor : null };
    });
    expect(colours.splash).toBe(colours.surface);

    await page.waitForTimeout(500);
    await expect(splash).toBeAttached();
    await expect(splash).toHaveCount(0, { timeout: 5000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  },
);
