/**
 * Preview-image extraction from the start of an article page (TID-071, ADR 0019, spec 7.3b, 10.5).
 * Pure and bounded: the input is at most 128 KB, scanning stops at `</head>` or `<body`, and the
 * result is a canonical http(s) URL on a public host or null. Nothing here is trusted: every value
 * comes from a page we do not control.
 */
import { canonicalizeHttpUrl } from '@tidings/shared/url';
import { checkUrl } from '../fetch/address';

export const MAX_PAGE_BYTES = 128 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_TAGS = 2000;
/** An og:image declared smaller than this on either side is a logo or tracking pixel. */
export const MIN_IMAGE_SIDE = 100;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the entities that occur in attribute values; unknown ones are left as they are. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g,
    (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return NAMED[name.toLowerCase()] ?? m;
      const cp = dec ? Number(dec) : parseInt(hex as string, 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
      return String.fromCodePoint(cp);
    },
  );
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  end: number;
}

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Parses one tag starting at `<` (index `i`). Linear: every loop advances. Null if unterminated. */
function readTag(html: string, i: number): Tag | null {
  let j = i + 1;
  const n = html.length;
  const nameStart = j;
  while (j < n && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;
  const name = html.slice(nameStart, j).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (j < n && (isSpace(html[j]) || html[j] === '/')) j++;
    if (j >= n) return null;
    if (html[j] === '>') return { name, attrs, end: j + 1 };
    const keyStart = j;
    while (j < n && !isSpace(html[j]) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++;
    if (j === keyStart) j++; // a stray '=': skip it
    const key = html.slice(keyStart, j).toLowerCase();
    while (j < n && isSpace(html[j])) j++;
    let value = '';
    if (html[j] === '=') {
      j++;
      while (j < n && isSpace(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close === -1) return null;
        value = html.slice(j + 1, close);
        j = close + 1;
      } else {
        const vs = j;
        while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
        value = html.slice(vs, j);
      }
    }
    if (key !== '' && !attrs.has(key)) attrs.set(key, value);
  }
}

interface Candidate {
  rank: number;
  raw: string;
  width: number | null;
  height: number | null;
}

const META_RANK: Record<string, number> = {
  'og:image': 0,
  'og:image:url': 0,
  'og:image:secure_url': 1,
  'twitter:image': 2,
  'twitter:image:src': 2,
};
const LINK_RANK = 3;

const toInt = (v: string): number | null => (/^\s*\d{1,6}\s*$/.test(v) ? Number(v) : null);

/** Candidate URLs in the page head, in document order, with the declared og size where given. */
function candidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  let lastOg: Candidate | null = null;
  const lower = html.toLowerCase();
  let i = 0;
  let tags = 0;
  while (tags < MAX_TAGS && (i = html.indexOf('<', i)) !== -1) {
    if (lower.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const first = lower.charCodeAt(i + 1);
    const isLetter = first >= 97 && first <= 122;
    if (lower.startsWith('</head', i) || lower.startsWith('<body', i)) break;
    if (!isLetter) {
      i++;
      continue;
    }
    if (lower.startsWith('<script', i) || lower.startsWith('<style', i)) {
      const closer = lower.startsWith('<script', i) ? '</script' : '</style';
      const end = lower.indexOf(closer, i + 6);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) break; // unterminated tag: nothing reliable follows
    i = tag.end;
    tags++;
    if (tag.name === 'meta') {
      const key = (tag.attrs.get('property') ?? tag.attrs.get('name') ?? '').trim().toLowerCase();
      const content = tag.attrs.get('content');
      if (content === undefined) continue;
      const rank = META_RANK[key];
      if (rank !== undefined) {
        const c: Candidate = { rank, raw: content, width: null, height: null };
        out.push(c);
        if (key.startsWith('og:image')) lastOg = c;
      } else if (key === 'og:image:width' && lastOg) lastOg.width = toInt(content);
      else if (key === 'og:image:height' && lastOg) lastOg.height = toInt(content);
    } else if (tag.name === 'link') {
      const rels = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const href = tag.attrs.get('href');
      if (rels.includes('image_src') && href !== undefined) {
        out.push({ rank: LINK_RANK, raw: href, width: null, height: null });
      }
    }
  }
  return out;
}

const PLACEHOLDER_NAME =
  /^(?:logo|favicon|placeholder|blank|spacer|pixel|1x1|default[-_]?(?:image|og|share|thumb))/i;

/** A usable public http(s) image URL from an attribute value, or null. */
export function cleanImageUrl(
  raw: string,
  base: string,
  appOrigin: string,
  allowHosts: readonly string[] = [],
): string | null {
  const decoded = decodeEntities(raw).trim();
  // eslint-disable-next-line no-control-regex
  if (decoded === '' || decoded.length > MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(decoded)) {
    return null;
  }
  // Markup or whitespace inside the value means the tag was mangled (an unclosed quote ran on).
  if (/[<>\s"]/.test(decoded)) return null;
  let abs: URL;
  try {
    abs = new URL(decoded, base);
  } catch {
    return null;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  if (abs.username !== '' || abs.password !== '') return null;
  const canon = canonicalizeHttpUrl(abs.href);
  if (!canon.ok) return null;
  if (!checkUrl(canon.url, appOrigin, allowHosts).ok) return null;
  const last = new URL(canon.url).pathname.split('/').pop() ?? '';
  if (/\.ico$/i.test(last) || PLACEHOLDER_NAME.test(last)) return null;
  return canon.url;
}

export interface PreviewImage {
  url: string;
  /** The `og:image:width` / `og:image:height` the page declared, or null. */
  width: number | null;
  height: number | null;
}

/**
 * The preview image of a page: `og:image` (and `og:image:url`), then `og:image:secure_url`, then
 * `twitter:image`, then `<link rel="image_src">`, first in document order within a kind. `pageUrl` is
 * the final URL after redirects, the base for relative values. The declared size is returned so the
 * caller can judge it (TID-072).
 */
export function extractPreview(
  html: string,
  pageUrl: string,
  appOrigin: string,
  allowHosts: readonly string[] = [],
): PreviewImage | null {
  const found = candidates(html.length > MAX_PAGE_BYTES ? html.slice(0, MAX_PAGE_BYTES) : html);
  found.sort((a, b) => a.rank - b.rank); // stable: document order within a rank
  for (const c of found) {
    const tiny =
      (c.width !== null && c.width < MIN_IMAGE_SIDE) ||
      (c.height !== null && c.height < MIN_IMAGE_SIDE);
    if (tiny) continue;
    const url = cleanImageUrl(c.raw, pageUrl, appOrigin, allowHosts);
    if (url) return { url, width: c.width, height: c.height };
  }
  return null;
}

/** {@link extractPreview}, URL only. */
export function extractPreviewImage(
  html: string,
  pageUrl: string,
  appOrigin: string,
  allowHosts: readonly string[] = [],
): string | null {
  return extractPreview(html, pageUrl, appOrigin, allowHosts)?.url ?? null;
}

/** The registrable-ish domain of a host: last two labels, three under a short second level (co.uk). */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const sld = labels[labels.length - 2] as string;
  const tld = labels[labels.length - 1] as string;
  const take = tld.length === 2 && sld.length <= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

const SCAN_CHARS = 16 * 1024;
const MAX_ANCHORS = 60;

/** Sites that only ever offer share, login or follow links: never an article source. */
const SOCIAL_SITES = new Set([
  'twitter.com',
  'x.com',
  't.co',
  'facebook.com',
  'fb.com',
  'fb.me',
  'linkedin.com',
  'pinterest.com',
  'tumblr.com',
  'whatsapp.com',
  'wa.me',
  't.me',
  'telegram.me',
  'bsky.app',
  'threads.net',
  'instagram.com',
  'flipboard.com',
  'addtoany.com',
  'sharethis.com',
  'buffer.com',
  'getpocket.com',
  'feedburner.com',
  'feedproxy.google.com',
  'doubleclick.net',
  'googleadservices.com',
]);
const SHARE_PATH =
  /\/(?:share|sharer|sharearticle|intent|submit|submitlink|login|signin|add)(?:[/.?#]|$)/i;
const SHARE_QUERY = /[?&](?:share|shareurl|sharer)=|[?&]u=https?%3A|[?&]status=/i;

/**
 * True for share, social, login and tracking links, which are never the story's source. reddit.com
 * is a real source for some stories, so only its share, submit and login URLs count as noise.
 */
export function isNoiseLink(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (SOCIAL_SITES.has(siteOf(u.hostname))) return true;
  return SHARE_PATH.test(u.pathname) || SHARE_QUERY.test(u.search);
}

/**
 * The first usable outbound anchor in `html`: a canonical public http(s) URL on a site outside
 * `skipSites`, not a share/social/tracking link. With `preferImg`, an anchor that wraps an `<img>`
 * wins (Techmeme wraps its thumbnail in a link to the source story). At most 60 anchors.
 */
function scanAnchors(
  html: string,
  base: string,
  skipSites: ReadonlySet<string>,
  appOrigin: string,
  allowHosts: readonly string[],
  preferImg: boolean,
): string | null {
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let first: string | null = null;
  let m: RegExpExecArray | null;
  let n = 0;
  while (n < MAX_ANCHORS && (m = re.exec(html)) !== null) {
    n++;
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined) continue;
    const url = cleanLinkUrl(raw, base, appOrigin, allowHosts);
    if (!url || skipSites.has(siteOf(new URL(url).hostname)) || isNoiseLink(url)) continue;
    if (preferImg && /^\s*<img\b/i.test(html.slice(re.lastIndex, re.lastIndex + 200))) return url;
    first ??= url;
  }
  return first;
}

const siteSet = (urls: readonly string[]): Set<string> | null => {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      out.add(siteOf(new URL(u).hostname));
    } catch {
      return null;
    }
  }
  return out;
};

/**
 * The entry's primary outbound link (TID-072): the first `<a href>` in the feed's content or
 * description that points to a different site than the entry link, preferring one that wraps an
 * `<img>` (Techmeme wraps its thumbnail in a link to the source story). Share, social and tracking
 * links and the entry's own site (with its subdomains) are ignored. Bounded: it reads at most
 * 16 KB and 60 anchors. The result is a canonical public http(s) URL or null; the fetch re-checks it.
 */
export function primaryOutboundLink(
  contentHtml: string | null,
  entryUrl: string,
  appOrigin: string,
  allowHosts: readonly string[] = [],
): string | null {
  if (!contentHtml) return null;
  const skip = siteSet([entryUrl]);
  if (!skip) return null;
  const html = contentHtml.length > SCAN_CHARS ? contentHtml.slice(0, SCAN_CHARS) : contentHtml;
  return scanAnchors(html, entryUrl, skip, appOrigin, allowHosts, true);
}

/** Characters of the article page scanned for its source link, from the start of the story text. */
const PAGE_SCAN_CHARS = 48 * 1024;
/** Where the story text starts, most specific first. */
const BODY_START: readonly RegExp[] = [
  /<[a-z][a-z0-9]*\b[^>]*\bitemprop\s*=\s*["']?articleBody/i,
  /<article\b/i,
  /<[a-z][a-z0-9]*\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*\b(?:article[-_]body|entry[-_]content|post[-_]content|post[-_]body|story[-_]body|story[-_]text|body[-_]text|body)(?![-\w])/i,
  /<h1\b/i,
];
/** Page furniture after the story: links beyond here are navigation, not source. */
const BODY_END = /<(?:footer|aside|nav)\b|<\/article\b/i;

/**
 * The primary outbound link of an article page (TID-072b), for entries whose feed content links
 * nowhere useful (Slashdot: the description has only share links, the source sits in the story text).
 * Scans from the start of the story text (`itemprop=articleBody`, `<article>`, a common body class,
 * else the first `<h1>`) for the first external, non-social link, up to the end of the article or the
 * first footer/aside/nav, and at most 48 KB and 60 anchors: a linear scan of bytes already read.
 * `pageUrl` is the final URL after redirects; its site and `entryUrl`'s are both "internal".
 */
export function pageOutboundLink(
  html: string,
  pageUrl: string,
  entryUrl: string,
  appOrigin: string,
  allowHosts: readonly string[] = [],
): string | null {
  const skip = siteSet([entryUrl, pageUrl]);
  if (!skip) return null;
  const head = html.length > MAX_PAGE_BYTES ? html.slice(0, MAX_PAGE_BYTES) : html;
  for (const re of BODY_START) {
    const at = re.exec(head);
    if (!at) continue;
    let region = head.slice(at.index, at.index + PAGE_SCAN_CHARS);
    const end = BODY_END.exec(region.slice(1));
    if (end) region = region.slice(0, end.index + 1);
    const link = scanAnchors(region, pageUrl, skip, appOrigin, allowHosts, false);
    if (link) return link;
  }
  return null;
}

function cleanLinkUrl(
  raw: string,
  base: string,
  appOrigin: string,
  allowHosts: readonly string[],
): string | null {
  const decoded = decodeEntities(raw).trim();
  if (
    decoded === '' ||
    decoded.length > MAX_URL_CHARS ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\s"<>]/.test(decoded)
  ) {
    return null;
  }
  let abs: URL;
  try {
    abs = new URL(decoded, base);
  } catch {
    return null;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  if (abs.username !== '' || abs.password !== '') return null;
  const canon = canonicalizeHttpUrl(abs.href);
  if (!canon.ok || !checkUrl(canon.url, appOrigin, allowHosts).ok) return null;
  return canon.url;
}
