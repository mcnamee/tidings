export type FeedFormat = 'rss' | 'atom' | 'rdf';

/** One normalised article. Timestamps are Unix epoch seconds (the DB unit, spec §6). */
export interface ParsedItem {
  /** Dedup key (spec §6.3), before hashing. Feed it to `guidHash(feedId, guidKey)`. */
  guidKey: string;
  /** The raw guid/id/rdf:about if the item had one (trimmed, verbatim). */
  guid: string | null;
  title: string;
  /** Canonical http(s) link or null. */
  link: string | null;
  author: string | null;
  /** Parsed publication time, or the fetch time if missing, unparseable or in the future. */
  publishedAt: number;
  /** Raw HTML as published, capped at 100 KB. Sanitised in the browser (ADR 0006). */
  contentHtml: string | null;
  /** Plain text, at most 300 characters. */
  summary: string | null;
  /** http(s) image URL or null. */
  imageUrl: string | null;
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string | null;
  /** Site (HTML) URL, canonical http(s) or null. */
  siteUrl: string | null;
  items: ParsedItem[];
  /** True when parsing stopped early at `maxItems`; later items were never read. */
  stoppedEarly: boolean;
}

export type ParseErrorCode = 'not_a_feed' | 'empty' | 'parse_error';

export type ParseResult =
  { ok: true; feed: ParsedFeed } | { ok: false; error: { code: ParseErrorCode; message: string } };

export interface ParseOptions {
  /** Fetch time, epoch seconds. Used for missing and future dates. Required: inject the clock. */
  fetchedAt: number;
  /** Absolute URL of the feed, used to resolve relative links. */
  baseUrl?: string;
  /** Defaults to `MAX_ITEMS_PER_FETCH`. */
  maxItems?: number;
}
