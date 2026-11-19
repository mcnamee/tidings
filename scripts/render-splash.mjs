/* global document */
// Renders the iOS launch images (TID-065) that match the in-page splash (.splash in src/index.css).
//   CHROME_PATH=/usr/bin/google-chrome node scripts/render-splash.mjs [--links]
// --links prints the <link rel="apple-touch-startup-image"> tags for index.html.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DEVICES, THEMES, fileFor, mediaFor } from './splash-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'apps/web/public');
const logo = readFileSync(resolve(pub, 'logo.svg'), 'utf8');
const markInner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

if (process.argv.includes('--links')) {
  for (const d of DEVICES)
    for (const s of ['light', 'dark'])
      console.log(
        `    <link rel="apple-touch-startup-image" media="${mediaFor(d, s)}" href="/${fileFor(d, s)}" />`,
      );
  process.exit(0);
}

// Same box model as .splash: column, centred, 72px mark, 1rem gap, 1.5rem semibold word (line-height 1.5).
const html = (d, t) => `<!doctype html><body style="margin:0;background:${t.surface}">
<div style="position:absolute;left:0;right:0;top:${d.top}px;bottom:0;padding-bottom:${d.bottom}px;box-sizing:border-box;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:${t.text};
  font-family:Inter,system-ui,sans-serif;font-size:24px;font-weight:600;letter-spacing:-0.025em;line-height:1.5">
  <svg width="72" height="72" viewBox="4 4 56 56" fill="currentColor" stroke="currentColor" style="color:${t.accent}">${markInner}</svg>
  <span>Tidings</span></div></body>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  for (const d of DEVICES) {
    const ctx = await browser.newContext({
      viewport: { width: d.w, height: d.h },
      deviceScaleFactor: d.ratio,
    });
    const page = await ctx.newPage();
    for (const [scheme, theme] of Object.entries(THEMES)) {
      await page.setContent(html(d, theme));
      await page.evaluate(() => document.fonts.ready);
      const out = resolve(pub, fileFor(d, scheme));
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      console.log('wrote', fileFor(d, scheme));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
