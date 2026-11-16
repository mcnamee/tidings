import { guidHash } from '@tidings/shared/dedup';
import type { ParsedItem } from './types';

export interface KeyInput {
  guid: string | null;
  /** Canonical link (spec §6.4) or null. */
  link: string | null;
  /** Title as published, before any fallback text. */
  title: string;
  /** ISO string of the published date as parsed from the feed, or null if none/unparseable. */
  publishedIso: string | null;
  enclosureUrl: string | null;
}

/**
 * Dedup key (spec §6.3): the first non-empty of guid (trimmed, verbatim), canonical link, then
 * `title \n date-ISO-or-empty \n enclosure-or-empty`. Returns null when all three are empty,
 * in which case the item has no identity and the parser skips it.
 */
export function itemKey(i: KeyInput): string | null {
  if (i.guid) return i.guid;
  if (i.link) return i.link;
  if (i.title === '' && !i.publishedIso && !i.enclosureUrl) return null;
  return `${i.title}\n${i.publishedIso ?? ''}\n${i.enclosureUrl ?? ''}`;
}

/** `guid_hash` for one parsed item in one feed. Deterministic: same item, same hash. */
export function itemGuidHash(feedId: number, item: Pick<ParsedItem, 'guidKey'>): Promise<string> {
  return guidHash(feedId, item.guidKey);
}
