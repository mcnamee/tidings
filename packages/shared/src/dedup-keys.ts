/**
 * Cross-feed duplicate keys (spec 6.3, ADR 0017, TID-061). Pure functions; the Worker hashes the
 * normalised text and stores 16 hex characters per key on `entries`.
 *
 * Two keys per entry:
 * - the URL key: the article URL without scheme, `www.`, tracking parameters, fragment or a
 *   trailing slash, with the remaining query sorted;
 * - the headline key: the title lower-cased with punctuation and quote styles folded.
 * Either is null when the entry has nothing safe to match on.
 */

/** Query parameters that identify the visit, not the article. `utm_*` is matched by prefix. */
const TRACKING_PARAMS = new Set([
  'at_medium',
  'at_campaign',
  'ocid',
  'cmpid',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'xtor',
  'ns_source',
  'ns_mchannel',
  'ns_campaign',
  'ns_linkname',
]);

/** Headlines with fewer words than this never get a key ("Update", "Live", "Sport"). */
export const MIN_HEADLINE_WORDS = 4;

const isTracking = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
};

/**
 * Text to hash for the URL key, or null for a missing or unusable link. A site's home page (empty
 * path, no query) is null: feeds that point every item at it would otherwise match each other.
 */
export function urlKeyText(link: string | null | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '') return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  if (path === '' && params.length === 0) return null;
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `${host}${url.port ? `:${url.port}` : ''}${path}${query.length ? `?${query.join('&')}` : ''}`;
}

/**
 * Text to hash for the headline key, or null when the headline has fewer than
 * {@link MIN_HEADLINE_WORDS} words after folding. Apostrophes of every style are removed
 * ("don't" and "don’t" match); other punctuation and symbols become spaces.
 */
export function headlineKeyText(title: string | null | undefined): string | null {
  if (!title) return null;
  const folded = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’‛ʼ′`´]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (folded === '') return null;
  return folded.split(' ').length >= MIN_HEADLINE_WORDS ? folded : null;
}

/** First 16 hex characters of SHA-256 (the width TID-046's churn keys use). */
export async function shortKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

export interface DedupKeys {
  urlKey: string | null;
  headlineKey: string | null;
}

export async function dedupKeys(item: {
  link: string | null;
  title: string | null;
}): Promise<DedupKeys> {
  const u = urlKeyText(item.link);
  const h = headlineKeyText(item.title);
  return {
    urlKey: u === null ? null : await shortKey(`u\n${u}`),
    headlineKey: h === null ? null : await shortKey(`h\n${h}`),
  };
}
