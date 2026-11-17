import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import type { Page } from '@playwright/test';
import { expect, mockSignedInSession, signedInTest as test } from '../support/test.ts';

// TID-006 UX review findings M1-M3: shell layout at 200% text, 375x812, light and dark.
// 200% text is emulated as the UX review did: html { font-size: 200% }.
// The toast store has no UI trigger yet and is not exposed by the production bundle, so the toast test
// runs against a throwaway Vite dev server (same toast module the app uses). Nothing is added to prod.

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

const zoom200 = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });

test.describe('TID-006 large text (M1-M3) and toast offset (m2)', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name.startsWith('desktop'), 'phone width only');
  });

  test('M1: header title wraps to two lines instead of truncating to one', async ({ page }) => {
    await page.goto('/manage/import');
    const title = page.getByRole('heading', { level: 1 });
    await expect(title).toBeVisible();
    await zoom200(page);
    const m = await title.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        h: el.getBoundingClientRect().height,
        lineH: parseFloat(cs.lineHeight),
        text: el.textContent ?? '',
        clippedX: el.scrollWidth > el.clientWidth,
        lineClamp: cs.getPropertyValue('-webkit-line-clamp'),
        header: document.querySelector('header')!.getBoundingClientRect().height,
      };
    });
    expect(m.text).toBe('Import from OPML');
    // Two lines are allowed: taller than one line, and no more than two.
    expect(m.h).toBeGreaterThan(m.lineH * 1.5);
    expect(m.h).toBeLessThanOrEqual(m.lineH * 2 + 1);
    // Nothing is cut sideways, and the title is clamped at two lines (design: wrap to 2, then ellipsis).
    // Whether a third line is needed depends on the platform's system font (Linux CI fonts are wider
    // than macOS/iOS), so assert the clamp itself rather than "no vertical overflow".
    expect(m.clippedX).toBe(false);
    expect(m.lineClamp).toBe('2');
    expect(m.header).toBeGreaterThan(56);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const back = await page.getByRole('button', { name: 'Back' }).boundingBox();
    expect(back!.width).toBeGreaterThanOrEqual(43.5);
    expect(back!.height).toBeGreaterThanOrEqual(43.5);
  });

  test('M2: drawer footer buttons stay inside the viewport', async ({ page }) => {
    await page.goto('/all');
    await zoom200(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.locator('#nav-drawer');
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(400); // slide-in animation
    for (const name of ['Add feed', 'Manage', 'Settings']) {
      const box = await drawer.getByRole('link', { name }).last().boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.x, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${name} right`).toBeLessThanOrEqual(375);
      expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(812);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
    }
    const panel = await drawer.boundingBox();
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(375);
    expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test.describe('toast', () => {
    let vite: ViteDevServer;
    let devUrl: string;
    test.beforeAll(async () => {
      vite = await createServer({
        root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
        server: { port: 0, host: '127.0.0.1' },
        logLevel: 'silent',
      });
      await vite.listen();
      devUrl = vite.resolvedUrls!.local[0]!.replace(/\/$/, '');
    });
    test.afterAll(async () => {
      await vite?.close();
    });

    test('M3: undo toast message is not clipped at 200% text', async ({ page }) => {
      // The throwaway Vite server has no Worker behind it, so the session check is answered here.
      await mockSignedInSession(page);
      await page.goto(`${devUrl}/all`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await zoom200(page);
      await page.evaluate(async () => {
        const url = '/src/lib/toast.ts'; // served by Vite; not resolvable by tsc
        const { toastStore } = await import(/* @vite-ignore */ url);
        toastStore.show('undo', 'Marked 14 as read', {
          action: { label: 'Undo', run() {} },
          duration: null,
        });
      });
      const card = page.locator('.toast-item');
      await expect(card).toBeVisible();
      const m = await card.evaluate((el) => {
        const p = el.querySelector('p')!;
        const btn = el.querySelector('button')!;
        const cs = getComputedStyle(p);
        const r = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(p);
        const rows = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
        return {
          text: p.textContent,
          clippedY: p.scrollHeight > p.clientHeight + 1,
          clippedX: p.scrollWidth > p.clientWidth,
          pH: p.getBoundingClientRect().height,
          lineH: parseFloat(cs.lineHeight),
          // The clamped element has no padding for a third line's descenders to leak through.
          padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
          rows: rows.size,
          cardL: r.left,
          cardR: r.right,
          cardB: r.bottom,
          btn: btn.getBoundingClientRect().toJSON() as DOMRect,
        };
      });
      expect(m.text).toBe('Marked 14 as read');
      expect(m.clippedY).toBe(false);
      expect(m.clippedX).toBe(false);
      expect(m.pH).toBeLessThanOrEqual(m.lineH * 2 + 1);
      expect(m.padY).toBe(0);
      expect(m.rows).toBeLessThanOrEqual(2);
      expect(m.cardL).toBeGreaterThanOrEqual(0);
      expect(m.cardR).toBeLessThanOrEqual(375);
      expect(m.cardB).toBeLessThanOrEqual(812);
      expect(m.btn.width).toBeGreaterThanOrEqual(43.5);
      expect(m.btn.height).toBeGreaterThanOrEqual(43.5);
      expect(m.btn.right).toBeLessThanOrEqual(m.cardR + 0.5);
    });

    test('m2: toast sits exactly 12px above a bottom bar taller than the minimum', async ({
      page,
    }) => {
      await mockSignedInSession(page);
      await page.goto(`${devUrl}/all`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const harness = `/@fs${fileURLToPath(new URL('../support/bottom-bar-harness.ts', import.meta.url))}`;
      const mount = (h: number) =>
        page.evaluate(
          async ([url, height]) => {
            const m = await import(/* @vite-ignore */ url as string);
            m.mountBar(height);
          },
          [harness, h] as const,
        );
      await mount(96);
      await page.evaluate(async () => {
        const url = '/src/lib/toast.ts'; // served by Vite; not resolvable by tsc
        const { toastStore } = await import(/* @vite-ignore */ url);
        toastStore.show('info', 'Saved', { duration: null });
      });
      await expect(page.locator('.toast-item')).toBeVisible();
      const measure = () =>
        page.evaluate(() => {
          const t = document.querySelector('.toast-item')!.getBoundingClientRect();
          const b = document.getElementById('bottom-bar')!.getBoundingClientRect();
          return { gap: b.top - t.bottom, barH: b.height };
        });
      await expect.poll(async () => (await measure()).barH).toBeGreaterThan(96);
      await expect.poll(async () => (await measure()).gap).toBeCloseTo(12, 1);
      // The bar grows later (for example the text size changes): the offset follows.
      await mount(160);
      await expect.poll(async () => (await measure()).barH).toBeGreaterThan(160);
      await expect.poll(async () => (await measure()).gap).toBeCloseTo(12, 1);
      // Unmounting the bar removes the offset.
      await page.evaluate(async (url) => {
        const m = await import(/* @vite-ignore */ url);
        m.unmountBar();
      }, harness);
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--bottom-offset')),
        )
        .toBe('');
    });
  });
});

test.describe('TID-006 desktop header alignment (m1)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name.startsWith('mobile'), 'desktop width only');
  });

  test('m1: header title left edge equals the content column left edge', async ({ page }) => {
    await page.goto('/all');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const e = await page.evaluate(() => {
      const h1 = document.querySelector('h1')!;
      const range = document.createRange();
      range.selectNodeContents(h1);
      const column = document.querySelector('#main > div')!.getBoundingClientRect();
      return {
        title: h1.getBoundingClientRect().left,
        text: range.getBoundingClientRect().left,
        column: column.left,
        columnW: column.width,
        headerW: document.querySelector('header')!.getBoundingClientRect().width,
        mainW: document.querySelector('main')!.getBoundingClientRect().width,
      };
    });
    expect(e.columnW).toBe(672); // 42rem
    expect(Math.abs(e.title - e.column)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.text - e.column)).toBeLessThanOrEqual(1);
    // The header background still spans the whole main area.
    expect(e.headerW).toBe(e.mainW);
  });
});
