import type { BrowserContext, Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/axe.ts';
import { clearListData, seedListData } from '../support/list-data.ts';
import { expect, signedInTest as test } from '../support/test.ts';

// TID-006 QA suite (tester-owned): independent strengthening of the engineer's specs in
// tid-006-app-shell.spec.ts. Projects: mobile-light, mobile-dark (375x812), desktop-light, desktop-dark.

const LIST_ROUTES = ['/all', '/folders/f1', '/feeds/s1'];
const ALL_ROUTES = [
  '/setup',
  '/login',
  '/recover',
  ...LIST_ROUTES,
  // A real entry ID (TID-019): the AC6 console test seeds it, so the API answers 200, not 404.
  '/all/a/9101001',
  '/folders/f1/a/9101001',
  '/feeds/s1/a/9101001',
  '/manage',
  '/manage/add',
  '/manage/import',
  '/settings',
  '/no/such/page',
];

const isMobile = (name: string) => name.startsWith('mobile');
const osScheme = (name: string) => (name.endsWith('dark') ? 'dark' : 'light');

// ---------------------------------------------------------------------------------------------
// AC1: no flash. Pixel sampling of the frames the compositor actually produced during load.
// ---------------------------------------------------------------------------------------------

type Tone = 'dark' | 'light' | 'other';

/** Decode PNG screencast frames in a scratch page and classify the bottom-centre pixel. */
async function classifyFrames(context: BrowserContext, frames: string[]): Promise<Tone[]> {
  const scratch = await context.newPage();
  try {
    return await scratch.evaluate(async (list) => {
      const out: Tone[] = [];
      for (const b64 of list) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin]));
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(bmp, 0, 0);
        // Bottom-centre of the viewport is plain canvas/main background on every shell screen.
        const [r = 0, g = 0, b = 0] = ctx.getImageData(
          Math.floor(bmp.width / 2),
          bmp.height - 4,
          1,
          1,
        ).data;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        out.push(lum < 70 ? 'dark' : lum > 200 ? 'light' : 'other');
      }
      return out;
    }, frames);
  } finally {
    await scratch.close();
  }
}

/** Load /all with the stylesheet held back, recording every composited frame. */
async function loadAndCaptureFrames(
  page: Page,
  context: BrowserContext,
  opts: { holdCssMs: number; blockThemeInit?: boolean },
): Promise<Tone[]> {
  const cdp = await context.newCDPSession(page);
  const frames: string[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push(f.data);
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });
  await page.route('**/assets/*.css', async (route) => {
    await new Promise((r) => setTimeout(r, opts.holdCssMs));
    await route.continue();
  });
  if (opts.blockThemeInit) {
    await page.route('**/theme-init.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
  }
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.goto('/all');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(400); // let the last frames arrive
  await cdp.send('Page.stopScreencast');
  return classifyFrames(context, frames);
}

