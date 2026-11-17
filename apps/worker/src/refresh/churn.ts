/**
 * GUID churn guard (spec §6.3, ADR 0013 decision 2). Pure planning; the caller does the I/O.
 *
 * 1. A secondary key (hash of link + title, or title + date without a link) is compared with the
 *    keys of the previous fetch (`feeds.recent_keys`). An item that is new by GUID but matches is
 *    treated as known.
 * 2. At most {@link MAX_NEW_ENTRIES_PER_FEED_PER_DAY} new entries per feed per UTC day.
 */
import type { ParsedItem } from '@tidings/feed-parser';

export const MAX_NEW_ENTRIES_PER_FEED_PER_DAY = 200;
export const NEW_ITEM_CAP_WARNING = 'new_item_cap';
/** At most one fetch's worth of keys are remembered (the parser's item cap). */
export const MAX_RECENT_KEYS = 50;
const KEY_CHARS = 16;
const SECONDS_PER_DAY = 86_400;

export const utcDay = (nowSeconds: number): number => Math.floor(nowSeconds / SECONDS_PER_DAY);

/** First 16 hex characters of SHA-256, or null when the item has nothing to key on. */
export async function secondaryKey(
  item: Pick<ParsedItem, 'link' | 'title' | 'publishedAt'>,
): Promise<string | null> {
  const text = item.link
    ? `${item.link}\n${item.title}`
    : item.title
      ? `${item.title}\n${new Date(item.publishedAt * 1000).toISOString()}`
      : null;
  if (text === null) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, KEY_CHARS);
}

/** Keys that appear on exactly one item; a key shared within one fetch is dropped (null). */
export function uniqueKeys(keys: (string | null)[]): (string | null)[] {
  const counts = new Map<string, number>();
  for (const k of keys) if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  return keys.map((k) => (k !== null && counts.get(k) === 1 ? k : null));
}

/** Parses `feeds.recent_keys`; anything unexpected is an empty list. */
export function parseRecentKeys(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export interface DailyCapInput {
  nowSeconds: number;
  newEntriesDay: number | null;
  newEntriesCount: number;
  warningCode: string | null;
}

export interface DailyCapPlan {
  /** How many of this fetch's candidates may be stored. */
  allowed: number;
  day: number;
  /** The counter after storing `min(candidates, allowed)`. */
  countAfter: (stored: number) => number;
  /** The warning after this fetch, given how many candidates were refused. */
  warningAfter: (refused: number) => string | null;
}

/** The warning is set when items are refused and cleared by the first changed fetch of a new UTC
 * day that stays under the cap. */
export function planDailyCap(i: DailyCapInput): DailyCapPlan {
  const day = utcDay(i.nowSeconds);
  const sameDay = i.newEntriesDay === day;
  const used = sameDay ? i.newEntriesCount : 0;
  return {
    allowed: Math.max(0, MAX_NEW_ENTRIES_PER_FEED_PER_DAY - used),
    day,
    countAfter: (stored) => used + stored,
    warningAfter: (refused) =>
      refused > 0 ? NEW_ITEM_CAP_WARNING : sameDay ? i.warningCode : null,
  };
}

/**
 * True when a stored cap warning is out of date: the counter is from an earlier UTC day, so a
 * refresh that stores nothing (304 or identical body) is under the cap and clears it (DEF-020).
 */
export function capWarningExpired(
  i: Pick<DailyCapInput, 'nowSeconds' | 'newEntriesDay' | 'warningCode'>,
): boolean {
  return i.warningCode !== null && i.newEntriesDay !== utcDay(i.nowSeconds);
}
