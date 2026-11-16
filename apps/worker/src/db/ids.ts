/** Injectable clock so tests can fix time. Returns Unix epoch milliseconds. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** Current time as Unix epoch seconds (the DB's time unit, spec §6). */
export function nowSeconds(clock: Clock = systemClock): number {
  return Math.floor(clock() / 1000);
}

export function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid ISO timestamp: ${iso}`);
  return Math.floor(ms / 1000);
}

/** Random ID for users, folders, subscriptions and so on (spec §6). */
export function newId(): string {
  return crypto.randomUUID();
}

/** `guid_hash` dedup key (spec §6.3). Lives in `@tidings/shared` so the feed parser shares it. */
export { guidHash } from '@tidings/shared/dedup';
