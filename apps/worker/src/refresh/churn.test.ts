import { describe, expect, it } from 'vitest';
import {
  MAX_NEW_ENTRIES_PER_FEED_PER_DAY,
  parseRecentKeys,
  planDailyCap,
  secondaryKey,
  uniqueKeys,
  utcDay,
} from './churn';

describe('secondaryKey', () => {
  it('is stable, short, and depends on link and title', async () => {
    const a = await secondaryKey({ link: 'https://x.test/a', title: 'T', publishedAt: 1 });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await secondaryKey({ link: 'https://x.test/a', title: 'T', publishedAt: 99 })).toBe(a);
    expect(await secondaryKey({ link: 'https://x.test/a', title: 'U', publishedAt: 1 })).not.toBe(
      a,
    );
  });
  it('without a link uses title and date; with neither it has no key', async () => {
    const k = await secondaryKey({ link: null, title: 'T', publishedAt: 5 });
    expect(k).not.toBeNull();
    expect(await secondaryKey({ link: null, title: 'T', publishedAt: 6 })).not.toBe(k);
    expect(await secondaryKey({ link: null, title: '', publishedAt: 5 })).toBeNull();
  });
});

describe('uniqueKeys', () => {
  it('nulls every key that appears more than once', () => {
    expect(uniqueKeys(['a', 'b', 'a', null, 'c'])).toEqual([null, 'b', null, null, 'c']);
  });
});

describe('parseRecentKeys', () => {
  it('tolerates null, junk and non-strings', () => {
    expect(parseRecentKeys(null).size).toBe(0);
    expect(parseRecentKeys('{').size).toBe(0);
    expect(parseRecentKeys('{"a":1}').size).toBe(0);
    expect([...parseRecentKeys('["a",1,"b"]')]).toEqual(['a', 'b']);
  });
});

describe('planDailyCap', () => {
  const base = { nowSeconds: 86_400 * 100 + 5, newEntriesDay: 100, warningCode: null };
  it('allows the rest of today, and everything on a new day', () => {
    expect(planDailyCap({ ...base, newEntriesCount: 150 }).allowed).toBe(50);
    expect(planDailyCap({ ...base, newEntriesDay: 99, newEntriesCount: 200 }).allowed).toBe(
      MAX_NEW_ENTRIES_PER_FEED_PER_DAY,
    );
    expect(planDailyCap({ ...base, newEntriesCount: 250 }).allowed).toBe(0);
  });
  it('sets, keeps and clears the warning', () => {
    const same = planDailyCap({ ...base, newEntriesCount: 10, warningCode: 'new_item_cap' });
    expect(same.warningAfter(0)).toBe('new_item_cap');
    expect(same.warningAfter(3)).toBe('new_item_cap');
    const next = planDailyCap({
      ...base,
      newEntriesDay: 99,
      newEntriesCount: 200,
      warningCode: 'new_item_cap',
    });
    expect(next.warningAfter(0)).toBeNull();
    expect(next.countAfter(7)).toBe(7);
    expect(next.day).toBe(utcDay(base.nowSeconds));
  });
});
