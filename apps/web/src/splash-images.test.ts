import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs shared with the render script
import { DEVICES, THEMES, fileFor, mediaFor } from '../../../scripts/splash-config.mjs';

// TID-065: iOS launch images exist at the pixel size each media query asks for.
const web = resolve(__dirname, '..');
const html = readFileSync(resolve(web, 'index.html'), 'utf8');
const css = readFileSync(resolve(web, 'src/index.css'), 'utf8');

const links = [
  ...html.matchAll(
    /<link\s+rel="apple-touch-startup-image"\s+media="([^"]+)"\s+href="([^"]+)"\s*\/>/g,
  ),
].map((m) => ({ media: m[1]!, href: m[2]! }));

describe('iOS launch images', () => {
  it('has a light and a dark link for every device', () => {
    expect(links).toHaveLength(DEVICES.length * 2);
    for (const d of DEVICES)
      for (const s of ['light', 'dark'])
        expect(links).toContainEqual({ media: mediaFor(d, s), href: `/${fileFor(d, s)}` });
  });

  it.each(links.map((l) => [l.href, l] as const))('%s is the stated pixel size', (_h, l) => {
    const num = (re: RegExp) => Number(re.exec(l.media)![1]);
    const w = num(/device-width: (\d+)px/);
    const h = num(/device-height: (\d+)px/);
    const r = num(/pixel-ratio: (\d+)/);
    expect(l.media).toContain('orientation: portrait');
    expect(l.media).toMatch(/prefers-color-scheme: (light|dark)/);
    const b = readFileSync(resolve(web, `public${l.href}`));
    expect(b.subarray(1, 4).toString()).toBe('PNG');
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([w * r, h * r]);
    const scheme = /prefers-color-scheme: (\w+)/.exec(l.media)![1] as 'light' | 'dark';
    expect(l.href).toContain(scheme);
  });

  it('uses the same colours as the CSS tokens in both themes', () => {
    const block = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      return css.slice(at, css.indexOf('}', at));
    };
    const light = block("[data-theme='light']");
    const dark = block("[data-theme='dark']");
    for (const [name, v, scope] of [
      ['light', THEMES.light, light],
      ['dark', THEMES.dark, dark],
    ] as const) {
      expect(scope, name).toContain(`--c-surface: ${v.surface}`);
      expect(scope, name).toContain(`--c-text: ${v.text}`);
      expect(scope, name).toContain(`--c-accent: ${v.accent}`);
    }
  });
});
