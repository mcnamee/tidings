import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// TID-057 / TID-023 AC4: the icon files exist at the sizes the manifest declares.
const pub = resolve(__dirname, '../public');
function pngSize(file: string): [number, number] {
  const b = readFileSync(resolve(pub, file));
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('app icons', () => {
  it.each([
    ['icons/icon-192.png', 192],
    ['icons/icon-512.png', 512],
    ['icons/icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ])('%s is %i px square', (file, size) => {
    expect(pngSize(file)).toEqual([size, size]);
  });

  it('every manifest icon points at a file that exists', () => {
    const m = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8')) as {
      icons: { src: string }[];
    };
    for (const i of m.icons) expect(() => readFileSync(resolve(pub, `.${i.src}`))).not.toThrow();
  });

  it('favicon.svg adapts to dark mode and logo.svg themes via currentColor', () => {
    expect(readFileSync(resolve(pub, 'favicon.svg'), 'utf8')).toContain(
      'prefers-color-scheme:dark',
    );
    expect(readFileSync(resolve(pub, 'logo.svg'), 'utf8')).toContain('fill="currentColor"');
  });

  it('Logo.tsx draws the same shapes as logo.svg', () => {
    const rects = (s: string) =>
      [...s.matchAll(/<rect [^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '));
    const svg = rects(readFileSync(resolve(pub, 'logo.svg'), 'utf8'));
    const tsx = rects(readFileSync(resolve(__dirname, 'shell/Logo.tsx'), 'utf8')).map((r) =>
      r.replace(/ \/>$/, '/>').replace(/"\/>$/, '"/>'),
    );
    const norm = (r: string) => r.replace(/\s*\/?>$/, '');
    expect(tsx.map(norm)).toEqual(svg.map(norm));
  });
});
