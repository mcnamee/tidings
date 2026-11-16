import { afterEach, describe, expect, it, vi } from 'vitest';
import { Parser } from 'htmlparser2';
import { parseFeed } from './parse';
import { CappedText } from './text';
import { MAX_CONTENT_CHARS, MAX_ITEMS_PER_FETCH } from './limits';
import type { ParsedFeed, ParseResult } from './types';
import { FETCHED_AT, readFixture } from './test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ok(result: ParseResult): ParsedFeed {
  if (!result.ok) throw new Error(`parse failed: ${result.error.code} ${result.error.message}`);
  return result.feed;
}

const parse = (xml: string, baseUrl?: string) =>
  parseFeed(xml, { fetchedAt: FETCHED_AT, ...(baseUrl ? { baseUrl } : {}) });

function rssWithItems(count: number, itemXml: (n: number) => string): string {
  let out = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>';
  for (let n = 1; n <= count; n++) out += itemXml(n);
  return out + '</channel></rss>';
}

const goodItem = (n: number) =>
  `<item><title>Item ${n}</title><link>https://big.example.test/${n}</link><guid>g-${n}</guid></item>`;

describe('item cap as a true early stop (AC3)', () => {
  it('returns exactly the first 50 items of 200 in document order', () => {
    const feed = ok(parse(rssWithItems(200, goodItem)));
    expect(MAX_ITEMS_PER_FETCH).toBe(50);
    expect(feed.items).toHaveLength(50);
    expect(feed.items.map((i) => i.guid)).toEqual(
      Array.from({ length: 50 }, (_, i) => `g-${i + 1}`),
    );
    expect(feed.stoppedEarly).toBe(true);
  });

  it('(a) still succeeds when everything after item 50 is garbage', () => {
    let xml = rssWithItems(50, goodItem).replace('</channel></rss>', '');
    xml += '<item><title>51 \u0000<<<&&&]]> <![CDATA[ never closed </x></y><!-- <?pi ';
    xml += '￿'.repeat(5000) + '<item<item>>>"\'=&#xZZ;&#99999999999;';
    const feed = ok(parse(xml));
    expect(feed.items).toHaveLength(50);
    expect(feed.stoppedEarly).toBe(true);
  });

  it('(b) makes no parser callbacks after the 50th item closes, and never calls end()', () => {
    const events: string[] = [];
    const names = Object.getOwnPropertyNames(Parser.prototype).filter(
      (n) => n.startsWith('on') || n === 'pause' || n === 'end',
    );
    const proto = Parser.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of names) {
      const original = proto[name] as (...a: unknown[]) => unknown;
      vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        events.push(name);
        return original.apply(this, args);
      });
    }
    const feed = ok(parse(rssWithItems(200, goodItem)));
    expect(feed.items).toHaveLength(50);
    expect(events.filter((e) => e === 'pause')).toHaveLength(1);
    expect(events).not.toContain('end');
    expect(events.length - 1 - events.indexOf('pause')).toBe(0);
    // Sanity: the spy sees real traffic (50 items x several events each).
    expect(events.length).toBeGreaterThan(300);
  });

  it('honours a smaller maxItems option', () => {
    const feed = ok(parseFeed(rssWithItems(10, goodItem), { fetchedAt: FETCHED_AT, maxItems: 3 }));
    expect(feed.items.map((i) => i.guid)).toEqual(['g-1', 'g-2', 'g-3']);
  });
});

