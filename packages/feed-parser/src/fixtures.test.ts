import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFeed } from './parse';
import { itemGuidHash } from './key';
import { EXPECTED_DIR as EXPECTED, FETCHED_AT, readFixture } from './test-helpers';

const BASE_URLS: Record<string, string> = {
  'atom-basic.xml': 'https://atom.example.test/feed.xml',
};

// Regenerate with `UPDATE_EXPECTED=1 npm test -w @tidings/feed-parser`, then review the diff.
const UPDATE = process.env['UPDATE_EXPECTED'] === '1';

const PARSEABLE = [
  'rss2-basic.xml',
  'atom-basic.xml',
  'rdf-basic.xml',
  'rss2-cdata-entities.xml',
  'duplicate-guids.xml',
  'no-dates.xml',
  'hostile-html.xml',
  'malformed-bad-markup.xml',
  'malformed-truncated.xml',
  'billion-laughs.xml',
];

describe('fixture corpus matches the expected JSON (AC1)', () => {
  it.each(PARSEABLE)('%s', (name) => {
    const result = parseFeed(readFixture(name), {
      fetchedAt: FETCHED_AT,
      baseUrl: BASE_URLS[name],
    });
    expect(result.ok).toBe(true);
    const actual = JSON.parse(JSON.stringify(result)) as unknown;
    const file = path.join(EXPECTED, name.replace(/\.xml$/, '.json'));
    if (UPDATE) {
      mkdirSync(EXPECTED, { recursive: true });
      writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  it('rejects an HTML page as not_a_feed', () => {
    const result = parseFeed(readFixture('not-a-feed.html'), { fetchedAt: FETCHED_AT });
    expect(result).toEqual({
      ok: false,
      error: { code: 'not_a_feed', message: expect.any(String) as string },
    });
  });
});

describe('guid_hash (AC2)', () => {
  it('is stable across parses and distinguishes feeds', async () => {
    const parse = () => {
      const r = parseFeed(readFixture('duplicate-guids.xml'), { fetchedAt: FETCHED_AT });
      if (!r.ok) throw new Error('parse failed');
      return r.feed.items;
    };
    const a = await Promise.all(parse().map((i) => itemGuidHash(1, i)));
    const b = await Promise.all(parse().map((i) => itemGuidHash(1, i)));
    const other = await Promise.all(parse().map((i) => itemGuidHash(2, i)));
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(other[0]);
    for (const h of a) expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('falls back guid, then canonical link, then title+date+enclosure', () => {
    const r = parseFeed(readFixture('duplicate-guids.xml'), { fetchedAt: FETCHED_AT });
    if (!r.ok) throw new Error('parse failed');
    const keys = r.feed.items.map((i) => i.guidKey);
    expect(keys).toEqual([
      'dup-1',
      'dup-1',
      'dup-2a',
      'dup-2b',
      'https://dupes.example.test/noguid',
      'No GUID, no link\n2026-11-10T04:00:00.000Z\n',
      'https://dupes.example.test/emptyguid',
    ]);
  });

  it('uses the enclosure URL in the last-resort key', () => {
    const xml = `<rss><channel><item><title>T</title><pubDate>Tue, 10 Nov 2026 09:00:00 GMT</pubDate>
      <enclosure url="https://e.example.test/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
    const r = parseFeed(xml, { fetchedAt: FETCHED_AT });
    if (!r.ok) throw new Error('parse failed');
    expect(r.feed.items[0]?.guidKey).toBe(
      'T\n2026-11-10T09:00:00.000Z\nhttps://e.example.test/a.mp3',
    );
  });

  it('skips items with no identity at all', () => {
    const xml = '<rss><channel><item><description>x</description></item></channel></rss>';
    const r = parseFeed(xml, { fetchedAt: FETCHED_AT });
    if (!r.ok) throw new Error('parse failed');
    expect(r.feed.items).toEqual([]);
  });
});
