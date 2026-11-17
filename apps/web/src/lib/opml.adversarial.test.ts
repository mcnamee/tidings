import { describe, expect, it } from 'vitest';
import { OpmlError, chunkEntries, parseOpml } from './opml';

// TID-016 adversarial OPML (QA). The browser parses; nothing here may execute, fetch or hang.
// jsdom's DOMParser stands in for the browser's; Chrome's behaviour on the same inputs is checked
// by hand in the QA report (libxml2 limits entity expansion and nesting depth).

const wrap = (body: string, head = '') =>
  `<?xml version="1.0"?>${head}<opml version="2.0"><head><title>x</title></head><body>${body}</body></opml>`;
const feed = (url: string, attrs = '') => `<outline type="rss" text="t" xmlUrl="${url}" ${attrs}/>`;

describe('hostile structure', () => {
  it('does not resolve external entities (XXE): the entity text never reaches a title', () => {
    const doc = wrap(
      `<outline text="&xxe;" title="&xxe;"><outline type="rss" text="&xxe;" xmlUrl="https://a.example.com/f"/></outline>`,
      `<!DOCTYPE opml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`,
    );
    let out;
    try {
      out = parseOpml(doc);
    } catch (e) {
      expect(e).toBeInstanceOf(OpmlError); // refusing is fine
      return;
    }
    expect(JSON.stringify(out)).not.toMatch(/root:|\/bin\/|passwd/);
  });

  it('a billion-laughs document is refused or small, and returns quickly', () => {
    const lol = (n: number) => `&lol${n};`;
    const defs = ['<!ENTITY lol0 "lollollollollollollollollollol">']
      .concat(
        Array.from({ length: 9 }, (_, i) =>
          `<!ENTITY lol${i + 1} "${lol(i).repeat(10)}">`.replace(/&lol(\d+);/g, '&lol$1;'),
        ),
      )
      .join('');
    const doc = wrap(
      `<outline text="&lol9;"><outline type="rss" text="&lol9;" title="&lol9;" xmlUrl="https://a.example.com/f"/></outline>`,
      `<!DOCTYPE opml [${defs}]>`,
    );
    const t = Date.now();
    let out;
    try {
      out = parseOpml(doc);
    } catch (e) {
      expect(e).toBeInstanceOf(OpmlError);
    }
    expect(Date.now() - t).toBeLessThan(3000);
    for (const e of out?.entries ?? []) expect((e.title ?? '').length).toBeLessThanOrEqual(200);
    expect(out?.entries.every((e) => (e.folder ?? '').length <= 64)).toBe(true);
  });

  it('deeply nested outlines (3,000 levels) do not crash the page', () => {
    const n = 3000;
    const doc = wrap(
      '<outline text="F">'.repeat(n) + feed('https://deep.example.com/f') + '</outline>'.repeat(n),
    );
    let out;
    try {
      out = parseOpml(doc);
    } catch (e) {
      expect(e).toBeInstanceOf(OpmlError); // refusing is fine; a RangeError is not
      return;
    }
    expect(out.entries).toHaveLength(1);
  });

  it('a large file of 20,000 feeds parses and chunks into requests of at most 100', () => {
    const body = Array.from({ length: 20000 }, (_, i) => feed(`https://h${i}.example.com/f`)).join(
      '',
    );
    const out = parseOpml(wrap(body));
    expect(out.entries).toHaveLength(20000);
    for (const r of chunkEntries(out.entries))
      expect(
        r.feeds.length + r.folders.reduce((n, f) => n + f.feeds.length, 0),
      ).toBeLessThanOrEqual(100);
  });
});

describe('hostile values', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/xml;base64,AAAA',
    'file:///etc/passwd',
    'vbscript:x',
    'ftp://a.example.com/f',
    '//a.example.com/f',
    '  JaVaScRiPt:alert(1)',
  ])('reports %s as invalid', (u) => {
    const out = (() => {
      try {
        return parseOpml(wrap(feed(u) + feed('https://ok.example.com/f')));
      } catch (e) {
        return e;
      }
    })();
    expect(out).not.toBeInstanceOf(Error);
    const p = out as ReturnType<typeof parseOpml>;
    expect(p.invalid).toHaveLength(1);
    expect(p.entries.map((e) => e.xmlUrl)).toEqual(['https://ok.example.com/f']);
  });

  it('collapses one URL written several ways into one subscription', () => {
    const out = parseOpml(
      wrap(
        [
          'https://Example.COM/feed',
          'https://example.com:443/feed',
          'https://example.com/feed#frag',
          'HTTPS://EXAMPLE.com/feed',
        ]
          .map((u) => feed(u))
          .join(''),
      ),
    );
    expect(out.entries).toHaveLength(1);
  });

  it('keeps hostile titles as inert text, clipped to 200 characters', () => {
    const t = `<img src=x onerror=alert(1)>${'a'.repeat(1500)}`;
    const out = parseOpml(
      wrap(
        `<outline text="x" title="${t.replace(/</g, '&lt;')}" type="rss" xmlUrl="https://a.example.com/f"/>`,
      ),
    );
    expect(out.entries[0]?.title?.length).toBeLessThanOrEqual(200);
  });

  it('DEF-060: a folder name of only zero-width characters is treated as no folder', () => {
    const zw = '\u200B\u200C\u200D\u2060\uFEFF';
    const out = parseOpml(
      wrap(`<outline text="${zw}">${feed('https://a.example.com/f')}</outline>`),
    );
    expect(out.folderCount).toBe(0); // DEF-060
  });

  it('DEF-060: a feed title of only zero-width characters falls back to the feed title (no invisible name)', () => {
    const zw = '\u200B\u200C\u200D';
    const out = parseOpml(
      wrap(`<outline type="rss" text="${zw}" title="${zw}" xmlUrl="https://a.example.com/f"/>`),
    );
    expect(out.entries[0]?.title ?? '').not.toMatch(
      new RegExp('^[\\u200B-\\u200D\\u2060\\uFEFF]+$'),
    );
  });

  it('DEF-061: clipping a folder name never cuts a surrogate pair in half', () => {
    const name = 'a'.repeat(63) + '\u{1F600}';
    const out = parseOpml(
      wrap(`<outline text="${name}">${feed('https://a.example.com/f')}</outline>`),
    );
    const f = out.entries[0]?.folder ?? '';
    expect(f).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('odd encodings', () => {
  it('handles a UTF-8 BOM and a UTF-16 declaration on a string without throwing a non-OpmlError', () => {
    for (const doc of [
      '﻿' + wrap(feed('https://a.example.com/f')),
      wrap(feed('https://a.example.com/f')).replace(
        '<?xml version="1.0"?>',
        '<?xml version="1.0" encoding="UTF-16"?>',
      ),
      wrap(feed('https://a.example.com/f')).replace(
        '<?xml version="1.0"?>',
        '<?xml version="1.0" encoding="ISO-8859-1"?>',
      ),
    ]) {
      try {
        expect(parseOpml(doc).entries).toHaveLength(1);
      } catch (e) {
        expect(e).toBeInstanceOf(OpmlError);
      }
    }
  });

  it('keeps non-ASCII feed URLs valid or reports them invalid, never throws', () => {
    const out = parseOpml(
      wrap(feed('https://bücher.example/feed') + feed('https://ok.example.com/f')),
    );
    expect(out.entries.length + out.invalid.length).toBe(2);
  });
});
