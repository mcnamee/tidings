/**
 * Throwaway fixture origin for the AC13 benchmark (deployed as `tidings-bench-origin`, deleted
 * afterwards). Serves the deterministic feeds from `e2e/fixtures/generate-feeds.ts` over HTTPS:
 *
 *   /feed/<name>.xml?new=N   N brand-new items per request, the rest keep their guids; no validators
 *   /static/<name>.xml       identical bytes every time (hash match, or over the cap)
 *   /pad/<bytes>.xml         a valid feed of exactly <bytes> bytes, identical every time
 *
 * It sends no ETag or Last-Modified, so every refresh is a full 200.
 */
import {
  GENERATED_FEEDS,
  generateFeed,
  type GeneratedFeedName,
} from '../../../e2e/fixtures/generate-feeds';

const cache = new Map<string, string>();

function base(name: GeneratedFeedName): string {
  let xml = cache.get(name);
  if (xml === undefined) {
    xml = generateFeed(GENERATED_FEEDS[name]);
    cache.set(name, xml);
  }
  return xml;
}

/**
 * Gives the newest `count` items fresh identities: a new guid / id / rdf:about, and a new title
 * and link too, because the churn guard (TID-046) treats a new guid with an old link and title as
 * a known item. The document keeps about the same size.
 */
export function freshen(name: GeneratedFeedName, nonce: string, count: number): string {
  let xml = base(name);
  const format = GENERATED_FEEDS[name].format;
  const n = Math.min(count, GENERATED_FEEDS[name].items);
  const post = 'https://gen.example.test/posts/';
  for (let k = 0; k < n; k++) {
    const swaps: [string, string][] =
      format === 'rss'
        ? [
            [`gen-rss-${k}</guid>`, `gen-rss-${nonce}-${k}</guid>`],
            [`<title>Generated item ${k}</title>`, `<title>Generated item ${nonce}-${k}</title>`],
            [`<link>${post}${k}</link>`, `<link>${post}${nonce}-${k}</link>`],
          ]
        : format === 'atom'
          ? [
              [`2026:atom-${k}</id>`, `2026:atom-${nonce}-${k}</id>`],
              [
                `<title>Generated entry ${k}</title>`,
                `<title>Generated entry ${nonce}-${k}</title>`,
              ],
              [`<link href="${post}${k}"/>`, `<link href="${post}${nonce}-${k}"/>`],
            ]
          : [
              [`rdf:about="${post}${k}"`, `rdf:about="${post}${nonce}-${k}"`],
              [
                `<title>Generated rdf item ${k}</title>`,
                `<title>Generated rdf item ${nonce}-${k}</title>`,
              ],
              [`<link>${post}${k}</link>`, `<link>${post}${nonce}-${k}</link>`],
            ];
    for (const [from, to] of swaps) xml = xml.replace(from, to);
  }
  return xml;
}

/** A valid RSS document of exactly `bytes` bytes (ASCII), with one padded item. */
export function paddedFeed(bytes: number): string {
  const head =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Padded</title><link>https://pad.example.test/</link><description>x</description>';
  const item =
    '<item><title>Padding</title><link>https://pad.example.test/p</link><guid>pad-1</guid><description>';
  const tail = '</description></item></channel></rss>';
  const fill = Math.max(bytes - head.length - item.length - tail.length, 0);
  return head + item + 'A'.repeat(fill) + tail;
}

const XML = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'no-store',
};

function isName(s: string): s is GeneratedFeedName {
  return Object.hasOwn(GENERATED_FEEDS, s);
}

export function handle(request: Request): Response {
  const url = new URL(request.url);
  const [, kind, file] = url.pathname.split('/');
  const stem = (file ?? '').replace(/\.xml$/, '');

  if (kind === 'feed' && isName(stem)) {
    const count = Math.max(0, Math.min(Number(url.searchParams.get('new') ?? 3) || 0, 50));
    const nonce = crypto.randomUUID().slice(0, 8);
    return new Response(freshen(stem, nonce, count), { headers: XML });
  }
  if (kind === 'static' && isName(stem)) return new Response(base(stem), { headers: XML });
  if (kind === 'pad' && /^\d{3,8}$/.test(stem)) {
    const bytes = Number(stem);
    if (bytes > 8_000_000) return new Response('too big', { status: 400 });
    return new Response(paddedFeed(bytes), { headers: XML });
  }
  return new Response('not found', { status: 404 });
}

export default { fetch: handle } satisfies ExportedHandler;