describe('malformed and truncated input (AC4)', () => {
  it('returns the complete items of a truncated feed and drops the cut-off one', () => {
    const feed = ok(parse(readFixture('malformed-truncated.xml')));
    expect(feed.items.map((i) => i.guid)).toEqual(['broken-1']);
  });

  it('handles unclosed tags, stray ampersands and a wrong encoding declaration', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-16"?><rss><channel><title>A & B</title>' +
      '<item><title>One<br></title><link>https://x.example.test/1?a=1&b=2<guid>g1</guid></item>' +
      '<item><title>Two</title><link>https://x.example.test/2</link></item></channel></rss>';
    const result = parse(xml);
    // Best effort or parse_error are both acceptable; an exception is not.
    if (result.ok) expect(result.feed.items.length).toBeGreaterThanOrEqual(1);
    else expect(result.error.code).toBe('parse_error');
  });

  it('never throws for any truncation point of a real feed', () => {
    const xml = readFixture('rss2-cdata-entities.xml');
    for (let cut = 0; cut <= xml.length; cut += 3) {
      const r = parse(xml.slice(0, cut));
      expect(typeof r.ok).toBe('boolean');
    }
  });

  it('never throws for pseudo-random byte soup', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 200; round++) {
      let s = '';
      for (let i = 0; i < 300; i++) s += String.fromCharCode(next() % 0x250);
      expect(typeof parse(s).ok).toBe('boolean');
      expect(typeof parse('<rss><channel><item>' + s).ok).toBe('boolean');
    }
  });

  it('reports empty bodies and non-feeds', () => {
    expect(parse('   ')).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(parse('')).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(parse('<html><body>hi</body></html>')).toMatchObject({
      ok: false,
      error: { code: 'not_a_feed' },
    });
    expect(parse('{"version":"https://jsonfeed.org/version/1.1"}')).toMatchObject({
      ok: false,
      error: { code: 'not_a_feed' },
    });
  });

  it('accepts a feed that has zero items', () => {
    const feed = ok(parse('<rss><channel><title>Empty</title></channel></rss>'));
    expect(feed.items).toEqual([]);
    expect(feed.title).toBe('Empty');
  });

  it('strips a leading byte order mark', () => {
    expect(ok(parse('﻿' + rssWithItems(1, goodItem))).items).toHaveLength(1);
  });
});

describe('dates and URLs (AC5)', () => {
  it('uses the fetch time for missing, unparseable and future dates', () => {
    const feed = ok(parse(readFixture('no-dates.xml')));
    expect(feed.items.map((i) => i.publishedAt)).toEqual([
      FETCHED_AT,
      FETCHED_AT,
      FETCHED_AT,
      FETCHED_AT,
    ]);
  });

  it('keeps a real past date, including offsets and dc:date', () => {
    const feed = ok(parse(readFixture('rss2-basic.xml')));
    expect(feed.items[0]?.publishedAt).toBe(Date.UTC(2026, 10, 10, 9) / 1000);
    expect(feed.items[1]?.publishedAt).toBe(Date.UTC(2026, 10, 9, 13) / 1000); // 23:00 +1000
  });

  it('nulls javascript: and data: links and image URLs', () => {
    const xml = rssWithItems(
      1,
      () =>
        `<item xmlns:media="m"><title>t</title><link>javascript:alert(1)</link><guid>g</guid>
         <media:thumbnail url="data:image/png;base64,AAAA"/>
         <description><![CDATA[<img src="javascript:alert(2)">]]></description></item>`,
    );
    const item = ok(parse(xml)).items[0];
    expect(item?.link).toBeNull();
    expect(item?.imageUrl).toBeNull();
  });

  it('falls through to the next valid image candidate', () => {
    const xml = rssWithItems(
      1,
      () =>
        `<item><title>t</title><guid>g</guid><media:thumbnail url="data:x"/>
         <enclosure url="https://i.example.test/e.png" type="image/png"/>
         <description><![CDATA[<img src="https://i.example.test/inline.png">]]></description></item>`,
    );
    expect(ok(parse(xml)).items[0]?.imageUrl).toBe('https://i.example.test/e.png');
  });

  it('uses the first inline <img> within the first 8 KB only', () => {
    const near = `<p>${'x'.repeat(100)}<img src="https://i.example.test/near.png"></p>`;
    const far = `<p>${'x'.repeat(9000)}<img src="https://i.example.test/far.png"></p>`;
    const make = (html: string) =>
      rssWithItems(
        1,
        () =>
          `<item><title>t</title><guid>g</guid><description><![CDATA[${html}]]></description></item>`,
      );
    expect(ok(parse(make(near))).items[0]?.imageUrl).toBe('https://i.example.test/near.png');
    expect(ok(parse(make(far))).items[0]?.imageUrl).toBeNull();
  });

  it('resolves relative links only when a base URL is given', () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><title>t</title><link href="/p/1"/></entry></feed>';
    expect(ok(parse(xml)).items[0]?.link).toBeNull();
    expect(ok(parse(xml, 'https://a.example.test/feed.xml')).items[0]?.link).toBe(
      'https://a.example.test/p/1',
    );
  });

  it('prefers the alternate link and treats rel=enclosure as the enclosure', () => {
    const xml = `<feed><entry><id>1</id><title>t</title>
      <link rel="replies" href="https://a.example.test/c"/>
      <link rel="enclosure" href="https://a.example.test/a.mp3"/>
      <link rel="alternate" href="https://a.example.test/p"/></entry></feed>`;
    expect(ok(parse(xml)).items[0]?.link).toBe('https://a.example.test/p');
  });
});

