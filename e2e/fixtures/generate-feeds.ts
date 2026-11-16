// Deterministic generators for feeds too big to commit (TID-002 spike sizes, "huge feed" cases).
// Pure string functions: no Date.now(), no Math.random(). The same inputs always give the same bytes.

export interface GeneratedFeedSpec {
  format: 'rss' | 'atom' | 'rdf';
  items: number;
  /** Approximate size of each item's body in bytes (content:encoded / content). */
  bodyBytes: number;
}

/** Names the fixture server exposes under /feeds/generated/<name>.xml. */
export const GENERATED_FEEDS = {
  'rss-small': { format: 'rss', items: 20, bodyBytes: 600 }, // ~20 KB
  'rss-typical': { format: 'rss', items: 50, bodyBytes: 2800 }, // ~150 KB
  'atom-typical': { format: 'atom', items: 40, bodyBytes: 2300 }, // ~100 KB
  'rdf-typical': { format: 'rdf', items: 25, bodyBytes: 1000 }, // ~30 KB
  'rss-large': { format: 'rss', items: 200, bodyBytes: 5000 }, // ~1 MB
  'rss-huge': { format: 'rss', items: 500, bodyBytes: 6000 }, // ~3 MB
} as const satisfies Record<string, GeneratedFeedSpec>;

export type GeneratedFeedName = keyof typeof GENERATED_FEEDS;

const BASE_TIME = Date.UTC(2026, 10, 10, 12, 0, 0); // 2026-11-10T12:00:00Z

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco'
).split(' ');

function paragraphs(seed: number, bytes: number): string {
  let out = '';
  let i = seed;
  while (out.length < bytes) {
    let p = '';
    for (let w = 0; w < 40; w++) p += WORDS[(i += 7) % WORDS.length] + ' ';
    out += `<p>${p.trim()}. <a href="https://gen.example.test/ref/${i}">ref</a></p>\n`;
  }
  return out.slice(0, Math.max(bytes, 0));
}

// Slicing can cut a tag in half; end on a closed paragraph instead.
function body(seed: number, bytes: number): string {
  const raw = paragraphs(seed, bytes);
  const end = raw.lastIndexOf('</p>');
  return end === -1 ? '<p>x</p>' : raw.slice(0, end + 4);
}

function rfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

export function generateFeed(spec: GeneratedFeedSpec): string {
  const { format, items, bodyBytes } = spec;
  const itemTime = (n: number) => BASE_TIME - n * 3_600_000;
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];

  if (format === 'rss') {
    parts.push(
      '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n',
      '<title>Generated RSS</title><link>https://gen.example.test/</link><description>Generated fixture</description>\n',
    );
    for (let n = 0; n < items; n++) {
      parts.push(
        `<item><title>Generated item ${n}</title><link>https://gen.example.test/posts/${n}</link>`,
        `<guid isPermaLink="false">gen-rss-${n}</guid><pubDate>${rfc822(itemTime(n))}</pubDate>`,
        `<dc:creator>Generator</dc:creator><description>Summary of item ${n}.</description>`,
        `<content:encoded><![CDATA[${body(n, bodyBytes)}]]></content:encoded></item>\n`,
      );
    }
    parts.push('</channel>\n</rss>\n');
  } else if (format === 'atom') {
    parts.push(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Generated Atom</title><id>tag:gen.example.test,2026:atom</id>',
      `<updated>${new Date(BASE_TIME).toISOString()}</updated><link href="https://gen.example.test/"/>\n`,
    );
    for (let n = 0; n < items; n++) {
      const iso = new Date(itemTime(n)).toISOString();
      parts.push(
        `<entry><title>Generated entry ${n}</title><link href="https://gen.example.test/posts/${n}"/>`,
        `<id>tag:gen.example.test,2026:atom-${n}</id><published>${iso}</published><updated>${iso}</updated>`,
        `<summary>Summary of entry ${n}.</summary><content type="html"><![CDATA[${body(n, bodyBytes)}]]></content></entry>\n`,
      );
    }
    parts.push('</feed>\n');
  } else {
    parts.push(
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n',
      '<channel rdf:about="https://gen.example.test/"><title>Generated RDF</title><link>https://gen.example.test/</link><description>Generated fixture</description></channel>\n',
    );
    for (let n = 0; n < items; n++) {
      parts.push(
        `<item rdf:about="https://gen.example.test/posts/${n}"><title>Generated rdf item ${n}</title>`,
        `<link>https://gen.example.test/posts/${n}</link><description>Summary of item ${n}.</description>`,
        `<dc:date>${new Date(itemTime(n)).toISOString()}</dc:date>`,
        `<content:encoded><![CDATA[${body(n, bodyBytes)}]]></content:encoded></item>\n`,
      );
    }
    parts.push('</rdf:RDF>\n');
  }
  return parts.join('');
}

export function generatedFeed(name: GeneratedFeedName): string {
  return generateFeed(GENERATED_FEEDS[name]);
}
