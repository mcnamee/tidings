import { describe, expect, it } from 'vitest';
import { dedupKeys, headlineKeyText, urlKeyText } from './dedup-keys';

describe('urlKeyText', () => {
  const base = 'https://www.bbc.co.uk/news/articles/c123';
  it('ignores scheme, www, fragment, trailing slash and tracking parameters', () => {
    const want = urlKeyText(base);
    expect(want).toBe('bbc.co.uk/news/articles/c123');
    for (const v of [
      'http://www.bbc.co.uk/news/articles/c123',
      'https://bbc.co.uk/news/articles/c123/',
      `${base}#comments`,
      `${base}?at_medium=RSS&at_campaign=rss`,
      `${base}?utm_source=x&UTM_Medium=y&ocid=a&cmpid=b&fbclid=c`,
    ]) {
      expect(urlKeyText(v), v).toBe(want);
    }
  });
  it('keeps real query parameters, order-insensitively', () => {
    expect(urlKeyText('https://x.com/a?id=2&b=1&utm_source=z')).toBe(
      urlKeyText('https://x.com/a?b=1&id=2'),
    );
    expect(urlKeyText('https://x.com/a?id=2')).not.toBe(urlKeyText('https://x.com/a?id=3'));
    expect(urlKeyText('https://x.com/?p=7')).toBe('x.com?p=7');
  });
  it('is path-case-sensitive and host-case-insensitive', () => {
    expect(urlKeyText('https://X.com/A')).toBe('x.com/A');
  });
  it('gives no key for a home page, a missing link or a non-http link', () => {
    expect(urlKeyText('https://site.example.com/')).toBeNull();
    expect(urlKeyText('https://site.example.com/?utm_source=a')).toBeNull();
    expect(urlKeyText(null)).toBeNull();
    expect(urlKeyText('mailto:a@b.c')).toBeNull();
    expect(urlKeyText('not a url')).toBeNull();
  });
});

describe('headlineKeyText', () => {
  it('folds case, whitespace, punctuation and quote styles', () => {
    const want = headlineKeyText('Why the PM won\'t quit: "a long read"');
    expect(want).toBe('why the pm wont quit a long read');
    expect(headlineKeyText('WHY THE PM WON’T QUIT – “A  long read”')).toBe(want);
    expect(headlineKeyText('  why the pm wont quit...   a long read ')).toBe(want);
  });
  it('gives no key under 4 words', () => {
    expect(headlineKeyText('Live updates')).toBeNull();
    expect(headlineKeyText('One two three!')).toBeNull();
    expect(headlineKeyText('One two three four')).toBe('one two three four');
    expect(headlineKeyText('... --- !!!')).toBeNull();
    expect(headlineKeyText('')).toBeNull();
    expect(headlineKeyText(null)).toBeNull();
  });
});

describe('dedupKeys', () => {
  it('returns 16-hex keys, equal for equivalent input and null when unusable', async () => {
    const a = await dedupKeys({
      link: 'https://x.com/a/1?utm_source=a',
      title: 'Four words are here',
    });
    const b = await dedupKeys({ link: 'http://www.x.com/a/1', title: 'four WORDS are here!' });
    expect(a).toEqual(b);
    expect(a.urlKey).toMatch(/^[0-9a-f]{16}$/);
    expect(a.headlineKey).toMatch(/^[0-9a-f]{16}$/);
    expect(a.urlKey).not.toBe(a.headlineKey);
    expect(await dedupKeys({ link: null, title: 'Hi' })).toEqual({
      urlKey: null,
      headlineKey: null,
    });
  });
});
