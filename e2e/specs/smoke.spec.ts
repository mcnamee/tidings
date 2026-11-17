import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-005 AC2: every project runs a smoke test against the local app, plus an axe check.
// Projects: mobile-light, mobile-dark (375x812), desktop-light, desktop-dark (1280x800).

test.describe('smoke', () => {
  // TID-006 replaced the TID-001 placeholder page with the app shell: "/" now lands on /all.
  test('AC2: the app shell renders and the API is reachable', async ({ page, request }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect((await health.json()).ok).toBe(true);
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

  test('AC2: axe reports zero serious/critical violations on the shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test('client routes fall back to the SPA and unknown API paths are JSON 404s', async ({
    page,
    request,
  }) => {
    const response = await page.goto('/some/client/route');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    // Signed in (page.request shares the context's cookie): a JSON 404. Signed out: a 401, because
    // every /api path needs a session unless it is Public (TID-008).
    const api = await page.request.get('/api/nope');
    expect(api.status()).toBe(404);
    expect((await api.json()).error.code).toBe('not_found');
    const anonymous = await request.get('/api/nope');
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).error.code).toBe('unauthenticated');
  });

  test('fixture server is reachable from the test process', async ({ fixtureServer, request }) => {
    const res = await request.get(fixtureServer.url('/feeds/atom-basic.xml'));
    expect(res.status()).toBe(200);
    expect(fixtureServer.requests('/feeds/atom-basic.xml')).toHaveLength(1);
  });
});
