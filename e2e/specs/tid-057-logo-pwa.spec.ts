import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { expect, signedInTest, test } from '../support/test.ts';

// TID-057 logo and installable shell (TID-023 AC4). Run in mobile-light and desktop-dark.

test.describe('TID-057 installable app files', () => {
  test('the manifest is served with the right type and fields', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/manifest\+json|application\/json/);
    const m = await res.json();
    expect(m).toMatchObject({
      id: '/',
      name: 'Tidings',
      short_name: 'Tidings',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    });
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(['192x192/any', '512x512/any', '512x512/maskable', 'any/any']),
    );
  });

  test('every manifest icon, the favicon and the touch icon load', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    const urls: string[] = [...m.icons.map((i: { src: string }) => i.src), '/apple-touch-icon.png'];
    for (const url of urls) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()['content-type'], url).toMatch(/^image\/(png|svg\+xml)/);
    }
  });

  test('the head links the manifest and icons and has the standalone meta tags', async ({
    page,
  }) => {
    await page.goto('/login');
    const attr = (sel: string, name: string) => page.locator(sel).getAttribute(name);
    expect(await attr('link[rel=manifest]', 'href')).toBe('/manifest.webmanifest');
    expect(await attr('link[rel=apple-touch-icon]', 'href')).toBe('/apple-touch-icon.png');
    expect(await attr('link[rel=icon]', 'href')).toBe('/favicon.svg');
    expect(await attr('meta[name=apple-mobile-web-app-capable]', 'content')).toBe('yes');
    expect(await attr('meta[name=mobile-web-app-capable]', 'content')).toBe('yes');
    expect(await attr('meta[name=apple-mobile-web-app-status-bar-style]', 'content')).toBe(
      'default',
    );
    expect(await attr('meta[name=apple-mobile-web-app-title]', 'content')).toBe('Tidings');
    expect(await attr('meta[name=viewport]', 'content')).toContain('viewport-fit=cover');
  });

  test('theme-color matches the resolved theme', async ({ page }, testInfo) => {
    const dark = testInfo.project.name.endsWith('dark');
    await page.goto('/login');
    await expect(page.locator('meta[name=theme-color]')).toHaveAttribute(
      'content',
      dark ? '#1b1c20' : '#ffffff',
    );
  });

  test('the sign-in screen shows the mark, passes axe and does not scroll sideways', async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto('/login');
    const mark = page.getByTestId('auth-main').locator('svg').first();
    await expect(mark).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    expect(violations).toEqual([]);
  });
});

signedInTest.describe('TID-057 signed-in shell', () => {
  signedInTest('the drawer or sidebar shows the lockup and passes axe', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // axe must not sample the drawer mid-slide
    await page.goto('/all');
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
    const nav = page.locator('aside, [role=dialog]').first();
    await expect(nav.getByText('Tidings', { exact: true })).toBeVisible();
    await expect(nav.locator('svg').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
