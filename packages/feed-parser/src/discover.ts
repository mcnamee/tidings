import { canonicalizeHttpUrl } from '@tidings/shared/url';

export interface DiscoveredFeed {
  /** Absolute, canonical http(s) URL. */
  url: string;
  kind: 'rss' | 'atom' | 'json';
  title: string | null;
  /** False for JSON Feed: reported so the UI can say so, but not subscribable in MVP. */
  supported: boolean;
}

/** The slice of the Workers `HTMLRewriter` API this module uses (injectable for tests). */
export interface HtmlRewriterLike {
  on(
    selector: string,
    handlers: { element(el: { getAttribute(name: string): string | null }): void },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
}
export type HtmlRewriterCtor = new () => HtmlRewriterLike;

const MAX_DISCOVERED = 20;

function kindFor(type: string): DiscoveredFeed['kind'] | null {
  const t = type.toLowerCase().split(';')[0]?.trim() ?? '';
  if (t === 'application/rss+xml') return 'rss';
  if (t === 'application/atom+xml') return 'atom';
  if (t === 'application/feed+json' || t === 'application/json') return 'json';
  return null;
}

/**
 * Feed autodiscovery (spec FR-SU): finds `<link rel="alternate" type="application/rss+xml|
 * atom+xml|feed+json" href=...>` in a page using `HTMLRewriter` (the one place ADR 0006 uses
 * it). Relative hrefs are resolved against `pageUrl`. JSON Feed links come back with
 * `supported: false`. Never throws on bad markup; returns at most 20 results in document order.
 *
 * `Rewriter` defaults to the runtime's global `HTMLRewriter`; pass one in under Node.
 */
export async function discoverFeeds(
  html: string | Response,
  pageUrl: string,
  Rewriter: HtmlRewriterCtor | undefined = (globalThis as { HTMLRewriter?: HtmlRewriterCtor })
    .HTMLRewriter,
): Promise<DiscoveredFeed[]> {
  if (!Rewriter) throw new Error('HTMLRewriter is not available in this runtime');
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();

  const rewriter = new Rewriter().on('link', {
    element(el) {
      if (found.length >= MAX_DISCOVERED) return;
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      if (!rel.includes('alternate')) return;
      const kind = kindFor(el.getAttribute('type') ?? '');
      const href = el.getAttribute('href');
      if (kind === null || !href) return;
      let abs: string;
      try {
        abs = new URL(href.trim(), pageUrl).href;
      } catch {
        return;
      }
      const canon = canonicalizeHttpUrl(abs);
      if (!canon.ok || seen.has(canon.url)) return;
      seen.add(canon.url);
      const title = el.getAttribute('title')?.trim();
      found.push({ url: canon.url, kind, title: title ? title : null, supported: kind !== 'json' });
    },
  });

  const response = typeof html === 'string' ? new Response(html) : html;
  // Draining the transformed body is what runs the element handlers.
  await rewriter.transform(response).arrayBuffer();
  return found;
}