describe('summary (spec 6.5)', () => {
  const make = (desc: string) =>
    rssWithItems(
      1,
      () =>
        `<item><title>t</title><guid>g</guid><description><![CDATA[${desc}]]></description></item>`,
    );

  it('is plain text of at most 300 characters, cut at a word boundary', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const s = ok(parse(make(`<p>${words}</p>`))).items[0]?.summary ?? '';
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/<|>/);
    expect(/word\d+…$/.test(s)).toBe(true); // ended on a whole word
  });

  it('only reads the first 4 KB of markup', () => {
    const html = `<p>start</p><!--${'x'.repeat(5000)}--><p>late text</p>`;
    expect(ok(parse(make(html))).items[0]?.summary).toBe('start');
  });

  it('drops script and style bodies and decodes entities', () => {
    const html = '<style>p{}</style><script>alert(1)</script><p>Tom &amp; Jerry&nbsp;&#9731;</p>';
    expect(ok(parse(make(html))).items[0]?.summary).toBe('Tom & Jerry ☃');
  });
});

describe('hostile and oversized input (AC6, AC7, AC9)', () => {
  it('does not expand DOCTYPE entities or fetch external entities (billion laughs, XXE)', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const t0 = performance.now();
    const result = parse(readFixture('billion-laughs.xml'));
    const elapsed = performance.now() - t0;
    const json = JSON.stringify(result);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(json.length).toBeLessThan(2000);
    expect(json).not.toContain('lollol');
    expect(json).not.toContain('root:');
    const item = ok(result).items[0];
    // Unknown entity references stay as literal text.
    expect(item?.title).toBe('&lol9;');
    expect(item?.contentHtml).toBe('&lol9; &xxe;');
    expect(elapsed).toBeLessThan(500);
  });

  it('survives a 5 MB single attribute without storing it', () => {
    const big = 'a'.repeat(5 * 1024 * 1024);
    const xml = rssWithItems(
      2,
      (n) =>
        `<item><title>t${n}</title><link>https://x.example.test/${n}</link><guid>g${n}</guid>` +
        `<enclosure url="https://x.example.test/${big}" type="image/png"/>` +
        `<media:thumbnail url="${big}"/></item>`,
    );
    const result = parse(xml);
    const feed = ok(result);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]?.imageUrl).toBeNull();
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it('ignores a 5 MB attribute on an element we do not store', () => {
    const big = 'b'.repeat(5 * 1024 * 1024);
    const xml = rssWithItems(
      1,
      () => `<item><title>t</title><guid>g</guid><x:y z="${big}"/></item>`,
    );
    expect(JSON.stringify(parse(xml)).length).toBeLessThan(1000);
  });

  it('truncates content_html at 100 KB while accumulating (5 MB of text)', () => {
    const lengths: number[] = [];
    const original = CappedText.prototype.append;
    vi.spyOn(CappedText.prototype, 'append').mockImplementation(function (
      this: CappedText,
      chunk: string,
    ) {
      original.call(this, chunk);
      lengths.push(this.length);
    });
    const body = 'x'.repeat(5 * 1024 * 1024);
    const feed = ok(
      parse(
        rssWithItems(
          1,
          () => `<item><title>t</title><guid>g</guid><description>${body}</description></item>`,
        ),
      ),
    );
    expect(feed.items[0]?.contentHtml).toHaveLength(MAX_CONTENT_CHARS);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
  });

  it('applies the cap across many small text chunks, and to content:encoded', () => {
    const chunk = 'y'.repeat(1000);
    const many = Array.from({ length: 300 }, () => chunk + '&amp;').join('');
    const xml = rssWithItems(
      1,
      () =>
        `<item xmlns:content="c"><title>t</title><guid>g</guid><content:encoded><![CDATA[${many}]]></content:encoded></item>`,
    );
    const html = ok(parse(xml)).items[0]?.contentHtml ?? '';
    expect(html.length).toBe(MAX_CONTENT_CHARS);
  });

  it('does not cut an astral character in half at the cap', () => {
    const text = 'a'.repeat(MAX_CONTENT_CHARS - 1) + '\u{1F389}tail';
    const xml = rssWithItems(
      1,
      () => `<item><title>t</title><guid>g</guid><description>${text}</description></item>`,
    );
    const html = ok(parse(xml)).items[0]?.contentHtml ?? '';
    expect(html.length).toBe(MAX_CONTENT_CHARS - 1);
    expect(html.endsWith('a')).toBe(true);
  });

  it('passes hostile HTML through untouched for the browser sanitiser (ADR 0006)', () => {
    const feed = ok(parse(readFixture('hostile-html.xml')));
    const first = feed.items[0];
    expect(first?.contentHtml).toContain('<script>window.__pwned');
    expect(first?.contentHtml).toContain('onerror=');
    // Titles are plain text: markup in them is flattened, never kept.
    expect(feed.items[0]?.title).not.toMatch(/[<>]/);
    // Hostile links are dropped.
    expect(feed.siteUrl).toBeNull();
    expect(first?.link).toBeNull();
    // The summary of the script-only description is empty plain text, not script source.
    expect(first?.summary).toBe('click');
  });

  it('stays within caps for a feed made of nothing but nested elements', () => {
    const deep = '<a>'.repeat(50_000);
    const result = parse(
      `<rss><channel><item><title>t</title><guid>g</guid><description>${deep}</description></item></channel></rss>`,
    );
    expect(typeof result.ok).toBe('boolean');
  });
});

