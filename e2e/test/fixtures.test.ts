import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_FEEDS,
  generatedFeed,
  type GeneratedFeedName,
} from '../fixtures/generate-feeds.ts';
import { generateOpml } from '../fixtures/opml/generate-opml.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('feed fixture corpus (spec 13)', () => {
  const files = readdirSync(path.join(root, 'feeds'));

  it.each([
    'rss2-basic.xml',
    'rss2-cdata-entities.xml',
    'rdf-basic.xml',
    'atom-basic.xml',
    'malformed-truncated.xml',
    'malformed-bad-markup.xml',
    'no-dates.xml',
    'duplicate-guids.xml',
    'hostile-html.xml',
    'billion-laughs.xml',
    'not-a-feed.html',
  ])('has %s', (name) => {
    expect(files).toContain(name);
    expect(read(`feeds/${name}`).length).toBeGreaterThan(100);
  });

  it('covers each format marker', () => {
    expect(read('feeds/rss2-basic.xml')).toContain('<rss version="2.0"');
    expect(read('feeds/rdf-basic.xml')).toContain('<rdf:RDF');
    expect(read('feeds/atom-basic.xml')).toContain('http://www.w3.org/2005/Atom');
    expect(read('feeds/rss2-cdata-entities.xml')).toContain('<![CDATA[');
    expect(read('feeds/rss2-cdata-entities.xml')).toContain('content:encoded');
    expect(read('feeds/rss2-cdata-entities.xml')).toContain('media:thumbnail');
  });

  it('the truncated fixture really is truncated (no closing channel tag)', () => {
    expect(read('feeds/malformed-truncated.xml')).not.toContain('</channel>');
  });

  it('billion-laughs fixture declares nested entities and an external entity', () => {
    const x = read('feeds/billion-laughs.xml');
    expect(x).toContain('<!ENTITY lol9');
    expect(x).toContain('SYSTEM "file:///etc/passwd"');
  });
});

describe('generated feeds', () => {
  const approx: Record<GeneratedFeedName, [number, number]> = {
    'rss-small': [10_000, 40_000],
    'rss-typical': [100_000, 220_000],
    'atom-typical': [70_000, 160_000],
    'rdf-typical': [20_000, 50_000],
    'rss-large': [800_000, 1_400_000],
    'rss-huge': [2_500_000, 3_800_000],
  };

  it.each(Object.keys(GENERATED_FEEDS) as GeneratedFeedName[])(
    '%s is deterministic and about the right size',
    (name) => {
      const a = generatedFeed(name);
      expect(generatedFeed(name)).toBe(a);
      const [min, max] = approx[name];
      expect(a.length).toBeGreaterThanOrEqual(min);
      expect(a.length).toBeLessThanOrEqual(max);
      expect(a.split('<item').length - 1 + a.split('<entry').length - 1).toBe(
        GENERATED_FEEDS[name].items,
      );
    },
  );

  it('huge feed has 500 items', () => {
    expect(GENERATED_FEEDS['rss-huge'].items).toBe(500);
  });
});

describe('Inoreader OPML fixture', () => {
  const opml = read('opml/inoreader-export.opml');

  it('is in sync with its generator (run: node e2e/fixtures/opml/generate-opml.ts)', () => {
    expect(opml).toBe(generateOpml());
  });

  const feedUrls = [...opml.matchAll(/xmlUrl="([^"]*)"/g)].map((m) => m[1] as string);
  const valid = feedUrls.filter((u) => u.startsWith('https://'));

  it('has about 250 feeds', () => {
    expect(new Set(valid).size).toBeGreaterThanOrEqual(240);
    expect(new Set(valid).size).toBeLessThanOrEqual(260);
  });

  it('has 18 top-level folders', () => {
    const body = opml.split('<body>')[1] as string;
    const topLevel = body.match(/^ {4}<outline text="[^"]*" title="[^"]*">$/gm) ?? [];
    expect(topLevel).toHaveLength(18);
  });

  it('has one nested folder', () => {
    expect(opml.match(/^ {6}<outline text="[^"]*" title="[^"]*">$/gm)).toHaveLength(1);
  });

  it('has one feed that appears in two folders', () => {
    const counts = new Map<string, number>();
    for (const u of valid) counts.set(u, (counts.get(u) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1);
    expect(dupes).toEqual([['https://shared.example.test/feed.xml', 2]]);
  });

  it('includes entries that should be counted invalid', () => {
    expect(opml).toContain('xmlUrl="javascript:alert(1)"');
    expect(opml).toContain('xmlUrl="http://127.0.0.1/feed.xml"');
    expect(opml).toContain('text="Missing URL"');
  });

  it('is well-formed enough: balanced outline tags', () => {
    const opens = opml.match(/<outline [^>]*[^/]>/g)?.length ?? 0;
    const closes = opml.match(/<\/outline>/g)?.length ?? 0;
    expect(opens).toBe(closes);
  });
});

describe('XSS payload set', () => {
  const data = JSON.parse(read('xss/payloads.json')) as {
    payloads: Array<{ id: string; html: string; mustKeep: string }>;
    urlPayloads: string[];
  };

  it('has a broad set of uniquely named payloads', () => {
    expect(data.payloads.length).toBeGreaterThanOrEqual(35);
    const ids = data.payloads.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the classic vectors', () => {
    const all = data.payloads.map((p) => p.html).join('\n');
    for (const needle of [
      '<script',
      'onerror=',
      'javascript:',
      '<iframe',
      '<svg',
      'srcdoc',
      'data:text/html',
    ]) {
      expect(all.toLowerCase()).toContain(needle);
    }
  });
});
