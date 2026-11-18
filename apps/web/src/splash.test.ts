import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSplash, SPLASH_FADE_MS, SPLASH_MIN_MS } from './splash';

describe('launch screen timing (TID-059)', () => {
  let el: HTMLElement;
  let t0: number;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    document.body.append(el);
    t0 = Date.now();
  });
  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });
  const make = (over: { reducedMotion?: boolean; skipMin?: boolean; start?: number } = {}) =>
    createSplash({
      el,
      now: () => (over.start ?? 0) + (Date.now() - t0),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      reducedMotion: over.reducedMotion ?? false,
      skipMin: over.skipMin ?? false,
    });

  it('stays for 2 s even when the app is ready at once, then fades and is removed', () => {
    const s = make();
    s.appReady();
    vi.advanceTimersByTime(SPLASH_MIN_MS - 1);
    expect(el.isConnected).toBe(true);
    expect(el.classList.contains('splash-out')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('splash-out')).toBe(true);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(el.isConnected).toBe(false);
  });

  it('waits for the app after 2 s have passed', () => {
    const s = make();
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);
    s.appReady();
    expect(el.classList.contains('splash-out')).toBe(true);
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(el.isConnected).toBe(false);
  });

  it('counts from navigation start, not from when the script ran', () => {
    const s = make({ start: 1500 });
    s.appReady();
    vi.advanceTimersByTime(499);
    expect(el.classList.contains('splash-out')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('splash-out')).toBe(true);
  });

  it('with reduced motion it is removed without a fade', () => {
    const s = make({ reducedMotion: true });
    s.appReady();
    vi.advanceTimersByTime(SPLASH_MIN_MS);
    expect(el.isConnected).toBe(false);
  });

  it('skips the minimum under automation: removed as soon as the app is ready', () => {
    const s = make({ skipMin: true, reducedMotion: true });
    expect(el.isConnected).toBe(true);
    s.appReady();
    expect(el.isConnected).toBe(false);
  });

  it('is safe to signal ready twice', () => {
    const s = make({ skipMin: true });
    s.appReady();
    s.appReady();
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(el.isConnected).toBe(false);
  });
});
