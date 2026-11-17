import { describe, expect, it } from 'vitest';
import { parseRetryAfter, planFailure } from './backoff';

const base = { fetchIntervalS: 1800, now: 1_000_000, retryAfterS: null, random: () => 0.5 };

describe('planFailure (spec 7.4)', () => {
  it('doubles the interval per failure, capped at 24 hours', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 10].map(
      (errorCount) => planFailure({ ...base, errorCount }).nextFetchAt - base.now,
    );
    expect(delays).toEqual([3600, 7200, 14_400, 28_800, 57_600, 86_400, 86_400, 86_400]);
  });

  it('applies jitter of exactly -10% to +10%', () => {
    const lo = planFailure({ ...base, errorCount: 2, random: () => 0 }).nextFetchAt - base.now;
    const hi =
      planFailure({ ...base, errorCount: 2, random: () => 0.999999 }).nextFetchAt - base.now;
    expect(lo).toBe(Math.round(14_400 * 0.9));
    expect(hi).toBeLessThanOrEqual(Math.round(14_400 * 1.1));
    expect(hi).toBeGreaterThan(14_400 * 1.09);
  });

  it('uses Retry-After clamped to [1800, 86400], with no jitter', () => {
    const at = (retryAfterS: number) =>
      planFailure({ ...base, errorCount: 0, retryAfterS }).nextFetchAt - base.now;
    expect(at(7200)).toBe(7200);
    expect(at(10)).toBe(1800);
    expect(at(10_000_000)).toBe(86_400);
  });

  it('turns dead on the 20th consecutive failure and then retries daily', () => {
    expect(planFailure({ ...base, errorCount: 18 }).state).toBe('failing');
    const dead = planFailure({ ...base, errorCount: 19 });
    expect(dead).toMatchObject({ state: 'dead', errorCount: 20, nextFetchAt: base.now + 86_400 });
    expect(planFailure({ ...base, errorCount: 40, retryAfterS: 1800 }).nextFetchAt).toBe(
      base.now + 86_400,
    );
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates, and rejects junk', () => {
    expect(parseRetryAfter('120', 0)).toBe(120);
    expect(parseRetryAfter(' 7200 ', 0)).toBe(7200);
    expect(
      parseRetryAfter('Tue, 10 Nov 2026 13:00:00 GMT', Date.UTC(2026, 10, 10, 12) / 1000),
    ).toBe(3600);
    expect(
      parseRetryAfter('Tue, 10 Nov 2026 11:00:00 GMT', Date.UTC(2026, 10, 10, 12) / 1000),
    ).toBe(0);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter('-5', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
