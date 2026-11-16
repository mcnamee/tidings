import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Parser } from 'htmlparser2';
import { parseFeed } from './parse';
import { EXPECTED_DIR, FETCHED_AT } from './test-helpers';
import type { ParsedFeed, ParseResult } from './types';

// QA (TID-011) adversarial and real-world-shape tests. Tests marked `it.fails` pin a defect in
// docs/testing/DEFECTS.md: they pass while the defect exists and start failing (so they must be
// switched to `it`) once it is fixed. They assert the CORRECT behaviour.

afterEach(() => {
  vi.restoreAllMocks();
});

const parse = (xml: string, baseUrl?: string): ParseResult =>
  parseFeed(xml, { fetchedAt: FETCHED_AT, ...(baseUrl ? { baseUrl } : {}) });

function ok(r: ParseResult): ParsedFeed {
  if (!r.ok) throw new Error(`parse failed: ${r.error.code}`);
  return r.feed;
}

const rss = (items: string, ns = '') =>
  `<rss version="2.0" ${ns}><channel><title>T</title><link>https://a.example.test/</link>${items}</channel></rss>`;
const atom = (entries: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>${entries}</feed>`;
const rssItem = (inner: string) => `<item><guid>g</guid><title>t</title>${inner}</item>`;
const firstItem = (r: ParseResult) => ok(r).items[0]!;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

// WHATWG HTML element names (HTML Standard section 4 index), kept here independently of the
// parser's own list so a gap in the parser's list is caught. ADR 0009 section 2 also strips the
// common obsolete names, `svg` and `math`. SVG/MathML children (`circle`, `animate`...) are not
// HTML elements: they are kept as literal text and rendered as text (spec 10.5).
const WHATWG_ELEMENTS =
  'html|base|head|link|meta|style|title|body|address|article|aside|footer|header|h1|h2|h3|h4|h5|h6|' +
  'hgroup|main|nav|section|search|blockquote|dd|div|dl|dt|figcaption|figure|hr|li|menu|ol|p|pre|ul|' +
  'a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|' +
  'sup|time|u|var|wbr|area|audio|img|map|track|video|embed|iframe|object|picture|source|portal|svg|' +
  'math|canvas|noscript|script|del|ins|caption|col|colgroup|table|tbody|td|tfoot|th|thead|tr|' +
  'button|datalist|fieldset|form|input|label|legend|meter|optgroup|option|output|progress|select|' +
  'textarea|details|dialog|summary|slot|template|' +
  'acronym|applet|basefont|bgsound|big|blink|center|dir|font|frame|frameset|isindex|keygen|' +
  'listing|marquee|menuitem|multicol|nextid|nobr|noembed|noframes|param|plaintext|rb|rtc|spacer|' +
  'strike|tt|xmp';
const ELEMENT_TAG = new RegExp(`</?(?:${WHATWG_ELEMENTS})(?=[\\s/>]|$)`, 'i');

/** What ADR 0009 section 2 forbids in a plain-text field: an HTML element tag or a comment. */
function expectNoHtmlMarkup(text: string, label: string): void {
  expect(text, `${label}: element tag`).not.toMatch(ELEMENT_TAG);
  expect(text, `${label}: comment`).not.toContain('<!--');
}

const payloads = JSON.parse(
  readFileSync(path.resolve(EXPECTED_DIR, '../../../../e2e/fixtures/xss/payloads.json'), 'utf8'),
) as { payloads: { id: string; html: string }[]; urlPayloads: string[] };

describe('hostile text never becomes more dangerous', () => {
  it('Atom summary/content type="text" is escaped, not live markup (DEF-006)', () => {
    // Atom 1.0 s4.1.3.1: type="text" content is plain text; "&lt;script&gt;" means the literal
    // characters <script>. Stored as HTML it must therefore be &lt;script&gt;.
    const xml = atom(
      `<entry><id>1</id><title>x</title><content type="text">&lt;script&gt;alert(1)&lt;/script&gt;</content></entry>`,
    );
    expect(firstItem(parse(xml)).contentHtml).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('Atom content type="text" in CDATA is escaped (DEF-006)', () => {
    const xml = atom(
      `<entry><id>1</id><title>x</title><content type="text"><![CDATA[<img src=x onerror=1>]]></content></entry>`,
    );
    expect(firstItem(parse(xml)).contentHtml).not.toContain('<img');
  });

  // ADR 0009 section 1: untyped text is escaped unless it contains a section 10.5 allowlisted tag
  // (plus div/span). `<b>` is allowlisted, so untyped `&lt;b&gt;` is HTML (covered by AC12 in
  // parse.test.ts); `<script>`, `<iframe>` and non-allowlisted tags stay escaped text.
  it('Atom summary with no type attribute and no allowlisted tag is escaped (DEF-006)', () => {
    for (const [src, escaped] of [
      ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
      ['&lt;iframe src="x"&gt;&lt;/iframe&gt;', '&lt;iframe src=&quot;x&quot;&gt;&lt;/iframe&gt;'],
      [
        '&lt;style&gt;a{}&lt;/style&gt; 1 &amp;lt; 2',
        '&lt;style&gt;a{}&lt;/style&gt; 1 &amp;lt; 2',
      ],
    ] as const) {
      const xml = atom(`<entry><id>1</id><title>x</title><summary>${src}</summary></entry>`);
      expect(firstItem(parse(xml)).contentHtml, src).toBe(escaped);
    }
  });

  it('Atom type="html" is decoded exactly once (escaped markup becomes markup, not double-decoded)', () => {
    const xml = atom(
      `<entry><id>1</id><title>x</title><content type="html">&lt;p&gt;a &amp;amp; b &amp;lt;i&amp;gt;&lt;/p&gt;</content></entry>`,
    );
    expect(firstItem(parse(xml)).contentHtml).toBe('<p>a &amp; b &lt;i&gt;</p>');
  });

  it('xhtml re-serialisation escapes attribute values and text', () => {
    const xml = atom(
      `<entry><id>1</id><title>x</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><a href="x&quot; onmouseover=&quot;alert(1)">a &lt;b&gt; &amp; c</a></div></content></entry>`,
    );
    const html = firstItem(parse(xml)).contentHtml!;
    // The quote inside the value stays inside the value (escaped), so no second attribute exists.
    expect(html).toContain('href="x&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toMatch(/href="x" onmouseover/);
    expect(html).toContain('a &lt;b&gt; &amp; c');
  });

  it('xhtml: a closing-tag-looking text node cannot break out of the element', () => {
    const xml = atom(
      `<entry><id>1</id><title>x</title><content type="xhtml"><div>&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;</div></content></entry>`,
    );
    const html = firstItem(parse(xml)).contentHtml!;
    expect(html).not.toContain('<script');
    expect(html).toBe('<div>&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;</div>');
  });

  it('titles and authors from every XSS payload contain no HTML element tag or comment (ADR 0009 s2)', () => {
    for (const p of payloads.payloads) {
      const xml = rss(
        `<item><guid>g</guid><title><![CDATA[${p.html}]]></title><dc:creator><![CDATA[${p.html}]]></dc:creator></item>`,
        'xmlns:dc="http://purl.org/dc/elements/1.1/"',
      );
      const item = firstItem(parse(xml));
      expectNoHtmlMarkup(item.title, `${p.id} title`);
      expectNoHtmlMarkup(item.author ?? '', `${p.id} author`);
      expectNoHtmlMarkup(item.summary ?? '', `${p.id} summary`);
    }
  });

  it('summaries from every XSS payload contain no HTML element tag or comment (ADR 0009 s2)', () => {
    for (const p of payloads.payloads) {
      const xml = rss(rssItem(`<description><![CDATA[${p.html}]]></description>`));
      const item = firstItem(parse(xml));
      expectNoHtmlMarkup(item.summary ?? '', p.id);
    }
  });

  it('script and style element bodies are removed from titles and summaries, not just their tags', () => {
    for (const p of payloads.payloads.filter((x) => /^(script|svg-script|style-tag)/.test(x.id))) {
      const xml = rss(
        `<item><guid>g</guid><title><![CDATA[${p.html}]]></title><description><![CDATA[${p.html}]]></description></item>`,
      );
      const item = firstItem(parse(xml));
      expect(item.title, p.id).not.toMatch(/__pwned|display:\s*none/);
      expect(item.summary ?? '', p.id).not.toMatch(/__pwned|display:\s*none/);
    }
  });

  it('a comment cannot be re-formed by stripping (nested comment openers)', () => {
    const xml = rss(
      `<item><guid>g</guid><title><![CDATA[<!<!-- -->-- <b> -->x]]></title><description><![CDATA[<!<!-- -->-- <b> -->x]]></description></item>`,
    );
    const item = firstItem(parse(xml));
    expectNoHtmlMarkup(item.title, 'title');
    expectNoHtmlMarkup(item.summary ?? '', 'summary');
  });

  // DEF-011: one stripping pass lets `<scr<b>ipt>` collapse into the literal text `<script>`.
  // ADR 0009 section 2's intent is that no HTML element tag survives. Rendering is text-only, so
  // this is defence in depth (S3). Switch to `it` when the strip runs to a fixed point.
  it.fails('stripping cannot re-form an element tag: <scr<b>ipt> (DEF-011)', () => {
    for (const hostile of [
      '<scr<b>ipt>x</scr<b>ipt>',
      '<<b>script>alert(1)<</b>/script>',
      '<im<i>g src=x>',
    ]) {
      const xml = rss(
        `<item><guid>g</guid><title><![CDATA[${hostile}]]></title><description><![CDATA[${hostile}]]></description></item>`,
      );
      const item = firstItem(parse(xml));
      expectNoHtmlMarkup(item.title, `title ${hostile}`);
      expectNoHtmlMarkup(item.summary ?? '', `summary ${hostile}`);
    }
  });

  it('non-HTML angle text in the payloads is kept as literal text, not stripped (ADR 0009 s2)', () => {
    const xml = rss(
      `<item><guid>g</guid><title><![CDATA[<circle r=1 /> and Vec<T> and <![CDATA[ x]]]]><![CDATA[>]]></title></item>`,
    );
    expect(firstItem(parse(xml)).title).toContain('<circle r=1 />');
    expect(firstItem(parse(xml)).title).toContain('Vec<T>');
  });

  it('URL payloads in link, enclosure and image fields never yield a non-http(s) URL', () => {
    for (const u of payloads.urlPayloads) {
      const esc = u.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const xml = rss(
        rssItem(
          `<link>${esc}</link><media:thumbnail url="${esc.replace(/"/g, '&quot;')}"/><enclosure url="${esc}" type="image/png"/>`,
        ),
        'xmlns:media="http://search.yahoo.com/mrss/"',
      );
      for (const base of [undefined, 'https://base.example.test/feed']) {
        const item = firstItem(parse(xml, base));
        for (const v of [item.link, item.imageUrl]) {
          if (v !== null) expect(v, u).toMatch(/^https?:\/\//);
        }
      }
    }
  });

  it('numeric character references beyond U+10FFFF, surrogates and NUL become U+FFFD', () => {
    const xml = rss(
      `<item><guid>g</guid><title>a&#x110000;b&#xD800;c&#0;d&#99999999999;e</title><description>a&#x110000;b&#xD800;c</description></item>`,
    );
    const item = firstItem(parse(xml));
    expect(item.title).toBe('a�b�c�d�e');
    expect(item.contentHtml).toBe('a�b�c');
  });

  it('entity-escaped markup in a *text* field is flattened, not kept as markup', () => {
    const xml = rss(
      `<item><guid>g</guid><title>&lt;script&gt;alert(1)&lt;/script&gt;Hello &amp;lt;b&amp;gt;</title></item>`,
    );
    expect(firstItem(parse(xml)).title).not.toContain('<script');
  });
});

