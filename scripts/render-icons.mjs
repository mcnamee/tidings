// Regenerates the PNG app icons from apps/web/public/logo.svg (docs/ux/brand.md section 5).
//   CHROME_PATH=/usr/bin/google-chrome node scripts/render-icons.mjs [--preview]
// --preview also writes docs/ux/brand-preview.png (mark and wordmark in both themes, plus the home-screen icon).
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'apps/web/public');
const logo = readFileSync(resolve(pub, 'logo.svg'), 'utf8');
const markInner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

// Brand colours are the light accent tokens (DESIGN_SYSTEM.md 2.2): --c-accent and --c-accent-fg.
const BG = '#2750c4';
const FG = '#ffffff';

/** An icon SVG. `scale` is the mark's box as a share of the canvas; `radius` is the corner share. */
function iconSvg(size, { scale, radius }) {
  const k = (size * scale) / 56; // the mark's own viewBox is 56 units
  const s = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${size * radius}" fill="${BG}"/>
<g fill="${FG}" transform="translate(${s} ${s}) scale(${k}) translate(-32 -32)">${markInner}</g></svg>`;
}

export const ICONS = [
  { file: 'icons/icon-192.png', size: 192, scale: 0.74, radius: 0.22 },
  { file: 'icons/icon-512.png', size: 512, scale: 0.74, radius: 0.22 },
  // Maskable: full bleed, the mark's box is 64% of the canvas, inside the 80% safe zone.
  { file: 'icons/icon-maskable-512.png', size: 512, scale: 0.64, radius: 0 },
  // iOS rounds the corners itself, so this one is full bleed too.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.7, radius: 0 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(
      `<body style="margin:0;background:transparent">${iconSvg(icon.size, icon)}</body>`,
    );
    const out = resolve(pub, icon.file);
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out, omitBackground: true });
    await page.close();
    console.log('wrote', icon.file);
  }

  if (process.argv.includes('--preview')) {
    const mark = logo.replace('<svg ', '<svg width="100%" height="100%" ');
    const cell = (bg, fg, accent) => `
      <div style="background:${bg};color:${fg};padding:32px;display:flex;flex-direction:column;gap:24px;align-items:flex-start">
        <div style="display:flex;align-items:center;gap:14px;font:600 44px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:-0.02em">
          <span style="width:52px;height:52px;color:${accent}">${mark}</span>Tidings</div>
        <div style="display:flex;align-items:center;gap:10px;font:600 20px/1 ui-sans-serif,system-ui,sans-serif">
          <span style="width:26px;height:26px;color:${accent}">${mark}</span>Tidings
          <span style="width:16px;height:16px;margin-left:16px;color:${accent}">${mark}</span></div>
      </div>`;
    const html = `<body style="margin:0;display:flex;flex-wrap:wrap;width:960px;font-family:ui-sans-serif,system-ui,sans-serif">
      <div style="width:480px">${cell('#ffffff', '#1d1c1a', '#2750c4')}</div>
      <div style="width:480px">${cell('#1b1c20', '#dddcd7', '#8eaeff')}</div>
      <div style="width:960px;background:#f6f5f1;padding:24px 32px;display:flex;gap:24px;align-items:center;color:#5b574f;font-size:16px">
        <span style="width:120px;height:120px;border-radius:27px;overflow:hidden;display:block">${iconSvg(120, { scale: 0.7, radius: 0 })}</span>
        Home-screen icon: accent background, white mark.</div></body>`;
    const page = await browser.newPage({ viewport: { width: 960, height: 400 } });
    await page.setContent(html);
    await page.screenshot({ path: resolve(root, 'docs/ux/brand-preview.png'), fullPage: true });
    console.log('wrote docs/ux/brand-preview.png');
  }
} finally {
  await browser.close();
}
