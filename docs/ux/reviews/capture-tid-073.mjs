// UX review capture for TID-073 (caught-up illustrations).
// Usage: start `npm run dev -w @tidings/web`, then BASE=http://localhost:5173 node docs/ux/reviews/capture-tid-073.mjs
// The API is faked with page.route, so no worker is needed. CHROME_PATH picks the browser binary.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'tid-073');
mkdirSync(OUT, { recursive: true });

const sub = {
  id: 's1',
  folderId: null,
  title: 'Daring Fireball',
  customTitle: null,
  feedUrl: 'https://s1.example.com/rss',
  siteUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  health: {
    state: 'ok',
    lastSuccessAt: '2026-11-17T11:00:00.000Z',
    lastAttemptAt: '2026-11-17T11:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    nextFetchAt: '2026-11-17T13:00:00.000Z',
    warning: null,
  },
};
const bodies = {
  '/api/auth/session': {
    user: { id: 'u1', displayName: 'Matt', role: 'owner', settings: {} },
    setupRequired: false,
    mustAddPasskey: false,
  },
  '/api/folders': { items: [] },
  '/api/subscriptions': { items: [sub] },
  '/api/counts': { total: 0, folders: {}, subscriptions: {} },
  '/api/entries': { items: [], nextCursor: null, asOf: new Date().toISOString() },
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const report = [];
for (const [label, viewport, mobile] of [
  ['375', { width: 375, height: 812 }, true],
  ['1280', { width: 1280, height: 800 }, false],
]) {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = bodies[path];
      return route.fulfill({
        status: body ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(body ?? { error: { code: 'not_found', message: 'x' } }),
      });
    });
    await page.goto(`${BASE}/all`);
    await page.getByText('All caught up').first().waitFor();
    await page.waitForSelector('#splash', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid=caught-up-art] img')].every(
        (i) => i.offsetParent === null || i.complete,
      ),
    );
    const info = await page.evaluate(() => {
      const art = document.querySelector('[data-testid=caught-up-art]');
      const imgs = [...art.querySelectorAll('img')].map((i) => ({
        src: i.getAttribute('src'),
        shown: i.offsetParent !== null,
        w: Math.round(i.getBoundingClientRect().width),
        loaded: i.complete && i.naturalWidth > 0,
      }));
      return {
        imgs,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    report.push({ label, scheme, ...info });
    await page.screenshot({ path: join(OUT, `caught-up-${label}-${scheme}.png`) });
    await ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
