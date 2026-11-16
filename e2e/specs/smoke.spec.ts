import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { expect, test } from '../support/test.ts';

// TID-005 AC2: every project runs a smoke test against the local app, plus an axe check.
// Projects: mobile-light, mobile-dark (375x812), desktop-light, desktop-dark (1280x800).

test.describe('smoke', () => {
  test('AC2: placeholder page renders and reaches the API', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tidings' })).toBeVisible();
    await expect(page.getByTestId('api-status')).toContainText('API ok');
  });

  test('AC2: project viewport and colour scheme are applied', async ({ page }, testInfo) => {
    await page.goto('/');
    const [mode, scheme] = testInfo.project.name.split('-');
    const viewport = page.viewportSize();
    expect(viewport?.width).toBe(mode === 'mobile' ? 375 : 1280);
    expect(viewport?.height).toBe(mode === 'mobile' ? 812 : 800);
    const prefersDark = await page.evaluate(
      () => matchMedia('(prefers-color-scheme: dark)').matches,
    );
    expect(prefersDark).toBe(scheme === 'dark');
  });

  test('AC2: no horizontal scroll at this width', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('AC2: axe reports zero serious/critical violations on the placeholder page', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('api-status')).toContainText('API ok');
    await expectNoSeriousA11yViolations(page);
  });

  test('client routes fall back to the SPA and unknown API paths are JSON 404s', async ({
    page,
    request,
  }) => {
    const response = await page.goto('/some/client/route');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Tidings' })).toBeVisible();
    const api = await request.get('/api/nope');
    expect(api.status()).toBe(404);
    expect((await api.json()).error.code).toBe('not_found');
  });

  test('fixture server is reachable from the test process', async ({ fixtureServer, request }) => {
    const res = await request.get(fixtureServer.url('/feeds/atom-basic.xml'));
    expect(res.status()).toBe(200);
    expect(fixtureServer.requests('/feeds/atom-basic.xml')).toHaveLength(1);
  });
});
