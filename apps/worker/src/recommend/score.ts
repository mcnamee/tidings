/**
 * The recommended-sort formulas and constants (TID-067, ADR 0018 amendment). Pure functions.
 *
 * Profile: the mean of the embeddings of engaged entries, each weighted by
 *   points x 0.5 ^ (age / PROFILE_HALF_LIFE),   points = 1 (opened) + 2 (clicked through)
 * then scaled to unit length. Score of an unread entry at time `t`:
 *   cosine(profile, entry) + FRESH_WEIGHT x 0.5 ^ (age / FRESH_HALF_LIFE)
 * where an entry without an embedding uses NEUTRAL_COSINE in place of the cosine.
 */
import { DIMS } from './vector';

const DAY = 86_400;

/** Fewer signals than this and "Recommended" is newest first (backlog AC5). */
export const MIN_SIGNALS = 20;
/** Signals used for one profile: the most recent, by `last_at`. Bounds rows read and CPU. */
export const PROFILE_SIGNAL_LIMIT = 500;
/** Signal weight halves every 14 days. */
export const PROFILE_HALF_LIFE_S = 14 * DAY;
/** The newest this many unread entries of a view are ranked; older ones follow newest first. */
export const CANDIDATE_LIMIT = 500;
/** A new article adds up to this much to its score; the bonus halves every 3 days. */
export const FRESH_WEIGHT = 0.5;
export const FRESH_HALF_LIFE_S = 3 * DAY;
/** Cosine assumed for an entry that has no embedding yet (typical for an unrelated article). */
export const NEUTRAL_COSINE = 0.3;
/** Scores are compared as integers (micro-units) so a cursor holds an exact value. */
export const SCORE_SCALE = 1_000_000;

/** Points for one signal row: opened 1, clicked 2, both 3 (ADR 0018, owner-confirmed). */
export function signalPoints(row: { opened_at: number | null; clicked_at: number | null }): number {
  return (row.opened_at === null ? 0 : 1) + (row.clicked_at === null ? 0 : 2);
}

/** Weight of one signal row at `now`: its points, halved for every 14 days since `last_at`. */
export function signalWeight(
  row: { opened_at: number | null; clicked_at: number | null; last_at: number },
  now: number,
): number {
  const age = Math.max(0, now - row.last_at);
  return signalPoints(row) * Math.pow(0.5, age / PROFILE_HALF_LIFE_S);
}

export interface ProfileInput {
  opened_at: number | null;
  clicked_at: number | null;
  last_at: number;
  /** The entry's dequantised embedding. */
  vec: Float32Array;
}

/** The weighted mean as a unit vector, and how many signals fed it; null with nothing to average. */
export function buildProfile(
  rows: readonly ProfileInput[],
  now: number,
): { vec: Float32Array; signals: number } | null {
  const sum = new Float32Array(DIMS);
  let signals = 0;
  for (const r of rows) {
    const w = signalWeight(r, now);
    if (w <= 0) continue;
    for (let i = 0; i < DIMS; i++) sum[i] = (sum[i] as number) + w * (r.vec[i] as number);
    signals += 1;
  }
  let n = 0;
  for (let i = 0; i < DIMS; i++) n += (sum[i] as number) * (sum[i] as number);
  if (signals === 0 || n === 0) return null;
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i++) sum[i] = (sum[i] as number) / n;
  return { vec: sum, signals };
}

/** Freshness bonus of an article `age` seconds old. */
export function freshness(age: number): number {
  return FRESH_WEIGHT * Math.pow(0.5, Math.max(0, age) / FRESH_HALF_LIFE_S);
}

/** Score at `now`. `cos` is null for an entry with no embedding. */
export function blendScore(cos: number | null, publishedAt: number, now: number): number {
  return (cos ?? NEUTRAL_COSINE) + freshness(now - publishedAt);
}

/** The integer the list is ordered and paged by. */
export function scoreKey(score: number): number {
  return Math.round(score * SCORE_SCALE);
}

/** Whether a profile built from `signals` signals is allowed to order the list. */
export function profileReady(signals: number | null | undefined): boolean {
  return (signals ?? 0) >= MIN_SIGNALS;
}
