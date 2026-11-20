import { describe, expect, it } from 'vitest';
import { parseFeed } from '@tidings/feed-parser';
import { isSiteDefault, judgeImage, looksWeakByUrl, upgradeToHttps, verdictRank } from './weak';

// TID-072 (ADR 0020): the weak-image check.

describe('judgeImage', () => {
  it.each([
    'https://a.fsdn.com/sd/twitter_icon_large.png',
    'https://a.fsdn.com/sd/topics/china_64.png',
    'https://example.com/favicon.ico',
    'https://example.com/img/site-logo.png',
    'https://example.com/img/logo.svg',
    'https://secure.gravatar.com/avatar/abc?s=200',
    'https://example.com/assets/sprite.png',
    'https://example.com/avatars/42.jpg',
    'https://example.com/static/default-image.jpg',
    'https://example.com/placeholder.png',
  ])('drops %s as junk', (u) => {
    expect(judgeImage(u)).toBe('junk');
  });

  it.each([
    'https://example.com/wp-content/uploads/2026/photo-150x150.jpg',
    'https://example.com/img/story_64.jpg',
    'https://example.com/thumbs/100x100/story.jpg',
    'https://example.com/story.jpg?w=120',
  ])('keeps %s as small', (u) => {
    expect(judgeImage(u)).toBe('small');
  });

  it('judges a declared size under 300 on either side as small', () => {
    expect(judgeImage('https://x.example.com/i32.jpg', { width: 100, height: 68 })).toBe('small');
    expect(judgeImage('https://x.example.com/i.jpg', { width: 1200, height: 200 })).toBe('small');
    expect(judgeImage('https://x.example.com/i.jpg', { width: 1200, height: 630 })).toBe('good');
    expect(judgeImage('https://x.example.com/i.jpg', { width: null, height: null })).toBe('good');
  });

  it('does not mistake years, ids, big sizes or words that contain a hint for hints', () => {
    for (const u of [
      'https://example.com/2026/11/photo-2026.jpg',
      'https://example.com/photo-1200x630.jpg',
      'https://example.com/img/story_640.jpg',
      'https://example.com/silicon-valley-iconic.jpg',
      'https://example.com/pixel-8-review.jpg',
      'https://cdn.example.com/a/b/c/d.jpg?w=1200',
    ]) {
      expect(judgeImage(u)).toBe('good');
    }
  });

  it('treats a site default as junk and an unparseable URL as junk', () => {
    expect(judgeImage('https://example.com/share.jpg', {}, true)).toBe('junk');
    expect(judgeImage('not a url')).toBe('junk');
  });

  it('detects a site default from two other entries using the same picture', () => {
    expect(isSiteDefault(1)).toBe(false);
    expect(isSiteDefault(2)).toBe(true);
  });

  it('ranks good over small over junk', () => {
    expect(verdictRank('good')).toBeGreaterThan(verdictRank('small'));
    expect(verdictRank('small')).toBeGreaterThan(verdictRank('junk'));
    expect(verdictRank(null)).toBe(0);
    expect(looksWeakByUrl('https://a.fsdn.com/sd/topics/china_64.png')).toBe(true);
  });
});

describe('upgradeToHttps', () => {
  it('upgrades http on known https-capable hosts and on the entry site when it is https', () => {
    expect(upgradeToHttps('http://www.techmeme.com/261120/i32.jpg')).toBe(
      'https://www.techmeme.com/261120/i32.jpg',
    );
    expect(upgradeToHttps('http://img.example.org/a.jpg', 'https://img.example.org/story')).toBe(
      'https://img.example.org/a.jpg',
    );
  });

  it('leaves unknown hosts, ports and https URLs alone', () => {
    expect(upgradeToHttps('http://unknown.example.net/a.jpg')).toBe(
      'http://unknown.example.net/a.jpg',
    );
    expect(upgradeToHttps('http://www.techmeme.com:8080/a.jpg')).toBe(
      'http://www.techmeme.com:8080/a.jpg',
    );
    expect(upgradeToHttps('https://www.techmeme.com/a.jpg')).toBe('https://www.techmeme.com/a.jpg');
  });
});

describe('feed shapes from production', () => {
  const rss = (item: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${item}</channel></rss>`;

  it('Techmeme: a tiny http thumbnail inside a link to the source is small, and upgraded', () => {
    const description =
      '<A HREF="https://www.bloomberg.com/news/articles/x"><IMG SRC="http://www.techmeme.com/261120/i32.jpg" ALIGN="RIGHT" WIDTH="100" HEIGHT="68"></A> <P>Story text</P>';
    const r = parseFeed(
      rss(
        `<item><title>T</title><link>http://www.techmeme.com/261120/p32</link><guid>g</guid><description><![CDATA[${description}]]></description></item>`,
      ),
      { fetchedAt: 1_790_000_000 },
    );
    if (!r.ok) throw new Error('parse');
    const item = r.feed.items[0]!;
    expect(item.imageUrl).toBe('http://www.techmeme.com/261120/i32.jpg');
    expect(item.imageWidth).toBe(100);
    expect(item.imageHeight).toBe(68);
    expect(judgeImage(item.imageUrl!, { width: item.imageWidth, height: item.imageHeight })).toBe(
      'small',
    );
    expect(upgradeToHttps(item.imageUrl!)).toBe('https://www.techmeme.com/261120/i32.jpg');
  });

  it('Slashdot (RSS 1.0): the site-wide twitter icon and the 64px topic icon are junk', () => {
    const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:media="http://search.yahoo.com/mrss/">
      <channel rdf:about="https://slashdot.org/"><title>Slashdot</title><link>https://slashdot.org/</link></channel>
      <item rdf:about="https://tech.slashdot.org/story/26/11/20/1/x"><title>S</title><link>https://tech.slashdot.org/story/26/11/20/1/x</link>
      <media:thumbnail url="https://a.fsdn.com/sd/twitter_icon_large.png"/></item></rdf:RDF>`;
    const r = parseFeed(rdf, { fetchedAt: 1_790_000_000 });
    if (!r.ok) throw new Error('parse');
    expect(r.feed.items[0]!.imageUrl).toBe('https://a.fsdn.com/sd/twitter_icon_large.png');
    expect(judgeImage('https://a.fsdn.com/sd/twitter_icon_large.png')).toBe('junk');
    expect(judgeImage('https://a.fsdn.com/sd/topics/china_64.png')).toBe('junk');
  });

  it('media:thumbnail width and height are carried through', () => {
    const r = parseFeed(
      rss(
        '<item><guid>g</guid><title>t</title><media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="https://c.example.com/a.jpg" width="144" height="81"/></item>',
      ),
      { fetchedAt: 1_790_000_000 },
    );
    if (!r.ok) throw new Error('parse');
    expect(r.feed.items[0]).toMatchObject({ imageWidth: 144, imageHeight: 81 });
  });
});