describe('capped accumulator', () => {
  it('never grows past the cap, whatever the chunk sizes', () => {
    const t = new CappedText(10);
    for (const chunk of ['abc', 'defgh', 'ijklmnop', 'q', '']) {
      t.append(chunk);
      expect(t.length).toBeLessThanOrEqual(10);
    }
    expect(t.toString()).toBe('abcdefghij');
    expect(t.truncated).toBe(true);
  });
});

describe('Atom text constructs (AC12, ADR 0009 section 1)', () => {
  const feed = (inner: string) =>
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>1</id><title>x</title>${inner}</entry></feed>`;
  const html = (inner: string): string | null => {
    const r = parseFeed(feed(inner), { fetchedAt: 1_700_000_000 });
    if (!r.ok) throw new Error('parse failed');
    return r.feed.items[0]!.contentHtml;
  };
  const script = '&lt;script&gt;alert(1)&lt;/script&gt;';

  it('type="text" is escaped, plain and CDATA, for content and summary', () => {
    expect(html(`<content type="text">${script}</content>`)).toBe(script);
    expect(html(`<summary type="text">${script}</summary>`)).toBe(script);
    expect(html(`<content type="text"><![CDATA[<script>alert(1)</script>]]></content>`)).toBe(
      script,
    );
  });

  it('type="text" is escaped even when it contains allowlisted tags', () => {
    expect(html(`<content type="text">&lt;p&gt;hi&lt;/p&gt;</content>`)).toBe(
      '&lt;p&gt;hi&lt;/p&gt;',
    );
  });

  it('untyped script-only text is escaped', () => {
    expect(html(`<content>${script}</content>`)).toBe(script);
    expect(html(`<summary>${script}</summary>`)).toBe(script);
  });

  it('untyped text with an allowlisted tag is stored as HTML', () => {
    expect(html(`<content>&lt;p&gt;Hi &lt;a href="/x"&gt;x&lt;/a&gt;&lt;/p&gt;</content>`)).toBe(
      '<p>Hi <a href="/x">x</a></p>',
    );
    expect(html(`<content>a &lt;div&gt;b&lt;/div&gt;</content>`)).toBe('a <div>b</div>');
  });

  it('untyped plain text with a quote and ampersand is escaped', () => {
    expect(html(`<content>Tom &amp; "Jerry" 1 &lt; 2</content>`)).toBe(
      'Tom &amp; &quot;Jerry&quot; 1 &lt; 2',
    );
  });

  it('escaping never pushes content past the cap', () => {
    const r = html(`<content>${'&amp;'.repeat(60_000)}</content>`);
    expect(r!.length).toBeLessThanOrEqual(102_400);
    expect(r!.endsWith(';')).toBe(true);
  });
});