test.describe('TID-006 AC1 no flash (pixels)', () => {
  test('AC1 pixels: OS scheme with no stored preference, every composited frame has the right tone', async ({
    page,
    context,
  }, testInfo) => {
    const expected = osScheme(testInfo.project.name);
    const tones = await loadAndCaptureFrames(page, context, { holdCssMs: 1000 });
    expect(tones.length, 'screencast produced frames').toBeGreaterThanOrEqual(2);
    expect(tones, `frame tones: ${tones.join(',')}`).toEqual(tones.map(() => expected));
  });

  // FR-ST-1 and NFR-10: "no flash of the wrong theme", including when the stored choice differs from the OS.
  // DEF-002: while the stylesheet loads, the canvas follows the OS (meta color-scheme), not the stored choice.
  // The pixel version of this check is timing-dependent (the pre-stylesheet frame is not always
  // composited), so this asserts the cause deterministically: by DOMContentLoaded, with the stylesheet
  // still held back, the colour scheme the browser will paint the canvas with equals the chosen theme.
  test('AC1: before the stylesheet arrives the canvas colour scheme equals the stored choice (DEF-002)', async ({
    page,
  }, testInfo) => {
    const os = osScheme(testInfo.project.name);
    const stored = os === 'dark' ? 'light' : 'dark';
    await page.addInitScript((v) => localStorage.setItem('tidings.theme', v), stored);
    await page.route('**/assets/*.css', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const nav = page.goto('/all', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
    const canvasScheme = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content');
      const os = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return meta === 'light dark' || meta === 'dark light' ? os : meta;
    });
    await nav;
    expect(canvasScheme).toBe(stored);
  });

  // Control: proves the detector works. With theme-init.js disabled and a dark OS, the held-back
  // stylesheet resolves to the light tokens, and a light frame (or a missing data-theme) must be seen.
  test('AC1 control: without theme-init.js the dark OS flashes light, so the pixel check can fail', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(!testInfo.project.name.endsWith('dark'), 'only a dark OS can flash light');
    const tones = await loadAndCaptureFrames(page, context, {
      holdCssMs: 800,
      blockThemeInit: true,
    });
    expect(tones).toContain('light');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('AC1 paint timing: the first painted frame already has the final theme tokens', async ({
    page,
  }, testInfo) => {
    const expected = osScheme(testInfo.project.name);
    await page.addInitScript(() => {
      const w = window as unknown as {
        __p: { firstPaint: number | null; s: Array<[number, string]> };
      };
      w.__p = { firstPaint: null, s: [] };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (e.name === 'first-paint') w.__p.firstPaint = e.startTime;
      }).observe({ type: 'paint', buffered: true });
      const tick = () => {
        const html = document.documentElement;
        w.__p.s.push([performance.now(), html ? getComputedStyle(html).backgroundColor : 'none']);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.route('**/assets/*.css', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.goto('/all');
    await page.waitForTimeout(300);
    const p = await page.evaluate(
      () =>
        (window as unknown as { __p: { firstPaint: number | null; s: Array<[number, string]> } })
          .__p,
    );
    expect(p.firstPaint, 'first-paint entry').not.toBeNull();
    const fp = p.firstPaint ?? 0;
    const expectedBg = expected === 'dark' ? 'rgb(19, 20, 23)' : 'rgb(246, 245, 241)';
    // Frames at or after the first paint (allow one frame of slack for rAF timestamp ordering).
    const after = p.s.filter(([t]) => t >= fp - 17);
    expect(after.length).toBeGreaterThan(0);
    for (const [, bg] of after) expect(bg).toBe(expectedBg);
  });
});

// ---------------------------------------------------------------------------------------------
// Storage edge cases: localStorage blocked, corrupted values.
// ---------------------------------------------------------------------------------------------

test.describe('TID-006 storage edge cases', () => {
  const blockStorage = async (page: Page) => {
    await page.addInitScript(() => {
      // Chrome with "block all cookies" throws SecurityError on the property access itself.
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
  };

  // DEF-003: lastList.ts evaluates `localStorage` in a default parameter, outside its try/catch.
  test('localStorage blocked: the app still renders, follows the OS and "/" lands on /all (DEF-003)', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await blockStorage(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      osScheme(testInfo.project.name),
    );
    expect(errors).toEqual([]);
  });

  test('localStorage blocked: theme-init falls back to the OS and live changes still work', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await blockStorage(page);
    await page.goto('/all');
    // theme-init.js runs before React; it must not have thrown even if the app later does.
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      osScheme(testInfo.project.name),
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'm');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(errors.filter((e) => !/localStorage|insecure/i.test(e))).toEqual([]);
  });

  test('localStorage setItem throwing (quota) does not break navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('quota', 'QuotaExceededError');
      };
    });
    await page.goto('/folders/f1');
    await page.goto('/');
    await expect(page).toHaveURL(/\/all$/);
    expect(errors).toEqual([]);
  });

  const CORRUPT = [
    '',
    'https://evil.example/',
    '//evil.example/all',
    '/\\evil.example',
    'javascript:alert(1)',
    '/manage',
    '/settings',
    '/all/a/e1',
    '/folders/',
    '/folders/../all',
    '/folders/f1/extra',
    '/all\n',
    '/all?x=1',
    '/folders/<script>',
    '{"path":"/all"}',
    '/' + 'a'.repeat(5000),
  ];
  for (const bad of CORRUPT) {
    test(`"/" ignores corrupted lastList ${JSON.stringify(bad).slice(0, 40)}`, async ({ page }) => {
      await page.addInitScript((v) => localStorage.setItem('tidings.lastList', v), bad);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
      const url = new URL(page.url());
      expect(url.origin).toBe(new URL(test.info().project.use.baseURL ?? page.url()).origin);
      expect(url.pathname).toBe('/all');
      await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    });
  }

  test('"/" accepts each valid list shape and an article route is never remembered', async ({
    page,
  }) => {
    // TID-018 AC11: a stored folder or feed has to exist, or "/" falls back to /all.
    seedListData({
      folders: [{ id: 'f_1-x', name: 'Valid shape' }],
      subs: [{ id: 's1', feedId: 9101, title: 'Feed one' }],
    });
    try {
      for (const ok of ['/all', '/folders/f_1-x', '/feeds/s1']) {
        // Set the value from a non-list page. A list page records itself as the last list once the
        // session check resolves (TID-008), which could overwrite the value set here on a slow runner.
        await page.goto('/settings');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.evaluate((v) => localStorage.setItem('tidings.lastList', v), ok);
        await page.goto('/');
        await expect(page).toHaveURL(new RegExp(`${ok}$`));
      }
    } finally {
      clearListData();
    }
    await page.goto('/feeds/s7');
    // A list records itself once the session check resolves, so wait for the shell to render.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/feeds/s7/a/e1');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/settings');
    expect(await page.evaluate(() => localStorage.getItem('tidings.lastList'))).toBe('/feeds/s7');
  });

  test('corrupted theme and text-size values fall back to system and M', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem('tidings.theme', '{"x":1}');
      localStorage.setItem('tidings.textSize', 'xxl');
    });
    await page.goto('/all');
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      osScheme(testInfo.project.name),
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'm');
  });

  test('a stored text size applies before React renders', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('tidings.textSize', 'l'));
    await page.goto('/all');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'l');
  });
});

