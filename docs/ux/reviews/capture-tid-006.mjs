// UX review capture for TID-006. Usage: node docs/ux/reviews/capture-tid-006.mjs
// BASE: built app via `wrangler dev` (default 8798). DEV: Vite dev server, used only to reach the
// toast store module (the same module instance the app uses) because the bundle does not expose it.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:8798';
const DEV = process.env.DEV ?? 'http://localhost:5199';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'tid-006');
mkdirSync(OUT, { recursive: true });

const sizes = {
  m: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  d: { viewport: { width: 1280, height: 800 } },
};
const report = {};
const browser = await chromium.launch();

async function ctx(size, scheme, extra = {}) {
  return browser.newContext({ ...sizes[size], colorScheme: scheme, deviceScaleFactor: 1, ...extra });
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

async function audit(page) {
  return page.evaluate(() => {
    const small = [];
    document.querySelectorAll('a[href], button, [role=button]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.width < 43.5 || r.height < 43.5)
        small.push(
          `${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    });
    const h = document.querySelector('header');
    const hr = h?.getBoundingClientRect();
    const title = document.querySelector('h1');
    return {
      h1: document.querySelectorAll('h1').length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      small,
      headerH: hr ? Math.round(hr.height) : null,
      titleTruncated: title ? title.scrollWidth > title.clientWidth : null,
      titleH: title ? Math.round(title.getBoundingClientRect().height) : null,
      docTitle: document.title,
    };
  });
}

const active = (page) =>
  page.evaluate(() =>
    (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || document.activeElement.tagName).trim(),
  );

for (const size of ['m', 'd']) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const c = await ctx(size, scheme);
    const page = await c.newPage();
    const R = (report[tag] = {});

    for (const [name, path] of [
      ['all', '/all'],
      ['settings', '/settings'],
      ['manage', '/manage'],
      ['manage-add', '/manage/add'],
      ['article', '/all/a/e1'],
      ['feed', '/feeds/s1'],
      ['404', '/no/such/page'],
      ['login', '/login'],
    ]) {
      await page.goto(BASE + path);
      await page.waitForSelector('h1');
      await shot(page, `${name}-${tag}`);
      R[name] = await audit(page);
    }

    if (size === 'm') {
      await page.goto(BASE + '/all');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.waitForSelector('[role=dialog]');
      await page.waitForTimeout(400);
      await shot(page, `drawer-${tag}`);
      R.drawer = await page.evaluate(() => {
        const d = document.querySelector('#nav-drawer').getBoundingClientRect();
        const items = [];
        document.querySelectorAll('#nav-drawer a, #nav-drawer button').forEach((el) => {
          const r = el.getBoundingClientRect();
          items.push(`${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
        return { width: Math.round(d.width), focus: document.activeElement.getAttribute('aria-label'), items };
      });
      const order = [];
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        order.push(await active(page));
      }
      R.drawer.tab = order;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      R.drawer.focusAfterEscape = await active(page);
      R.drawer.urlAfterEscape = page.url();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('link', { name: 'Settings' }).click();
      await page.waitForTimeout(300);
      R.drawer.focusAfterNav = await active(page);
      await page.goBack();
      R.drawer.afterBackFromSettings = page.url();
    } else {
      await page.goto(BASE + '/all');
      R.sidebar = await page.evaluate(() => {
        const a = document.querySelector('aside')?.getBoundingClientRect();
        return { width: a && Math.round(a.width), menu: !!document.querySelector('[aria-label="Open navigation"]') };
      });
      await page.keyboard.press('Tab');
      R.sidebar.firstTab = await active(page);
      await shot(page, `skiplink-focus-${tag}`);
      await page.keyboard.press('Enter');
      R.sidebar.afterSkip = await page.evaluate(() => document.activeElement.id);
    }

    await page.goto(BASE + '/all');
    await page.waitForSelector('h1');
    await c.setOffline(true);
    await page.waitForTimeout(500);
    R.offline = await page.evaluate(() => {
      const s = [...document.querySelectorAll('[role=status]')].find((e) => !e.closest('#toasts'));
      return { text: s?.textContent?.trim(), h: s && Math.round(s.getBoundingClientRect().height) };
    });
    await shot(page, `offline-${tag}`);
    await c.setOffline(false);
    await c.close();
  }
}

// Large text (200%) on the phone
for (const scheme of ['light', 'dark']) {
  const c = await ctx('m', scheme);
  const page = await c.newPage();
  const R = (report[`large-${scheme}`] = {});
  await page.goto(BASE + '/manage/import');
  await page.waitForSelector('h1');
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await page.waitForTimeout(200);
  await shot(page, `zoom200-subpage-${scheme}`);
  R.subpage = await audit(page);
  await page.goto(BASE + '/all');
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForTimeout(400);
  await shot(page, `zoom200-drawer-${scheme}`);
  R.drawer = await page.evaluate(() => {
    const p = document.querySelector('#nav-drawer');
    const s = [...p.querySelectorAll('a')].find((a) => a.textContent.includes('Settings')).getBoundingClientRect();
    return { settingsBottom: Math.round(s.bottom), vh: innerHeight, panelOverflow: p.scrollHeight > p.clientHeight };
  });
  await page.keyboard.press('Escape');
  await c.setOffline(true);
  await page.waitForTimeout(400);
  await shot(page, `zoom200-offline-${scheme}`);
  await c.setOffline(false);
  await c.close();
}

// Reduced motion
{
  const c = await ctx('m', 'light', { reducedMotion: 'reduce' });
  const page = await c.newPage();
  await page.goto(BASE + '/all');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForSelector('.drawer-panel');
  report.reduced = await page.evaluate(() => {
    const g = (s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return `${cs.animationName} ${cs.animationDuration}`;
    };
    return { panel: g('.drawer-panel'), scrim: g('.drawer-scrim') };
  });
  await c.close();
}

// Toasts and bottom bar via the Vite dev server (shares the app's toast store module)
for (const scheme of ['light', 'dark']) {
  const c = await ctx('m', scheme);
  const page = await c.newPage();
  const R = (report[`toast-${scheme}`] = {});
  await page.goto(DEV + '/all');
  await page.waitForSelector('h1');
  await page.evaluate(() => {
    const bar = document.querySelector('#bottom-bar');
    bar.innerHTML =
      '<div class="mx-auto flex min-h-14 max-w-2xl items-center gap-2"><button class="min-h-11 rounded-md border border-line-strong px-4 text-fg">Mark all read</button></div>';
    document.documentElement.style.setProperty('--bottom-offset', '3.5rem');
  });
  const show = (kind, msg, withAction) =>
    page.evaluate(
      async ([k, m, a]) => {
        const { toastStore } = await import('/src/lib/toast.ts');
        toastStore.dismiss();
        toastStore.show(k, m, a ? { action: { label: 'Undo', run() {} } } : undefined);
      },
      [kind, msg, withAction],
    );
  await show('undo', 'Marked 14 as read', true);
  await page.waitForTimeout(400);
  await shot(page, `toast-undo-bar-${scheme}`);
  R.undo = await page.evaluate(() => {
    const t = document.querySelector('.toast-item').getBoundingClientRect();
    const b = document.querySelector('#bottom-bar').getBoundingClientRect();
    return { gap: Math.round(b.top - t.bottom), toastH: Math.round(t.height) };
  });
  await show('error', "You're offline. That change wasn't saved.", false);
  await page.waitForTimeout(400);
  await shot(page, `toast-error-bar-${scheme}`);
  R.errorInAlert = await page.evaluate(() => document.querySelector('[role=alert]').textContent);
  await show('undo', 'Marked 14 as read', true);
  await page.waitForTimeout(4500);
  R.undoAt4_5s = await page.evaluate(() => !!document.querySelector('.toast-item'));
  await page.waitForTimeout(1000);
  R.undoAt5_5s = await page.evaluate(() => !!document.querySelector('.toast-item'));
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await show('undo', 'Marked 14 as read', true);
  await page.waitForTimeout(400);
  await shot(page, `toast-undo-bar-zoom200-${scheme}`);
  R.zoom = await page.evaluate(() => {
    const t = document.querySelector('.toast-item').getBoundingClientRect();
    const b = document.querySelector('#bottom-bar').getBoundingClientRect();
    return { gap: Math.round(b.top - t.bottom), barH: Math.round(b.height) };
  });
  await c.close();
}

// Back behaviour
{
  const c = await ctx('m', 'light');
  const page = await c.newPage();
  const R = (report.back = {});
  await page.goto(BASE + '/feeds/s1/a/e1');
  await page.getByRole('button', { name: 'Back' }).click();
  R.directArticle = new URL(page.url()).pathname;
  await page.goto(BASE + '/manage/add');
  await page.getByRole('button', { name: 'Back' }).click();
  R.addBack = new URL(page.url()).pathname;
  await c.close();
}

writeFileSync(join(OUT, '..', 'tid-006-measurements.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log('done');
