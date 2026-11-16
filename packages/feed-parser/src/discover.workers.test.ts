import { describe, expect, it } from 'vitest';
import { discoverFeeds } from './discover';

const PAGE = 'https://blog.example.test/posts/index.html';

describe('discoverFeeds (HTMLRewriter, AC8)', () => {
  it('returns the absolute feed URL for a relative rss+xml link', async () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed">
    </head><body></body></html>`;
    expect(await discoverFeeds(html, PAGE)).toEqual([
      { url: 'https://blog.example.test/feed', kind: 'rss', title: 'Posts', supported: true },
    ]);
  });

  it('finds Atom links, resolves relative paths and dedupes', async () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="atom.xml">
      <link rel="ALTERNATE" type="application/atom+xml" href="https://blog.example.test/posts/atom.xml#x">
      <link rel="stylesheet" type="text/css" href="/s.css">
      <link rel="alternate" type="text/html" href="/fr">`;
    const found = await discoverFeeds(html, PAGE);
    expect(found).toEqual([
      {
        url: 'https://blog.example.test/posts/atom.xml',
        kind: 'atom',
        title: null,
        supported: true,
      },
    ]);
  });

  it('reports JSON Feed links as unsupported', async () => {
    const html = `<link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="alternate" type="application/rss+xml" href="/rss">`;
    const found = await discoverFeeds(html, PAGE);
    expect(found).toEqual([
      { url: 'https://blog.example.test/feed.json', kind: 'json', title: null, supported: false },
      { url: 'https://blog.example.test/rss', kind: 'rss', title: null, supported: true },
    ]);
  });

  it('ignores javascript:/data: hrefs, missing hrefs and rel without alternate', async () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="data:text/xml,x">
      <link rel="alternate" type="application/rss+xml">
      <link rel="icon" type="application/rss+xml" href="/x">`;
    expect(await discoverFeeds(html, PAGE)).toEqual([]);
  });

  it('accepts a Response and tolerates broken markup', async () => {
    const res = new Response(
      '<<html><head><link rel=alternate type=application/rss+xml href=/f<body>',
    );
    const found = await discoverFeeds(res, PAGE);
    expect(Array.isArray(found)).toBe(true);
  });

  it('returns at most 20 feeds', async () => {
    let html = '';
    for (let i = 0; i < 40; i++) {
      html += `<link rel="alternate" type="application/rss+xml" href="/f${i}">`;
    }
    expect(await discoverFeeds(html, PAGE)).toHaveLength(20);
  });
});
