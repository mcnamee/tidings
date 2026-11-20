import { describe, expect, it } from 'vitest';
import { extractPreview, primaryOutboundLink } from './extract';

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
