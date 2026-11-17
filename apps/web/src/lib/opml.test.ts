import { describe, expect, it } from 'vitest';
import { OpmlError, chunkEntries, parseOpml } from './opml';

// FR-OP-1, FR-OP-2: the browser's reading of an Inoreader export.

const wrap = (body: string) =>
  `<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head><body>${body}</body></opml>`;
const feed = (url: string, title = '') =>
  `<outline type="rss" text="${title || url}" title="${title}" xmlUrl="${url}" htmlUrl="https://site.example.com/"/>`;

describe('parseOpml', () => {
  it('turns top-level outlines with children into folders and flattens deeper ones', () => {
    const p = parseOpml(
      wrap(
        `<outline text="News" title="News">${feed('https://a.example.com/f', 'A')}` +
          `<outline text="World">${feed('https://b.example.com/f')}</outline></outline>` +
          feed('https://c.example.com/f') +
          `<outline text="Tech">${feed('https://d.example.com/f')}</outline>`,
      ),
    );
    expect(p.entries.map((e) => [e.xmlUrl, e.folder])).toEqual([
      ['https://a.example.com/f', 'News'],
      ['https://b.example.com/f', 'News'], // nested folder flattened into its top-level folder
      ['https://c.example.com/f', null],
      ['https://d.example.com/f', 'Tech'],
    ]);
    expect(p.folderCount).toBe(2);
    expect(p.entries[0]?.title).toBe('A');
  });

  it('falls back from title to text for names, and merges folders that differ only in case', () => {
    const p = parseOpml(
      wrap(
        `<outline text="Tech">${feed('https://a.example.com/f')}</outline>` +
          `<outline title="tech">${feed('https://b.example.com/f')}</outline>`,
      ),
    );
    expect(p.folderCount).toBe(1);
    expect(p.entries.map((e) => e.folder)).toEqual(['Tech', 'Tech']);
  });

  it('keeps a feed that appears in several folders in the first one and counts it', () => {
    const p = parseOpml(
      wrap(
        `<outline text="One">${feed('https://a.example.com/f')}${feed('https://z.example.com/f')}</outline>` +
          `<outline text="Two">${feed('https://A.example.com:443/f#frag')}</outline>` +
          feed('https://z.example.com/f'),
      ),
    );
    expect(p.entries).toHaveLength(2);
    expect(p.entries.find((e) => e.xmlUrl === 'https://a.example.com/f')?.folder).toBe('One');
    expect(p.multiFolder).toBe(2);
    expect(p.folderCount).toBe(1); // "Two" holds no kept feed
  });

  it('reports addresses that are not http(s) URLs as invalid', () => {
    const p = parseOpml(
      wrap(feed('not a url') + feed('ftp://x.example.com/f') + feed('https://ok.example.com/f')),
    );
    expect(p.entries).toHaveLength(1);
    expect(p.invalid).toEqual(['not a url', 'ftp://x.example.com/f']);
  });

  it.each([
    ['plain text', 'hello'],
    ['broken XML', '<opml><body><outline xmlUrl="https://a.example.com/f"></opml>'],
    ['other XML', '<rss version="2.0"><channel/></rss>'],
    ['no body', '<opml version="2.0"><head/></opml>'],
    ['no feeds', wrap('<outline text="Empty"/>')],
    ['empty', ''],
  ])('rejects %s', (_name, text) => {
    expect(() => parseOpml(text)).toThrow(OpmlError);
  });
});

describe('chunkEntries', () => {
  const entries = Array.from({ length: 250 }, (_, n) => ({
    xmlUrl: `https://f${n}.example.com/f`,
    folder: n % 5 === 4 ? null : `F${n % 5}`,
  }));

  it('sends at most 100 feeds per request, keeps every feed once, and groups by folder', () => {
    const chunks = chunkEntries(entries);
    const sizes = chunks.map(
      (c) => c.feeds.length + c.folders.reduce((n, f) => n + f.feeds.length, 0),
    );
    expect(sizes).toEqual([100, 100, 50]);
    const urls = chunks
      .flatMap((c) => [...c.feeds, ...c.folders.flatMap((f) => f.feeds)])
      .map((f) => f.xmlUrl);
    expect(new Set(urls).size).toBe(250);
    expect(chunks[0]?.folders.map((f) => f.name)).toEqual(['F0', 'F1', 'F2', 'F3']);
    expect(chunks[0]?.feeds).toHaveLength(20);
  });
});
