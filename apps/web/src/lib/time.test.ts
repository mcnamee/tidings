import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTS_KEY, entriesKey, scheduleCountsRefetch, trimToFirstPage } from './queries';
import { relativeTime, relativeTimeLong } from './time';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it.each([
    [0, 'now'],
    [59_000, 'now'],
    [-5_000, 'now'],
    [MIN, '1m'],
    [59 * MIN, '59m'],
    [HOUR, '1h'],
    [23 * HOUR, '23h'],
    [DAY, '1d'],
    [6 * DAY, '6d'],
  ])('%i ms ago is %s', (age, text) => {
    expect(relativeTime(ago(age), NOW)).toBe(text);
  });

  it('shows a date after a week, with the year only for another year', () => {
    expect(relativeTime('2026-11-05T09:00:00', NOW)).toBe('5 Nov');
    expect(relativeTime('2025-03-02T09:00:00', NOW)).toBe('2 Mar 2025');
  });

  it('is empty for an unparseable date', () => {
    expect(relativeTime('nonsense', NOW)).toBe('');
    expect(relativeTimeLong('nonsense', NOW)).toBe('');
  });

  it('has a spoken form', () => {
    expect(relativeTimeLong(ago(MIN), NOW)).toBe('1 minute ago');
    expect(relativeTimeLong(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(relativeTimeLong(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(relativeTimeLong(ago(5_000), NOW)).toBe('just now');
  });
});

describe('scheduleCountsRefetch (FR-RD-10)', () => {
  afterEach(() => vi.useRealTimers());

  it('refetches the counts once, 2 s after the last read-state change', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    scheduleCountsRefetch(client);
    vi.advanceTimersByTime(1500);
    scheduleCountsRefetch(client); // another change restarts the wait
    vi.advanceTimersByTime(1500);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: COUNTS_KEY });
  });
});

describe('trimToFirstPage', () => {
  const page = (n: number) => ({ items: [], nextCursor: `c${n}`, asOf: 'x' });

  it('keeps page 1 only, so a refetch reads one page', () => {
    const client = new QueryClient();
    const key = entriesKey('all', null, 'unread');
    client.setQueryData(key, {
      pages: [page(1), page(2), page(3)],
      pageParams: [null, 'c1', 'c2'],
    });
    trimToFirstPage(client, key);
    expect(client.getQueryData(key)).toEqual({ pages: [page(1)], pageParams: [null] });
  });

  it('leaves a missing or single-page cache alone', () => {
    const client = new QueryClient();
    const key = entriesKey('feed', 's1', 'all');
    trimToFirstPage(client, key);
    expect(client.getQueryData(key)).toBeUndefined();
  });
});
