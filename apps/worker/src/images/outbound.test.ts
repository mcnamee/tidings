import { describe, expect, it } from 'vitest';
import { extractPreview, isNoiseLink, pageOutboundLink, primaryOutboundLink } from './extract';

const APP = 'https://tidings.mcn.am';
const PAGE = 'https://www.example.com/en/latest/article.1';

describe('primaryOutboundLink (TID-072)', () => {
  const ENTRY = 'http://www.techmeme.com/261120/p32';
  const link = (html: string | null, entry = ENTRY) => primaryOutboundLink(html, entry, APP);

  it('prefers the link that wraps the feed image (the Techmeme shape)', () => {
    const html =
      '<A HREF="https://www.techmeme.com/261120/p32#a">permalink</A> <A HREF="https://www.bloomberg.com/news/x"><IMG SRC="http://www.techmeme.com/261120/i32.jpg" WIDTH="100"></A> <A HREF="https://other.example.com/y">other</A>';
    expect(link(html)).toBe('https://www.bloomberg.com/news/x');
  });

  it('falls back to the first content link on a different site', () => {
    const html =
      '<p><a href="https://tech.slashdot.org/story/1">self</a> <a href="https://www.reuters.com/a?b=1&amp;c=2">src</a> <a href="https://other.example.com/">x</a></p>';
    expect(link(html, 'https://tech.slashdot.org/story/2')).toBe(
      'https://www.reuters.com/a?b=1&c=2',
    );
  });

  it('treats subdomains of the entry site, and co.uk-style sites, as the same site', () => {
    expect(link('<a href="https://news.bbc.co.uk/a">x</a>', 'https://www.bbc.co.uk/n')).toBeNull();
    expect(link('<a href="https://bbc.com/a">x</a>', 'https://www.bbc.co.uk/n')).toBe(
      'https://bbc.com/a',
    );
  });

  it('ignores non-http, private, credentialed and malformed links, and empty content', () => {
    const html =
      '<a href="javascript:alert(1)">a</a><a href="mailto:x@y.z">b</a><a href="http://127.0.0.1/x">c</a><a href="http://10.0.0.2/">d</a><a href="https://u:p@evil.example.com/">e</a><a href=\'https://ok.example.org/p\'>f</a>';
    expect(link(html)).toBe('https://ok.example.org/p');
    expect(link(null)).toBeNull();
    expect(link('<p>no links</p>')).toBeNull();
    expect(link('<a href="https://a.example.org/">x</a>', 'not a url')).toBeNull();
  });

  it('is bounded: reads only the first 16 KB', () => {
    const html = 'x'.repeat(20_000) + '<a href="https://late.example.org/">late</a>';
    expect(link(html)).toBeNull();
  });
});

describe('extractPreview (TID-072)', () => {
  it('returns the declared og size with the URL', () => {
    const html =
      '<head><meta property="og:image" content="https://cdn.example.com/a.jpg"><meta property="og:image:width" content="640"><meta property="og:image:height" content="360"></head>';
    expect(extractPreview(html, PAGE, APP)).toEqual({
      url: 'https://cdn.example.com/a.jpg',
      width: 640,
      height: 360,
    });
  });
});

describe('share and social links (TID-072b)', () => {
  it.each([
    'http://twitter.com/home?status=x',
    'https://x.com/intent/post?text=x',
    'https://twitter.com/someone/status/1',
    'http://www.facebook.com/sharer.php?u=https%3A%2F%2Fa.example.com',
    'https://www.linkedin.com/in/someone/',
    'https://www.reddit.com/submit?url=x',
    'https://news.ycombinator.com/submitlink?u=x',
    'https://www.example.org/share?url=x',
    'https://www.example.org/a?share=twitter',
    'https://feeds.feedburner.com/~r/x',
  ])('treats %s as noise', (u) => expect(isNoiseLink(u)).toBe(true));

  it.each([
    'https://www.reddit.com/r/news/comments/1/title/',
    'https://www.nbcnews.com/business/markets/a-rcna1',
    'https://www.example.org/shared-memories-2026',
  ])('keeps %s', (u) => expect(isNoiseLink(u)).toBe(false));

  it('primaryOutboundLink skips share links and the entry site, and finds nothing in a share-only description', () => {
    const entry = 'https://news.slashdot.org/story/1';
    const shareOnly =
      '<a href="http://twitter.com/home?status=x"><img src="i.png"></a><a href="http://www.facebook.com/sharer.php?u=x">f</a><a href="https://slashdot.org/x">self</a>';
    expect(primaryOutboundLink(shareOnly, entry, APP)).toBeNull();
    expect(
      primaryOutboundLink(shareOnly + '<a href="https://www.nbcnews.com/a">src</a>', entry, APP),
    ).toBe('https://www.nbcnews.com/a');
  });
});

describe('pageOutboundLink (TID-072b)', () => {
  const ENTRY = 'https://news.slashdot.org/story/1';
  const find = (html: string) => pageOutboundLink(html, ENTRY, ENTRY, APP);

  it('takes the first external, non-social link inside the article, ignoring nav, byline and own site', () => {
    const html =
      '<nav><a href="https://nav.example.com/">n</a></nav><article><a href="https://www.linkedin.com/in/x">by</a><a href="https://tech.slashdot.org/a">s</a><p>text <a href="https://www.reuters.com/a">src</a> <a href="https://b.example.org/">b</a></p></article><footer><a href="https://foot.example.com/">f</a></footer>';
    expect(find(html)).toBe('https://www.reuters.com/a');
  });

  it('prefers itemprop=articleBody over a wider article', () => {
    const html =
      '<article><a href="https://author.example.com/">a</a><div itemprop="articleBody"><a href="https://src.example.org/s">s</a></div></article>';
    expect(find(html)).toBe('https://src.example.org/s');
  });

  it('does not run on into the footer or aside, and falls back to after the h1', () => {
    expect(
      find('<article><p>none</p></article><a href="https://after.example.com/">x</a>'),
    ).toBeNull();
    expect(
      find(
        '<nav><a href="https://nav.example.com/">n</a></nav><h1>T</h1><p><a href="https://src.example.org/">s</a></p><footer><a href="https://f.example.com/">f</a></footer>',
      ),
    ).toBe('https://src.example.org/');
    expect(
      find('<div class="body-wrapper"><a href="https://x.example.org/">x</a></div>'),
    ).toBeNull();
  });

  it('skips private, credentialed and non-http links, and the final (redirected) site', () => {
    const html =
      '<article><a href="http://10.0.0.1/">p</a><a href="https://u:p@e.example.com/">c</a><a href="ftp://f.example.com/">f</a><a href="https://moved.example.net/x">m</a><a href="https://ok.example.org/">ok</a></article>';
    expect(pageOutboundLink(html, 'https://moved.example.net/s', ENTRY, APP)).toBe(
      'https://ok.example.org/',
    );
  });

  it('is bounded and fast on a 128 KB page of anchors', () => {
    const html = '<article>' + '<a href="https://self.slashdot.org/x">s</a>'.repeat(3000);
    const t = performance.now();
    expect(find(html)).toBeNull();
    expect(performance.now() - t).toBeLessThan(50);
  });
});
