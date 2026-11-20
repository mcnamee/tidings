// Draws the "all caught up" spot illustrations (TID-073, docs/ux/brand.md section 8).
//   CHROME_PATH=/usr/bin/google-chrome node scripts/render-caught-up.mjs [--only=cat,dog] [--raw]
// 1. apps/web/art/caught-up/drawings.mjs + lib.mjs -> <name>-light.svg and <name>-dark.svg (sources)
// 2. Chromium renders each SVG to a 480x480 transparent PNG in apps/web/public/caught-up/
// 3. sharp squeezes each PNG to a small palette PNG (skipped with --raw or if sharp is missing)
// 4. apps/web/art/caught-up/contact-sheet.png shows all of them on the app's two surfaces
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildSvg, PALETTES, SIZE } from '../apps/web/art/caught-up/lib.mjs';
import { DRAWINGS } from '../apps/web/art/caught-up/drawings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artDir = resolve(root, 'apps/web/art/caught-up');
const outDir = resolve(root, 'apps/web/public/caught-up');
mkdirSync(outDir, { recursive: true });

const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const raw = process.argv.includes('--raw');
const names = Object.keys(DRAWINGS).filter((n) => !only || only.includes(n));

let sharp = null;
if (!raw) {
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('sharp is not installed: PNGs are written unoptimised');
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
let total = 0;
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  for (const name of names) {
    for (const theme of ['light', 'dark']) {
      const svg = buildSvg(DRAWINGS[name], PALETTES[theme]);
      const svgPath = resolve(artDir, `${name}-${theme}.svg`);
      writeFileSync(svgPath, svg);
      await page.goto(pathToFileURL(svgPath).href);
      let png = await page.screenshot({ omitBackground: true, type: 'png' });
      if (sharp) {
        png = await sharp(png)
          .png({ palette: true, colours: 48, quality: 40, effort: 10, dither: 0.5 })
          .toBuffer();
      }
      const file = resolve(outDir, `${name}-${theme}.png`);
      writeFileSync(file, png);
      total += png.length;
      console.log(`${name}-${theme}.png ${(png.length / 1024).toFixed(1)} KB`);
    }
  }

  // Contact sheet of everything in the folder: light on #ffffff, dark on #1b1c20.
  const all = Object.keys(DRAWINGS);
  const cell = (theme, bg) =>
    `<section style="background:${bg}">${all
      .map((n) => `<img src="${pathToFileURL(resolve(outDir, `${n}-${theme}.png`)).href}" alt="">`)
      .join('')}</section>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1200px}section{display:grid;grid-template-columns:repeat(4,300px);}
img{width:300px;height:300px;display:block}</style>${cell('light', '#ffffff')}${cell('dark', '#1b1c20')}`;
  const sheetHtml = resolve(tmpdir(), 'caught-up-sheet.html');
  writeFileSync(sheetHtml, html);
  const sheetPage = await browser.newPage({ viewport: { width: 1200, height: 1800 } });
  await sheetPage.goto(pathToFileURL(sheetHtml).href);
  await sheetPage.waitForLoadState('load');
  await sheetPage.screenshot({
    path: resolve(artDir, 'contact-sheet.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}
console.log(`written ${names.length * 2} images, ${(total / 1024).toFixed(0)} KB this run`);
