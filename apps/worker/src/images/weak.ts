/**
 * The "weak image" check (TID-072, ADR 0020), shared by the refresh and the image step. Pure: URLs
 * and declared sizes in, a verdict out; no I/O.
 *
 * - `junk`: an icon, logo, avatar, sprite or site-wide default. Never stored.
 * - `small`: a real picture that is too small to stretch into a row or card (declared or hinted
 *   under {@link MIN_GOOD_SIDE}). Kept as a fallback when nothing better exists.
 * - `good`: no reason to doubt it.
 */

/** An image declared or hinted smaller than this on either side is too small to feature. */
export const MIN_GOOD_SIDE = 300;

export type ImageVerdict = 'good' | 'small' | 'junk';

export interface DeclaredSize {
  width: number | null;
  height: number | null;
}

/** File-name words that name an icon, logo or placeholder (whole word, or glued to `_`/`-`/digits). */
const JUNK_FILE =
  /(?:^|[^a-z])(?:icons?|logos?|favicons?|avatars?|gravatar|sprites?|placeholder|spacer|default[-_]?(?:image|og|share|thumb))(?![a-z])/i;
/** A directory of icons or topic artwork, such as Slashdot's `/sd/topics/china_64.png`. */
const JUNK_DIR = /\/(?:topics?|icons?|avatars?|emoji|sprites?)\//i;
/** Avatar and favicon hosts. */
const JUNK_HOST = /(?:^|\.)(?:gravatar\.com|favicon\.[a-z]+)$/i;

/** `/64x64/`, `-150x150.jpg`, `_64x64.png`: a size baked into the path. */
const DIR_SIZE = /\/(\d{2,4})x(\d{2,4})\//i;
const NAME_SIZE_2D = /[-_](\d{2,4})x(\d{2,4})\.[a-z]{3,4}$/i;
/** `_64.png`, `-100.jpg`: a two or three digit suffix (four digits are years or ids, not sizes). */
const NAME_SIZE_1D = /[-_](\d{2,3})\.[a-z]{3,4}$/i;
const QUERY_SIZE = /^(?:w|width|h|height)$/i;

/** The size hinted by the URL itself (the smaller side when two are given), or null. */
export function urlSizeHint(url: URL): number | null {
  const path = url.pathname;
  const two = DIR_SIZE.exec(path) ?? NAME_SIZE_2D.exec(path);
  if (two) return Math.min(Number(two[1]), Number(two[2]));
  const one = NAME_SIZE_1D.exec(path);
  if (one) return Number(one[1]);
  for (const [k, v] of url.searchParams) {
    if (QUERY_SIZE.test(k) && /^\d{1,4}$/.test(v)) return Number(v);
  }
  return null;
}

/** True when the URL names an icon, logo, avatar, sprite or similar (never a story picture). */
export function hasJunkHint(url: URL): boolean {
  if (JUNK_HOST.test(url.hostname)) return true;
  const path = url.pathname;
  if (JUNK_DIR.test(path)) return true;
  const file = path.split('/').pop() ?? '';
  if (/\.(?:ico|svg)$/i.test(file)) return true;
  return JUNK_FILE.test(file);
}

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * Verdict from the URL and the declared size alone. `siteDefault` is true when the same URL is
 * already used by two or more other entries of the feed (see {@link isSiteDefault}).
 */
export function judgeImage(
  url: string,
  size: Partial<DeclaredSize> = {},
  siteDefault = false,
): ImageVerdict {
  const u = parse(url);
  if (!u) return 'junk';
  if (siteDefault || hasJunkHint(u)) return 'junk';
  const w = size.width ?? null;
  const h = size.height ?? null;
  if ((w !== null && w < MIN_GOOD_SIDE) || (h !== null && h < MIN_GOOD_SIDE)) return 'small';
  const hint = urlSizeHint(u);
  if (hint !== null && hint < MIN_GOOD_SIDE) return 'small';
  return 'good';
}

/** A feed's picture used by two or more other entries is the site's default, not this story's. */
export const SITE_DEFAULT_MIN_OTHERS = 2;
export const isSiteDefault = (othersUsingIt: number): boolean =>
  othersUsingIt >= SITE_DEFAULT_MIN_OTHERS;

/** URL-only check used by the backfill and by the image step for an image already stored. */
export const looksWeakByUrl = (url: string): boolean => judgeImage(url) !== 'good';

/** Order for "only replace when better": good 2, small 1, junk or none 0. */
export const verdictRank = (v: ImageVerdict | null): number =>
  v === 'good' ? 2 : v === 'small' ? 1 : 0;

/**
 * Hosts known to serve the same images over https, so an `http:` feed image can be upgraded without
 * a probe (the browser would otherwise block it as mixed content). A host matches by suffix.
 */
const HTTPS_HOSTS = [
  'techmeme.com',
  'fsdn.com',
  'slashdot.org',
  'wp.com',
  'wordpress.com',
  'cloudfront.net',
  'imgur.com',
  'ytimg.com',
  'googleusercontent.com',
  'bbci.co.uk',
  'bbc.co.uk',
  'guim.co.uk',
  'theguardian.com',
  'nytimes.com',
  'washingtonpost.com',
  'staticflickr.com',
  'redd.it',
  'arstechnica.net',
  'wired.com',
  'medium.com',
  'substack.com',
  'substackcdn.com',
];

/** `http:` to `https:` for a known https-capable host (or the entry's own https site); else as is. */
export function upgradeToHttps(url: string, entryUrl: string | null = null): string {
  const u = parse(url);
  if (!u || u.protocol !== 'http:' || u.port !== '') return url;
  const host = u.hostname.toLowerCase();
  const known = HTTPS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const e = entryUrl ? parse(entryUrl) : null;
  const sameHttpsSite = e !== null && e.protocol === 'https:' && e.hostname.toLowerCase() === host;
  if (!known && !sameHttpsSite) return url;
  u.protocol = 'https:';
  return u.href;
}
