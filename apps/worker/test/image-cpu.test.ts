import { describe, expect, it } from 'vitest';
import { extractPreviewImage, MAX_PAGE_BYTES } from '../src/images/extract';

// TID-071 (ADR 0019, spec 9.7): the CPU of reading a page's preview image, measured in workerd.
// `performance.now()` around synchronous work is CPU time in the local runtime. The numbers are
// logged for the record and asserted only against the Free plan's 10 ms per invocation, with margin
// (a run decodes and scans up to 12 pages, so one page must stay far below 10 ms / 12).
const APP = 'https://tidings.mcn.am';
const PAGE = 'https://www.formula1.com/en/latest/article.test.1234';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const time = (fn: () => void, runs = 21) => {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return { median: median(t), max: Math.max(...t) };
};

/** A head the size and shape of a real news site's: many meta/link tags, inline JSON and CSS. */
function realisticPage(withOg: boolean, bytes: number): Uint8Array {
  const metas = Array.from(
    { length: 60 },
    (_, i) =>
      `<meta name="m${i}" content="${'value '.repeat(12)}">\n<link rel="preload" href="/static/a${i}.js" as="script">`,
  ).join('\n');
  const og = withOg
    ? '<meta property="og:image" content="https://cdn.example.com/a.jpg?w=1200&amp;h=630"><meta property="og:image:width" content="1200">'
    : '';
  const inline = `<script type="application/json">${JSON.stringify({ k: 'v'.repeat(4000) })}</script><style>${'.a{color:red}'.repeat(500)}</style>\n`;
  let head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article</title>${metas}`;
  while (head.length < bytes - 12000) head += inline;
  head += og + '</head><body>' + '<p>text</p>'.repeat(20_000);
  return new TextEncoder().encode(head).subarray(0, bytes);
}

describe('preview image CPU (TID-071)', () => {
  it('decodes and scans a full 128 KB page with no image well inside the budget (worst case)', () => {
    const bytes = realisticPage(false, MAX_PAGE_BYTES);
    expect(bytes.byteLength).toBe(MAX_PAGE_BYTES);
    const r = time(() => {
      const text = new TextDecoder('utf-8').decode(bytes);
      expect(extractPreviewImage(text, PAGE, APP)).toBeNull();
    });
    console.log(
      `image extraction, 128 KB page, no image: median ${r.median.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`,
    );
    expect(r.median).toBeLessThan(2);
    expect(r.max).toBeLessThan(50); // the median is the claim; a max is noisy when files run in parallel
  });

  it('finds the image late in a 128 KB head', () => {
    const bytes = realisticPage(true, MAX_PAGE_BYTES);
    const r = time(() => {
      const text = new TextDecoder('utf-8').decode(bytes);
      expect(extractPreviewImage(text, PAGE, APP)).toBe(
        'https://cdn.example.com/a.jpg?w=1200&h=630',
      );
    });
    console.log(
      `image extraction, 128 KB page, image at the end of head: median ${r.median.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`,
    );
    expect(r.median).toBeLessThan(2);
    expect(r.max).toBeLessThan(50); // the median is the claim; a max is noisy when files run in parallel
  });

  it('twelve pages in one run (the per-run cap) stay inside the 10 ms Free budget', () => {
    const bytes = realisticPage(true, MAX_PAGE_BYTES);
    const r = time(() => {
      for (let i = 0; i < 12; i++) {
        extractPreviewImage(new TextDecoder('utf-8').decode(bytes), PAGE, APP);
      }
    }, 11);
    console.log(
      `image extraction, 12 pages of 128 KB: median ${r.median.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`,
    );
    expect(r.median).toBeLessThan(10);
  });
});