// ---------------------------------------------------------------------------------------------
// AC2/AC3 extras: other tabs, theme-color, stored choices.
// ---------------------------------------------------------------------------------------------

test.describe('TID-006 theming extras', () => {
  test('AC3: theme-color meta follows live OS changes', async ({ page }) => {
    await page.goto('/all');
    const meta = page.locator('meta[name=theme-color]');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(meta).toHaveAttribute('content', '#131417');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(meta).toHaveAttribute('content', '#f6f5f1');
  });

  test('AC2/AC3: a theme chosen in another tab applies here without reload and can be cleared', async ({
    page,
    context,
  }, testInfo) => {
    await page.goto('/all');
    const os = osScheme(testInfo.project.name);
    const other = os === 'dark' ? 'light' : 'dark';
    const second = await context.newPage();
    await second.goto('/settings');
    await second.evaluate((v) => localStorage.setItem('tidings.theme', v), other);
    await expect(page.locator('html')).toHaveAttribute('data-theme', other);
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', other);
    await second.evaluate(() => localStorage.removeItem('tidings.theme'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', os);
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', 'system');
    await second.close();
  });

  test('AC2: stored "system" behaves like no preference and the rendered colours really change with the theme', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('tidings.theme', 'system'));
    await page.goto('/all');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(19, 20, 23)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 245, 241)');
  });

  test('AC2: an explicit light or dark choice paints the matching colours under the opposite OS', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('tidings.theme', 'light'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/all');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 245, 241)');
    // TID-075: the header glass runs from the light canvas to the canvas at 75%, blurred behind.
    await expect(page.locator('header')).toHaveCSS(
      'background-image',
      /linear-gradient\(rgb\(246, 245, 241\).*rgba\(246, 245, 241, 0\.75\)/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// AC4 extras: drawer under stress (mobile only).
// ---------------------------------------------------------------------------------------------

test.describe('TID-006 drawer stress (mobile)', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), 'drawer is below 1024px');
  });

  const menu = (page: Page) => page.getByRole('button', { name: 'Open navigation' });
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });

  test('AC4: ten rapid open/close cycles end closed, on the same URL, focus on Menu', async ({
    page,
  }) => {
    await page.goto('/all');
    for (let i = 0; i < 10; i++) {
      await menu(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    }
    await expect(page).toHaveURL(/\/all$/);
    await expect(menu(page)).toBeFocused();
    await expect(menu(page)).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.className)).not.toContain(
      'scroll-locked',
    );
  });

  test('AC4: five close/reopen rounds via the Close button and the scrim stay in sync with history', async ({
    page,
  }) => {
    await page.goto('/all');
    for (let i = 0; i < 5; i++) {
      await menu(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.getByRole('button', { name: 'Close navigation' }).click();
      await expect(dialog(page)).toBeHidden();
      await menu(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.mouse.click(360, 400);
      await expect(dialog(page)).toBeHidden();
    }
    await expect(page).toHaveURL(/\/all$/);
    await expect(menu(page)).toBeEnabled();
  });

  // DEF-005: closing is navigate(-1) with no re-entry guard, so repeated inputs pop extra history entries.
  test('AC4: a double tap on the scrim closes the drawer once and stays on the screen (DEF-005)', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.mouse.dblclick(360, 400);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/all$/);
  });

  test('AC4: double-clicking Menu leaves exactly one history entry to unwind (DEF-005)', async ({
    page,
  }) => {
    await page.goto('/settings'); // a previous entry exists to be lost by an extra back()
    await page.goto('/all');
    await menu(page).dblclick();
    await expect(dialog(page)).toHaveCount(1);
    // The Escape listener attaches with the focus move (one flaky run pressed it a beat early).
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
  });

  test('AC4: two Escape events in the same task do not navigate away from the screen (DEF-005)', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => {
      for (let i = 0; i < 2; i++)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(400);
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
  });

  // DEF-005 verification: the new ref guards must not stay set after a close or open that did not go
  // through the guarded path (browser Back, a stale drawer entry after reload).
  test('AC4: after browser Back closes the drawer, Menu opens it again and one Escape closes it (guards reset)', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.goBack();
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
    await page.keyboard.press('Escape'); // nothing open: must not navigate
    await page.waitForTimeout(200);
    await expect(page).toHaveURL(/\/all$/);
  });

  test('AC4: after a reload onto a stale drawer entry, a double-click on Menu and one Escape stay on the screen', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.reload();
    await expect(dialog(page)).toHaveCount(0);
    await menu(page).dblclick();
    await expect(dialog(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
  });

  test('AC4: a tap (touch) on the scrim closes the drawer and does not activate what is behind it', async ({
    page,
  }) => {
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.touchscreen.tap(360, 40); // header area of the dimmed page, right of the drawer
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/all$/);
  });

  test('AC4: Tab never reaches the page behind the drawer, including the skip link', async ({
    page,
  }) => {
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    const outside: string[] = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return a?.closest('[role=dialog]')
          ? 'in'
          : `${a?.tagName} ${a?.getAttribute('aria-label') ?? a?.textContent?.trim().slice(0, 30)}`;
      });
      if (where !== 'in') outside.push(where);
    }
    expect(outside).toEqual([]);
  });

  test('AC4: reloading with the drawer open shows a closed drawer and Back leaves the screen cleanly', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.className)).not.toContain(
      'scroll-locked',
    );
    // The stale entry must not trap the user: Menu still works.
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });

  test('AC4: growing the viewport to 1024px closes the drawer, shows the sidebar and leaves no history residue', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto('/all');
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Feeds and folders' })).toBeVisible();
    await expect(page).toHaveURL(/\/all$/);
    expect(await page.evaluate(() => document.documentElement.className)).not.toContain(
      'scroll-locked',
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(menu(page)).toBeVisible();
    await menu(page).click();
    await expect(dialog(page)).toBeVisible();
  });

  test('AC4: opening the drawer on every shell route works and leaves axe clean', async ({
    page,
  }) => {
    for (const route of ['/all', '/manage', '/settings', '/folders/f1']) {
      await page.goto(route);
      await menu(page).click();
      await expect(dialog(page)).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    }
  });

  test('AC4: the drawer fits the 375px viewport and respects 86vw, with no horizontal scroll', async ({
    page,
  }) => {
    await page.goto('/all');
    await menu(page).click();
    await expect.poll(async () => (await dialog(page).boundingBox())?.x).toBe(0); // slide-in is 200ms
    const box = await dialog(page).boundingBox();
    expect(box?.width).toBeLessThanOrEqual(320.5);
    expect(box?.width).toBeGreaterThanOrEqual(300);
    expect(box?.height).toBeGreaterThanOrEqual(812);
  });
});

