import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, tryCanonicalizeUrl } from './url';
import { ValidationError } from './errors';

describe('canonicalizeUrl (spec 6.4)', () => {
  it.each([
    ['HTTP://Example.com:80/feed#x', 'http://example.com/feed'],
    ['feed://example.com/rss', 'https://example.com/rss'],
    ['FEED://Example.com/rss', 'https://example.com/rss'],
    ['feed:https://example.com/rss', 'https://example.com/rss'],
    ['feed:http://example.com/rss', 'http://example.com/rss'],
    ['https://例え.jp/feed', 'https://xn--r8jz45g.jp/feed'],
    ['https://example.com:443/a', 'https://example.com/a'],
    ['http://example.com:8080/a', 'http://example.com:8080/a'],
    ['https://example.com/A%2fb?Q=1&a=%7e', 'https://example.com/A%2fb?Q=1&a=%7e'],
    ['  https://example.com/x  ', 'https://example.com/x'],
    ['https://EXAMPLE.com', 'https://example.com/'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
    '',
    '   ',
    'https://',
    'https://' + 'a'.repeat(2100),
  ])('rejects %j with a ValidationError', (input) => {
    expect(() => canonicalizeUrl(input)).toThrow(ValidationError);
  });

  it('tryCanonicalizeUrl returns null instead of throwing', () => {
    expect(tryCanonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(tryCanonicalizeUrl(null)).toBeNull();
    expect(tryCanonicalizeUrl('HTTP://A.com/')).toBe('http://a.com/');
  });
});
