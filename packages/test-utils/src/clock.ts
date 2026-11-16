/**
 * Fixed clock for injection into code under test (spec §13: "Clocks are injected").
 * Application code takes `now: () => number` (epoch ms); tests pass `clock.now`.
 * Works in Node and in workerd (no timers, no Date.now()).
 */
export interface FixedClock {
  /** Epoch milliseconds. Pass this as the injected `now`. */
  now(): number;
  date(): Date;
  iso(): string;
  /** Move time forward (or backwards with a negative value). */
  advance(ms: number): void;
  set(ms: number | string | Date): void;
}

/** 2026-11-10T12:00:00Z: matches the dates in e2e/fixtures/feeds. */
export const FIXED_NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function createFixedClock(start: number | string | Date = FIXED_NOW): FixedClock {
  let t = new Date(start).getTime();
  if (Number.isNaN(t)) throw new Error(`createFixedClock: invalid start ${String(start)}`);
  return {
    now: () => t,
    date: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    advance(ms) {
      t += ms;
    },
    set(value) {
      const next = new Date(value).getTime();
      if (Number.isNaN(next)) throw new Error(`clock.set: invalid time ${String(value)}`);
      t = next;
    },
  };
}
