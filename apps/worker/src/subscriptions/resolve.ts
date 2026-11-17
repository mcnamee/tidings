/**
 * Turns the URL a person typed into the feed to subscribe to (FR-SU-1): a feed URL is used as it
 * is, a web page is searched for `<link rel="alternate">` feeds.
 *
 * `safeFetch` hands back raw status, headers and body. They are read here and dropped: the result
 * carries only the feed URL, or candidates made of the URL and title parsed from `<link>` tags
 * (spec §10.6 rule 8). The body is only sniffed, never parsed as a feed; parsing is the
 * refresher's job, in its own invocation (spec §7.5).
 */
import type { FeedCandidate } from '@tidings/shared';
import { discoverFeeds, type DiscoveredFeed } from '@tidings/feed-parser';
import { canonicalizeUrl } from '../db';
import { checkUrl, safeFetch, type FetchFn } from '../fetch';

export interface ResolveDeps {
  fetch: FetchFn;
  appOrigin: string;
  allowHosts: readonly string[];
  /** Injected so tests can run discovery without `HTMLRewriter`. Defaults to the real one. */
  discover?: (html: Response, pageUrl: string) => Promise<DiscoveredFeed[]>;
}

export type Resolution =
  /** Subscribe to this feed URL (canonical). */
  | { kind: 'feed'; url: string }
  /** Several feeds on the page: the person picks one. */
  | { kind: 'choice'; candidates: FeedCandidate[] }
  /** A page with no usable feed. */
  | { kind: 'none' }
  /** A redirect led somewhere `safeFetch` refuses. */
  | { kind: 'blocked' };

const SNIFF_BYTES = 4096;
const CANDIDATE_TITLE_MAX = 120;

type Looks = 'feed' | 'html' | 'other';

/** Cheap look at the start of a body; the real parse happens in the refresher. */
export function sniff(body: Uint8Array, contentType: string | null): Looks {
  const head = new TextDecoder().decode(body.subarray(0, SNIFF_BYTES)).toLowerCase();
  const type = (contentType ?? '').toLowerCase();
  if (/<(rss|feed|rdf:rdf)[\s>]/.test(head)) return 'feed';
  if (type.includes('html') || /<!doctype\s+html|<html[\s>]/.test(head)) return 'html';
  // XML we cannot place: let the refresher try it and record `parse_error` if it is not a feed.
  if (type.includes('xml')) return 'feed';
  return 'other';
}

export async function resolveFeedUrl(url: string, deps: ResolveDeps): Promise<Resolution> {
  const res = await safeFetch(url, {
    fetch: deps.fetch,
    appOrigin: deps.appOrigin,
    allowHosts: deps.allowHosts,
  });

  if (res.kind === 'error') {
    if (res.code === 'blocked_address') return { kind: 'blocked' };
    // Timeouts, network errors and the like: the person may well have typed a feed URL. Subscribe
    // and let the refresher retry and report the fixed error (AC5).
    return { kind: 'feed', url };
  }
  // An error status, or a 304 nobody asked for: same reasoning, the refresher reports it.
  if (res.kind !== 'ok') return { kind: 'feed', url };

  const looks = sniff(res.body, res.headers.get('Content-Type'));
  if (looks === 'feed') return { kind: 'feed', url };
  if (looks === 'other') return { kind: 'none' };

  const discover = deps.discover ?? ((html, pageUrl) => discoverFeeds(html, pageUrl));
  const page = new Response(res.body, {
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'text/html' },
  });
  const found = await discover(page, res.url);
  // DEF-030: a URL from the page is as untrusted as the typed one. Canonicalise it and run the
  // address rules; a candidate that fails either is dropped, and never offered or subscribed to.
  const usable: DiscoveredFeed[] = [];
  let blocked = false;
  for (const f of found) {
    const url = safeCandidateUrl(f.url, deps);
    if (url === null) blocked = true;
    else usable.push({ ...f, url });
  }
  const supported = usable.filter((f) => f.supported);
  if (supported.length === 0) return blocked ? { kind: 'blocked' } : { kind: 'none' };
  const only = supported[0];
  if (usable.length === 1 && only) return { kind: 'feed', url: only.url };
  return {
    kind: 'choice',
    candidates: usable.map((f) => ({
      url: f.url,
      title: f.title === null ? null : f.title.slice(0, CANDIDATE_TITLE_MAX),
      type: f.kind,
      supported: f.supported,
    })),
  };
}

/** The canonical URL when it is allowed to be fetched, else null. */
function safeCandidateUrl(url: string, deps: ResolveDeps): string | null {
  try {
    const canonical = canonicalizeUrl(url);
    return checkUrl(canonical, deps.appOrigin, deps.allowHosts).ok ? canonical : null;
  } catch {
    return null;
  }
}
