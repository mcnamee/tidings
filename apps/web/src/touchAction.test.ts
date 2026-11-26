import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, 'index.css'), 'utf8');

// TID-078 fix: the topic chip row scrolled in fits and starts on iOS because `html.swipe-nav` set
// `touch-action: pan-y`. touch-action intersects down the tree and WebKit does not stop at a scroll
// container, so no sideways scroller below <html> could pan horizontally. jsdom does not apply index.css,
// so this reads the rules themselves: nothing at the root may drop `pan-x`, nothing may re-allow pinch zoom.

function rules(): Array<{ selector: string; touchAction: string }> {
  const out: Array<{ selector: string; touchAction: string }> = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const t = /(?:^|;|\s)touch-action:\s*([^;]+);/.exec(m[2] ?? '');
    if (t) out.push({ selector: (m[1] ?? '').trim(), touchAction: (t[1] ?? '').trim() });
  }
  return out;
}

describe('touch-action in index.css', () => {
  const root = rules().filter((r) => /^(html|body|#root)\b/.test(r.selector));

  it('has the root rules this test is about', () => {
    expect(root.map((r) => r.selector)).toEqual(expect.arrayContaining(['html', 'html.swipe-nav']));
  });

  it('never narrows a root element below pan-x pan-y, so sideways scrollers can pan (and pinch stays off)', () => {
    for (const r of root) {
      expect(r.touchAction.split(/\s+/).sort(), r.selector).toEqual(['pan-x', 'pan-y']);
    }
  });

  it('lets the chip row pan sideways and vertically', () => {
    const row = rules().find((r) => r.selector === '.scroll-row');
    expect(row?.touchAction.split(/\s+/).sort()).toEqual(['pan-x', 'pan-y']);
  });
});
