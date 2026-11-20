import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFeed } from './parse';
import { FETCHED_AT } from './test-helpers';
import type { ParsedItem } from './types';

const parseItem = (xml: string): ParsedItem => {
  const r = parseFeed(xml, { fetchedAt: FETCHED_AT, baseUrl: 'https://a.example.test/feed' });
  if (!r.ok) throw new Error(`parse failed: ${r.error.code}`);
  return r.feed.items[0]!;
};
const NS =
  'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"';
const rss = (item: string) =>
  `<rss version="2.0" ${NS}><channel><title>T</title>${item}</channel></rss>`;

describe('itunes:image (AC17)', () => {
  it('is the imageUrl when no media or enclosure image exists', () => {
    const item = parseItem(
      rss(
        '<item><guid>g</guid><itunes:image href="https://cdn.example.test/e.jpg"/><description>&lt;img src="https://x.example.test/i.png"&gt;</description></item>',
      ),
    );
    expect(item.imageUrl).toBe('https://cdn.example.test/e.jpg');
  });

  it('comes after media:thumbnail and an image enclosure', () => {
    const itunes = '<itunes:image href="https://cdn.example.test/it.jpg"/>';
    const enc = '<enclosure url="https://cdn.example.test/enc.png" type="image/png"/>';
    const thumb = '<media:thumbnail url="https://cdn.example.test/th.jpg"/>';
    expect(parseItem(rss(`<item><guid>g</guid>${itunes}${enc}${thumb}</item>`)).imageUrl).toBe(
      'https://cdn.example.test/th.jpg',
    );
    expect(parseItem(rss(`<item><guid>g</guid>${itunes}${enc}</item>`)).imageUrl).toBe(
      'https://cdn.example.test/enc.png',
    );
  });

  it('takes untyped media:content (the Guardian) and keeps the widest rendition, but not media files', () => {
    const g = (w: number) =>
      `<media:content width="${w}" url="https://i.guim.co.uk/img/media/abc/master/1.jpg?width=${w}&amp;s=x"><media:credit>Photo</media:credit></media:content>`;
    const item = parseItem(rss(`<item><guid>g</guid>${g(140)}${g(460)}</item>`));
    expect(item.imageUrl).toBe('https://i.guim.co.uk/img/media/abc/master/1.jpg?width=460&s=x');
    expect(item.imageWidth).toBe(460);
    expect(
      parseItem(
        rss('<item><guid>g</guid><media:content url="https://cdn.example.test/ep.mp3"/></item>'),
      ).imageUrl,
    ).toBeNull();
  });

  it('is not taken from channel-level art, and a non-http(s) href is ignored', () => {
    const ch = `<rss version="2.0" ${NS}><channel><title>T</title><itunes:image href="https://cdn.example.test/chan.jpg"/><item><guid>g</guid></item></channel></rss>`;
    expect(parseItem(ch).imageUrl).toBeNull();
    expect(
      parseItem(rss('<item><guid>g</guid><itunes:image href="javascript:alert(1)"/></item>'))
        .imageUrl,
    ).toBeNull();
  });
});

describe('NUL and lone surrogates (AC17)', () => {
  const wellFormed = (s: string) =>
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  it('removes U+0000 and replaces lone surrogates in every stored string', () => {
    const item = parseItem(
      rss(
        '<item><guid>g\u0000id\uD800</guid><title>a\u0000b\uDC00c</title><dc:creator>x\uD83Dy</dc:creator>' +
          '<link>https://a.example.test/p\u0000q</link><description>d\u0000e\uD800f</description></item>',
      ),
    );
    expect(item.guid).toBe('gid�');
    expect(item.title).toBe('ab�c');
    expect(item.author).toBe('x�y');
    expect(item.link).toBe('https://a.example.test/pq');
    expect(item.contentHtml).toBe('de�f');
    expect(item.summary).toBe('de�f');
    for (const v of Object.values(item)) {
      if (typeof v === 'string') {
        expect(v).not.toContain('\u0000');
        expect(wellFormed(v)).toBe(true);
      }
    }
  });

  it('keeps valid surrogate pairs', () => {
    expect(parseItem(rss('<item><guid>g</guid><title>smile 😀</title></item>')).title).toBe(
      'smile 😀',
    );
  });

  it('a summary-derived title never ends in half a surrogate pair', () => {
    const item = parseItem(
      rss(`<item><guid>g</guid><description>${'a'.repeat(79)}😀tail</description></item>`),
    );
    expect(wellFormed(item.title)).toBe(true);
  });
});

describe('one shared canonicaliser and guidHash (AC17)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (name === 'node_modules') return [];
      if (statSync(full).isDirectory()) return sources(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  const consumers = [
    ...sources(path.join(root, 'apps/worker/src')),
    ...sources(path.join(root, 'packages/feed-parser/src')),
  ];

  it('no consumer defines its own canonicaliser or guid hash', () => {
    const offenders = consumers.filter((f) =>
      /(function|const)\s+(canonicalizeHttpUrl|guidHash)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the parser imports both from @tidings/shared', () => {
    const parse = readFileSync(path.join(root, 'packages/feed-parser/src/parse.ts'), 'utf8');
    const key = readFileSync(path.join(root, 'packages/feed-parser/src/key.ts'), 'utf8');
    expect(parse).toMatch(/import \{[^}]*canonicalizeHttpUrl[^}]*\} from '@tidings\/shared\/url'/);
    expect(key).toMatch(/import \{[^}]*guidHash[^}]*\} from '@tidings\/shared\/dedup'/);
  });

  it('the shared package is where both are defined', () => {
    expect(readFileSync(path.join(root, 'packages/shared/src/url.ts'), 'utf8')).toMatch(
      /export function canonicalizeHttpUrl/,
    );
    expect(readFileSync(path.join(root, 'packages/shared/src/dedup.ts'), 'utf8')).toMatch(
      /export (async )?function guidHash/,
    );
  });
});