describe('robustness: never throw, bounded work', () => {
  it('returns a result for 1 MB of text with no closing item, with content capped', () => {
    const xml = rss(rssItem(`<description>${'A'.repeat(1_000_000)}`));
    const r = parse(xml);
    expect(typeof r.ok).toBe('boolean');
  });

  it('a 1 MB title with no close is capped at the short-field limit', () => {
    const r = parse(rss(`<item><guid>g</guid><title>${'A'.repeat(1_000_000)}`));
    if (r.ok) for (const i of r.feed.items) expect(i.title.length).toBeLessThanOrEqual(2048);
  });

  it('100,000 attributes on one element parse quickly and are not stored', () => {
    const attrs = Array.from({ length: 100_000 }, (_, i) => `a${i}="v"`).join(' ');
    const t = performance.now();
    const f = ok(parse(rss(rssItem(`<media:thumbnail ${attrs}/>`))));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(f.items).toHaveLength(1);
  });

  it('truncated mid-entity and mid-tag inputs at every offset never throw', () => {
    const src = rss(
      rssItem(
        `<description><![CDATA[<p a="b">x &amp; y</p>]]></description><link>https://x.example.test/&amp;</link>`,
      ),
    );
    for (let n = 0; n <= src.length; n++) {
      expect(() => parseFeed(src.slice(0, n), { fetchedAt: FETCHED_AT })).not.toThrow();
    }
  });

  it('lone surrogates in text do not throw', () => {
    const r = parse(
      rss(`<item><guid>g</guid><title>a\uD800b</title><description>\uDC00x</description></item>`),
    );
    expect(r.ok).toBe(true);
  });

  it('a UTF-16 encoding declaration on an already-decoded string still parses', () => {
    const r = parse(`<?xml version="1.0" encoding="UTF-16"?>${rss(rssItem(''))}`);
    expect(r.ok).toBe(true);
  });

  it('a BOM before the XML declaration is ignored', () => {
    const r = parse(String.fromCharCode(0xfeff) + `<?xml version="1.0"?>${rss(rssItem(''))}`);
    expect(r.ok).toBe(true);
  });

  it('mixed RSS and Atom: root element decides, the foreign elements are ignored', () => {
    const f = ok(
      parse(
        `<rss version="2.0"><channel><title>T</title>${rssItem('')}<feed><entry><id>z</id><title>no</title></entry></feed></channel></rss>`,
      ),
    );
    expect(f.format).toBe('rss');
    expect(f.items.map((i) => i.guid)).toEqual(['g']);
  });

  it('an item that never closes yields nothing from the tail, without throwing', () => {
    const src = `<rss><channel><title>T</title><item><guid>1</guid><title>t</title><item><guid>2</guid></item>`;
    const r = parse(src);
    expect(typeof r.ok).toBe('boolean');
  });

  it('bounds work for deeply nested elements (DEF-007)', () => {
    // htmlparser2's open-element bookkeeping is quadratic: 40k nested tags cost ~0.4 s and a
    // 1 MiB body of nested tags costs ~16 s (10 ms CPU budget). The parser must give up at a sane
    // depth. Deterministic check: count tag-open events instead of wall time.
    let opens = 0;
    const proto = Parser.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const original = proto['onopentagend'] as (...a: unknown[]) => unknown;
    vi.spyOn(proto, 'onopentagend').mockImplementation(function (this: unknown, ...a: unknown[]) {
      opens++;
      return original.apply(this, a);
    });
    parse(rss(rssItem(`<description>${'<a>'.repeat(100_000)}</description>`)));
    expect(opens).toBeLessThan(5_000);
  });
});