// ---------------------------------------------------------------------------------------------
// AC4 tap targets for the whole shell, reflow, and AC5 extras.
// ---------------------------------------------------------------------------------------------

test.describe('TID-006 tap targets and reflow (mobile)', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), 'mobile-first checks at 375px');
  });

  for (const route of ALL_ROUTES) {
    test(`AC4: every link and button on ${route} is at least 44 x 44 px, with no horizontal scroll`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('a[href], button, [role=button]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          // Not a tap target: hidden from assistive tech and out of the tab order (e.g. AddFeed's
          // sr-only submit button that keeps Enter working).
          if (el.getAttribute('aria-hidden') === 'true' && el.tabIndex === -1) continue;
          if (r.width < 43.5 || r.height < 43.5) {
            out.push(
              `${el.tagName} "${el.getAttribute('aria-label') ?? el.textContent?.trim()}" ${r.width}x${r.height}`,
            );
          }
        }
        return out;
      });
      expect(small).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('TID-006 routes and axe extras', () => {
  test('AC5: every route is served as a 200 SPA document with a title', async ({ page }) => {
    for (const route of [...ALL_ROUTES, '/feeds/a.b', '/all/', '/folders/x-1_y/a/e-2']) {
      const res = await page.goto(route);
      expect(res?.status(), route).toBe(200);
      expect(res?.headers()['content-type'], route).toContain('text/html');
      await expect(page).toHaveTitle(/Tidings/);
    }
  });

  test('AC5: axe stays clean on the offline banner', async ({ page, context }) => {
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await context.setOffline(false);
  });

  test('AC5: axe stays clean when forced to 200% text zoom via a 320px viewport (reflow)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/all');
    await expectNoSeriousA11yViolations(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('AC5: focus moves to the new h1 on in-app navigation and Back restores the list', async ({
    page,
  }, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), 'uses the drawer');
    await page.goto('/all');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Manage' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Manage feeds' })).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('heading', { level: 1, name: 'All articles' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('AC5: Back on a sub-page returns to Manage, and the page title tracks the route', async ({
    page,
  }) => {
    await page.goto('/manage/add');
    await expect(page).toHaveTitle('Add a feed - Tidings');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/manage$/);
    await expect(page).toHaveTitle('Manage feeds - Tidings');
  });

  test('AC5: a keyboard user can Tab through the desktop sidebar and header to main', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'desktop sidebar');
    await page.goto('/all');
    const nav = page.getByRole('navigation', { name: 'Feeds and folders' });
    await expect(nav).toBeVisible();
    const box = await nav.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(280);
    // Focus indicator is visible on the first link (outline from the token focus colour).
    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // first sidebar control
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? getComputedStyle(el).outlineStyle : 'none';
    });
    expect(outline).toBe('solid');
  });
});

