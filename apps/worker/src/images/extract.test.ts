import { describe, expect, it } from 'vitest';
import { decodeEntities, extractPreviewImage, MAX_PAGE_BYTES } from './extract';

const APP = 'https://tidings.mcn.am';
const PAGE = 'https://www.example.com/en/latest/article.1';
const x = (head: string, body = '<body><img src="/not-this.jpg"></body>') =>
  extractPreviewImage(`<!doctype html><html><head>${head}</head>${body}</html>`, PAGE, APP);

describe('extractPreviewImage (TID-071)', () => {
  it('reads og:image', () => {
    expect(x('<meta property="og:image" content="https://cdn.example.com/a.jpg">')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('prefers og:image over og:image:secure_url over twitter:image over image_src, whatever the order', () => {
    const head =
      '<link rel="image_src" href="https://cdn.example.com/link.jpg">' +
      '<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">' +
      '<meta property="og:image:secure_url" content="https://cdn.example.com/secure.jpg">';
    expect(x(head)).toBe('https://cdn.example.com/secure.jpg');
    expect(x(head + '<meta property="og:image" content="https://cdn.example.com/og.jpg">')).toBe(
      'https://cdn.example.com/og.jpg',
    );
    expect(x(head.replace(/<meta property[^>]*>/, ''))).toBe('https://cdn.example.com/tw.jpg');
    expect(x('<link rel="image_src" href="https://cdn.example.com/link.jpg">')).toBe(
      'https://cdn.example.com/link.jpg',
    );
    expect(x('<link rel="Shortcut image_src" href="https://cdn.example.com/link.jpg">')).toBe(
      'https://cdn.example.com/link.jpg',
    );
  });

  it('accepts name= for og and any attribute order, quote style and case', () => {
    expect(x('<META CONTENT=\'https://cdn.example.com/a.jpg\' NAME="og:image" />')).toBe(
      'https://cdn.example.com/a.jpg',
    );
    expect(x('<meta content=https://cdn.example.com/b.jpg property=og:image>')).toBe(
      'https://cdn.example.com/b.jpg',
    );
  });

  it('resolves relative and protocol-relative URLs against the final page URL', () => {
    expect(x('<meta property="og:image" content="/img/a.jpg">')).toBe(
      'https://www.example.com/img/a.jpg',
    );
    expect(x('<meta property="og:image" content="a.jpg">')).toBe(
      'https://www.example.com/en/latest/a.jpg',
    );
    expect(x('<meta property="og:image" content="//cdn.example.com/a.jpg">')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('decodes entity-encoded URLs', () => {
    expect(
      x(
        '<meta property="og:image" content="https://cdn.example.com/a.jpg?w=1&amp;h=2&#38;q=&#x37;0">',
      ),
    ).toBe('https://cdn.example.com/a.jpg?w=1&h=2&q=70');
    expect(
      x('<meta property="og:image" content="https://cdn.example.com/a&quot;b.jpg">'),
    ).toBeNull();
    expect(decodeEntities('a&amp;b &bogus; &#0; &#x110000; &#xD800; &#65;')).toBe(
      'a&b &bogus;    A',
    );
  });

  it('ignores a tiny declared og:image size and falls to the next candidate', () => {
    const head =
      '<meta property="og:image" content="https://cdn.example.com/pixel-ish.jpg">' +
      '<meta property="og:image:width" content="1"><meta property="og:image:height" content="1">' +
      '<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">';
    expect(x(head)).toBe('https://cdn.example.com/tw.jpg');
    expect(
      x(
        '<meta property="og:image" content="https://cdn.example.com/big.jpg"><meta property="og:image:width" content="1200">',
      ),
    ).toBe('https://cdn.example.com/big.jpg');
  });

  it('ignores obvious placeholders and icons', () => {
    expect(x('<meta property="og:image" content="https://cdn.example.com/logo.png">')).toBeNull();
    expect(
      x('<meta property="og:image" content="https://cdn.example.com/favicon.ico">'),
    ).toBeNull();
    expect(
      x('<meta property="og:image" content="https://cdn.example.com/images/Placeholder-1.jpg">'),
    ).toBeNull();
    expect(
      x('<meta property="og:image" content="https://cdn.example.com/logo-of-the-year-winner.jpg">'),
    ).toBeNull();
  });

  it('rejects hostile values: schemes, private hosts, credentials, control characters, long URLs', () => {
    const og = (v: string) => x(`<meta property="og:image" content="${v}">`);
    expect(og('data:image/png;base64,AAAA')).toBeNull();
    expect(og('javascript:alert(1)')).toBeNull();
    expect(og('&#106;avascript:alert(1)')).toBeNull();
    expect(og('file:///etc/passwd')).toBeNull();
    expect(og('http://127.0.0.1/a.jpg')).toBeNull();
    expect(og('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(og('http://[::1]/a.jpg')).toBeNull();
    expect(og('http://localhost/a.jpg')).toBeNull();
    expect(og('http://10.0.0.5/a.jpg')).toBeNull();
    expect(og('https://user:pw@cdn.example.com/a.jpg')).toBeNull();
    expect(og('https://cdn.example.com/a.jpg&#10;x')).toBeNull();
    expect(og('https://cdn.example.com/' + 'a'.repeat(3000))).toBeNull();
    expect(og('')).toBeNull();
    expect(og('   ')).toBeNull();
  });

  it('falls through a rejected candidate to a valid one', () => {
    expect(
      x(
        '<meta property="og:image" content="javascript:x"><meta name="twitter:image" content="https://cdn.example.com/ok.jpg">',
      ),
    ).toBe('https://cdn.example.com/ok.jpg');
  });

  it('does not read meta tags in the body, scripts, styles or comments', () => {
    expect(
      x(
        '<!-- <meta property="og:image" content="https://cdn.example.com/comment.jpg"> -->' +
          '<script>var s = \'<meta property="og:image" content="https://cdn.example.com/script.jpg">\'</script>' +
          '<style>/* <meta property="og:image" content="https://cdn.example.com/style.jpg"> */</style>',
        '<body><meta property="og:image" content="https://cdn.example.com/body.jpg"></body>',
      ),
    ).toBeNull();
  });

  it('survives malformed HTML', () => {
    const bare = (h: string) => extractPreviewImage(h, PAGE, APP);
    expect(
      bare('<head><meta property="og:image" content="https://cdn.example.com/a.jpg"'),
    ).toBeNull(); // unterminated
    expect(x('<meta property="og:image" content="https://cdn.example.com/a.jpg>')).toBeNull(); // unclosed quote
    expect(
      x('<<<<>>>> <meta ===== > <meta property=og:image content=https://cdn.example.com/ok.jpg>'),
    ).toBe('https://cdn.example.com/ok.jpg');
    expect(x('<meta property="og:image">')).toBeNull(); // no content
    expect(x('<meta property="og:image" content>')).toBeNull();
    expect(extractPreviewImage('', PAGE, APP)).toBeNull();
    expect(extractPreviewImage('\u0000�<', PAGE, APP)).toBeNull();
    expect(
      x(
        '<meta property="og:image" content="https://cdn.example.com/a.jpg" content="https://cdn.example.com/b.jpg">',
      ),
    ).toBe('https://cdn.example.com/a.jpg');
  });

  it('is linear on hostile input and bounded by the 128 KB cut', () => {
    const t0 = Date.now();
    expect(extractPreviewImage('<meta ' + 'a="b" '.repeat(50_000), PAGE, APP)).toBeNull();
    expect(extractPreviewImage('<meta ' + '='.repeat(100_000), PAGE, APP)).toBeNull();
    expect(extractPreviewImage('<'.repeat(100_000), PAGE, APP)).toBeNull();
    expect(extractPreviewImage('<a '.repeat(50_000), PAGE, APP)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('ignores a candidate that only appears after the 128 KB cut', () => {
    const filler = '<meta name="x" content="' + 'z'.repeat(1000) + '">';
    const head = filler.repeat(Math.ceil(MAX_PAGE_BYTES / filler.length) + 2);
    const tail = '<meta property="og:image" content="https://cdn.example.com/late.jpg">';
    expect(x(head + tail)).toBeNull();
    expect(x(tail + head)).toBe('https://cdn.example.com/late.jpg');
  });
});