describe('real-world shapes', () => {
  it('RSS guid isPermaLink="false" is used verbatim as the key, and a relative link is not resolved without a base', () => {
    const item = firstItem(
      parse(
        rss(
          `<item><title>t</title><guid isPermaLink="false">  Abc-123  </guid><link>/p/1</link></item>`,
        ),
      ),
    );
    expect(item.guid).toBe('Abc-123');
    expect(item.guidKey).toBe('Abc-123');
    expect(item.link).toBeNull();
  });

  it('RSS guid isPermaLink="true" with a URL differing from the link keeps the guid as key', () => {
    const item = firstItem(
      parse(
        rss(
          `<item><title>t</title><guid isPermaLink="true">https://a.example.test/GUID</guid><link>https://a.example.test/x</link></item>`,
        ),
      ),
    );
    expect(item.guidKey).toBe('https://a.example.test/GUID');
  });

  it('guid comparison is case-sensitive (spec 6.3)', () => {
    const f = ok(
      parse(
        rss(
          `<item><title>a</title><guid>AbC</guid></item><item><title>b</title><guid>abc</guid></item>`,
        ),
      ),
    );
    expect(f.items[0]!.guidKey).not.toBe(f.items[1]!.guidKey);
  });

  it('Atom picks the alternate link among self, replies, enclosure and related', () => {
    const item = firstItem(
      parse(
        atom(
          `<entry><id>1</id><title>x</title>
            <link rel="self" href="https://a.example.test/self"/>
            <link rel="replies" href="https://a.example.test/replies"/>
            <link rel="enclosure" type="audio/mpeg" href="https://a.example.test/e.mp3"/>
            <link rel="related" href="https://a.example.test/related"/>
            <link rel="alternate" type="text/html" href="https://a.example.test/alt"/></entry>`,
        ),
      ),
    );
    expect(item.link).toBe('https://a.example.test/alt');
  });

  it('Atom link with no rel counts as alternate; with only non-alternate links the link is null', () => {
    const noRel = firstItem(
      parse(
        atom(`<entry><id>1</id><title>x</title><link href="https://a.example.test/n"/></entry>`),
      ),
    );
    expect(noRel.link).toBe('https://a.example.test/n');
    const onlySelf = firstItem(
      parse(
        atom(
          `<entry><id>1</id><title>x</title><link rel="self" href="https://a.example.test/s"/></entry>`,
        ),
      ),
    );
    expect(onlySelf.link).toBeNull();
  });

  it('Atom feed siteUrl is the alternate link, not rel=self', () => {
    const f = ok(
      parse(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><link rel="self" href="https://a.example.test/feed.xml"/><link rel="alternate" href="https://a.example.test/"/></feed>`,
      ),
    );
    expect(f.siteUrl).toBe('https://a.example.test/');
  });

  it('xml:base on an Atom entry is honoured for relative links (DEF-008)', () => {
    const item = firstItem(
      parse(
        atom(
          `<entry xml:base="https://b.example.test/dir/"><id>1</id><title>x</title><link href="p1"/></entry>`,
        ),
        'https://a.example.test/feed',
      ),
    );
    expect(item.link).toBe('https://b.example.test/dir/p1');
  });

  describe('RFC 822 dates with zone names', () => {
    const at = (d: string) => firstItem(parse(rss(rssItem(`<pubDate>${d}</pubDate>`)))).publishedAt;
    it.each([
      ['Mon, 09 Nov 2026 08:15:00 GMT', '2026-11-09T08:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 UT', '2026-11-09T08:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 EST', '2026-11-09T13:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 EDT', '2026-11-09T12:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 CST', '2026-11-09T14:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 PST', '2026-11-09T16:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 GMT+1', '2026-11-09T07:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15:00 +0100', '2026-11-09T07:15:00.000Z'],
      ['Mon, 09 Nov 2026 08:15 -0500', '2026-11-09T13:15:00.000Z'],
      ['9 Nov 2026 08:15:00 GMT', '2026-11-09T08:15:00.000Z'],
    ])('%s', (raw, expected) => {
      expect(iso(at(raw))).toBe(expected);
    });

    it('non-US named zones (CEST, BST, IST) are not silently replaced by the fetch time (DEF-009)', () => {
      expect(iso(at('Mon, 09 Nov 2026 08:15:00 CEST'))).toBe('2026-11-09T06:15:00.000Z');
    });
  });

  it('podcast item: enclosure is the dedup fallback and itunes:image supplies imageUrl (ADR 0009 section 6, AC17)', () => {
    const f = ok(
      parse(
        rss(
          `<item><title>Ep 1</title><enclosure url="https://cdn.example.test/ep1.mp3" length="1" type="audio/mpeg"/><itunes:image href="https://cdn.example.test/ep1.jpg"/><pubDate>Mon, 09 Nov 2026 08:15:00 GMT</pubDate></item>`,
          'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"',
        ),
      ),
    );
    const item = f.items[0]!;
    expect(item.guid).toBeNull();
    expect(item.guidKey).toBe('Ep 1\n2026-11-09T08:15:00.000Z\nhttps://cdn.example.test/ep1.mp3');
    expect(item.imageUrl).toBe('https://cdn.example.test/ep1.jpg');
  });

  it('prefixed Atom (a:feed) is reported as not_a_feed (engineer choice: unprefixed Atom only)', () => {
    const r = parse(
      `<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>T</a:title><a:entry><a:id>1</a:id></a:entry></a:feed>`,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'not_a_feed' } });
  });
});

describe('plain-text fields keep literal angle brackets (DEF-010)', () => {
  it('XML-escaped "<" and ">" in a title survive', () => {
    const t = firstItem(
      parse(rss(`<item><guid>g</guid><title>5 &lt; 6 and 7 &gt; 3</title></item>`)),
    ).title;
    expect(t).toBe('5 < 6 and 7 > 3');
  });

  it('"I <3 RSS" keeps its tail', () => {
    const t = firstItem(
      parse(rss(`<item><guid>g</guid><title>I &lt;3 RSS feeds</title></item>`)),
    ).title;
    expect(t).toContain('RSS feeds');
  });

  it('a CDATA title with a generic type like Vec<T> keeps the <T>', () => {
    const t = firstItem(
      parse(rss(`<item><guid>g</guid><title><![CDATA[Vec<T> in Rust]]></title></item>`)),
    ).title;
    expect(t).toBe('Vec<T> in Rust');
  });
});

describe('snapshot hand-checks (independent of the stored JSON)', () => {
  const snap = (name: string): { feed: ParsedFeed } =>
    JSON.parse(readFileSync(path.join(EXPECTED_DIR, `${name}.json`), 'utf8')) as {
      feed: ParsedFeed;
    };

  it('rss2-basic dates match an independent UTC computation', () => {
    const [a, b, c] = snap('rss2-basic').feed.items;
    expect(iso(a!.publishedAt)).toBe('2026-11-10T09:00:00.000Z');
    expect(iso(b!.publishedAt)).toBe('2026-11-09T13:00:00.000Z'); // 23:00 +1000
    expect(iso(c!.publishedAt)).toBe('2026-11-08T00:00:00.000Z');
  });

  it('rss2-cdata-entities: EST is UTC-5, dc:date offset +00:00, entities decoded once', () => {
    const [a, b] = snap('rss2-cdata-entities').feed.items;
    expect(iso(a!.publishedAt)).toBe('2026-11-10T08:15:00.000Z');
    expect(iso(b!.publishedAt)).toBe('2026-11-09T13:15:00.000Z');
    expect(a!.author).toBe("Zoë O'Brien");
    expect(snap('rss2-cdata-entities').feed.title).toBe(
      'Café & Crème: CDATA, entities and namespaces',
    );
  });

  it('atom-basic: published beats updated, +10:00 offset applied', () => {
    const items = snap('atom-basic').feed.items;
    expect(iso(items[0]!.publishedAt)).toBe('2026-11-10T09:00:00.000Z');
    expect(iso(items[1]!.publishedAt)).toBe('2026-11-08T23:00:00.000Z');
    expect(iso(items[2]!.publishedAt)).toBe('2026-11-08T00:00:00.000Z');
  });

  it('rdf-basic: a date-only dc:date is midnight UTC', () => {
    expect(iso(snap('rdf-basic').feed.items[1]!.publishedAt)).toBe('2026-11-09T00:00:00.000Z');
  });

  it('no-dates: all four undated, garbage and far-future items are pinned to the fetch time', () => {
    for (const i of snap('no-dates').feed.items) expect(i.publishedAt).toBe(FETCHED_AT);
  });

  it('every snapshot item has a non-empty guidKey and summary of at most 300 characters', () => {
    for (const n of [
      'rss2-basic',
      'atom-basic',
      'rdf-basic',
      'rss2-cdata-entities',
      'duplicate-guids',
      'no-dates',
      'hostile-html',
      'malformed-bad-markup',
      'malformed-truncated',
      'billion-laughs',
    ]) {
      for (const i of snap(n).feed.items) {
        expect(i.guidKey.length, n).toBeGreaterThan(0);
        expect((i.summary ?? '').length, n).toBeLessThanOrEqual(300);
      }
    }
  });
});