// ---------------------------------------------------------------------------------------------
// AC6: headers on every kind of response, and CSP violations during interaction.
// ---------------------------------------------------------------------------------------------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

test.describe('TID-006 AC6 headers and CSP', () => {
  test('AC6: the spec headers (including HSTS) are on the SPA shell, static files and the index', async ({
    request,
    page,
  }) => {
    await page.goto('/all');
    const assets = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => new URL(e.name).pathname)
        .filter((p) => /^\/assets\/.+\.(js|css)$/.test(p)),
    );
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const path of ['/', '/all', '/index.html', '/theme-init.js', ...assets]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const h = res.headers();
      expect(h['content-security-policy'], `${path} CSP`).toBe(CSP);
      expect(h['referrer-policy'], `${path} referrer`).toBe('no-referrer');
      expect(h['x-content-type-options'], `${path} nosniff`).toBe('nosniff');
      expect(h['permissions-policy'], `${path} permissions`).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
      expect(h['cross-origin-opener-policy'], `${path} coop`).toBe('same-origin');
      expect(h['strict-transport-security'], `${path} hsts`).toBe('max-age=31536000');
    }
  });

  test('AC6: a CSP violation listener works (control: inline script and inline style are blocked)', async ({
    page,
  }) => {
    await page.goto('/all');
    const blocked = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const got: string[] = [];
          document.addEventListener('securitypolicyviolation', (e) =>
            got.push(e.violatedDirective),
          );
          const s = document.createElement('script');
          s.textContent = 'window.__ran = 1';
          document.head.append(s);
          const st = document.createElement('style');
          st.textContent = 'body{color:red}';
          document.head.append(st);
          const d = document.createElement('div');
          d.setAttribute('style', 'color:red');
          document.body.append(d);
          setTimeout(() => resolve(got), 300);
        }),
    );
    expect(blocked.some((d) => d.startsWith('script-src'))).toBe(true);
    expect(blocked.some((d) => d.startsWith('style-src'))).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { __ran?: number }).__ran),
    ).toBeUndefined();
  });

  test('AC6: no CSP violations or console problems while loading, opening the drawer, going offline, resizing and switching theme', async ({
    page,
    context,
  }, testInfo) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      // Requests made while the test has the browser offline are expected to fail.
      if (m.text().includes('net::ERR_INTERNET_DISCONNECTED')) return;
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`,
        ),
      );
    });
    // TID-018: a list route for a folder or subscription that doesn't exist is a 404 from the API
    // (AC8), which the browser logs as a console error. Seed the two IDs ALL_ROUTES uses.
    seedListData({
      folders: [{ id: 'f1', name: 'Folder one' }],
      subs: [{ id: 's1', feedId: 9101, folderId: 'f1', title: 'Feed one' }],
      entries: [{ id: 9101001, feedId: 9101, title: 'Article one', publishedAt: 1_700_000_000 }],
    });
    try {
      for (const route of ALL_ROUTES) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      }
    } finally {
      clearListData();
    }
    await page.goto('/all');
    if (isMobile(testInfo.project.name)) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await context.setOffline(true);
    await expect(page.getByText("You're offline. Showing saved articles.")).toBeVisible();
    await context.setOffline(false);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(csp).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('AC6: the production bundle has no inline style, script or handler and no external origins', async ({
    request,
  }) => {
    const html = await (await request.get('/all')).text();
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/i);
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    expect(css).toBeTruthy();
    const body = await (await request.get(css ?? '')).text();
    expect(body).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(body).not.toMatch(/@import\s+url\(\s*['"]?https?:/i);
  });

  test('AC6: API responses are not cached as SPA documents and unknown API paths stay JSON', async ({
    request,
  }) => {
    const res = await request.get('/api/health');
    expect(res.headers()['content-type']).toContain('application/json');
    // Signed out, every /api path needs a session (TID-008), so an unknown one is a JSON 401.
    const nope = await request.get('/api/does/not/exist');
    expect(nope.status()).toBe(401);
    expect(nope.headers()['content-type']).toContain('application/json');
  });
});
