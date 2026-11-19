import { describe, expect, it } from 'vitest';
import {
  embeddingText,
  estimateTokens,
  neuronsFor,
  DAILY_TOKEN_CAP,
  EMBED_TEXT_CHARS,
} from './embed';
import {
  blendScore,
  buildProfile,
  freshness,
  FRESH_WEIGHT,
  MIN_SIGNALS,
  NEUTRAL_COSINE,
  profileReady,
  scoreKey,
  signalPoints,
  signalWeight,
  PROFILE_HALF_LIFE_S,
} from './score';
import {
  cosine,
  decodeEmbedding,
  decodeProfile,
  DIMS,
  dotEncoded,
  encodeEmbedding,
  encodeProfile,
  normalise,
} from './vector';

// TID-067: the pure parts. A tiny deterministic generator stands in for the model.
function vec(seed: number): number[] {
  let x = seed;
  return Array.from({ length: DIMS }, () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648 - 0.5;
  });
}
/** A vector that points mostly along `base` with a little of `other`. */
const mix = (base: number[], other: number[], w: number) =>
  base.map((b, i) => b + w * (other[i] as number));
const DAY = 86_400;

describe('quantisation', () => {
  it('round-trips a vector to within int8 rounding and stores 388 bytes (520 characters)', () => {
    const v = vec(1);
    const text = encodeEmbedding(v);
    expect(text).toHaveLength(520);
    expect(atob(text)).toHaveLength(388);
    const back = decodeEmbedding(text);
    expect(back).not.toBeNull();
    expect(cosine(v, back as Float32Array)).toBeGreaterThan(0.9999);
    expect(Math.abs(Math.hypot(...(back as Float32Array)) - 1)).toBeLessThan(0.01);
  });

  it('dotEncoded equals the cosine of the originals to about 0.5%', () => {
    const a = vec(2);
    const b = mix(vec(2), vec(3), 0.7);
    const exact = cosine(a, b);
    const fast = dotEncoded(normalise(a), encodeEmbedding(b));
    expect(fast).not.toBeNull();
    expect(Math.abs((fast as number) - exact)).toBeLessThan(0.005);
  });

  it('refuses wrong dimensions and rejects junk text', () => {
    expect(() => encodeEmbedding([1, 2, 3])).toThrow();
    expect(decodeEmbedding('not base64!!')).toBeNull();
    expect(decodeEmbedding(btoa('short'))).toBeNull();
    expect(decodeEmbedding(null)).toBeNull();
    expect(dotEncoded(normalise(vec(1)), 'x'.repeat(520))).toBeNull();
    expect(dotEncoded(normalise(vec(1)), 'tooshort')).toBeNull();
  });

  it('a zero vector encodes and decodes to zeros', () => {
    const back = decodeEmbedding(encodeEmbedding(new Array(DIMS).fill(0)));
    expect(back && Math.max(...back.map(Math.abs))).toBe(0);
  });

  it('a profile survives encoding exactly', () => {
    const p = normalise(vec(9));
    expect(Array.from(decodeProfile(encodeProfile(p)) as Float32Array)).toEqual(Array.from(p));
    expect(decodeProfile('AAAA')).toBeNull();
  });
});

describe('cosine', () => {
  it('is 1 for the same direction, 0 for orthogonal, -1 for opposite, 0 for a zero vector', () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('signal weighting and the profile', () => {
  const row = (o: number | null, c: number | null, last: number) => ({
    opened_at: o,
    clicked_at: c,
    last_at: last,
  });

  it('points: open 1, click 2, both 3', () => {
    expect(signalPoints(row(1, null, 1))).toBe(1);
    expect(signalPoints(row(null, 1, 1))).toBe(2);
    expect(signalPoints(row(1, 1, 1))).toBe(3);
  });

  it('weight halves every 14 days and never exceeds its points', () => {
    const now = 100 * DAY;
    expect(signalWeight(row(1, 1, now), now)).toBe(3);
    expect(signalWeight(row(1, null, now - PROFILE_HALF_LIFE_S), now)).toBeCloseTo(0.5);
    expect(signalWeight(row(1, null, now - 28 * DAY), now)).toBeCloseTo(0.25);
    expect(signalWeight(row(1, null, now + DAY), now)).toBe(1); // clock skew
  });

  it('is the weighted mean: a 3-point signal pulls the profile three times as hard as a 1-point one', () => {
    const a = normalise(vec(11));
    const b = normalise(vec(12));
    const now = 10 * DAY;
    const p = buildProfile(
      [
        { ...row(1, 1, now), vec: a },
        { ...row(1, null, now), vec: b },
      ],
      now,
    );
    expect(p?.signals).toBe(2);
    const toA = cosine(p?.vec as Float32Array, a);
    const toB = cosine(p?.vec as Float32Array, b);
    expect(toA).toBeGreaterThan(toB);
    // Check against the direct formula 3a + 1b.
    const direct = a.map((x, i) => 3 * x + (b[i] as number));
    expect(cosine(p?.vec as Float32Array, direct)).toBeGreaterThan(0.99999);
    expect(Math.hypot(...(p?.vec as Float32Array))).toBeCloseTo(1, 5);
  });

  it('an old signal counts for less than a new one', () => {
    const a = normalise(vec(21));
    const b = normalise(vec(22));
    const now = 100 * DAY;
    const p = buildProfile(
      [
        { ...row(1, null, now - 42 * DAY), vec: a }, // three half-lives: weight 1/8
        { ...row(1, null, now), vec: b },
      ],
      now,
    );
    expect(cosine(p?.vec as Float32Array, b)).toBeGreaterThan(cosine(p?.vec as Float32Array, a));
  });

  it('is null with nothing to average, and cold start needs 20 signals', () => {
    expect(buildProfile([], 1)).toBeNull();
    expect(profileReady(null)).toBe(false);
    expect(profileReady(MIN_SIGNALS - 1)).toBe(false);
    expect(profileReady(MIN_SIGNALS)).toBe(true);
  });
});

describe('score: similarity blended with freshness', () => {
  const NOW = 1_000 * DAY;

  it('an engaged topic ranks above an unrelated one of the same age', () => {
    expect(blendScore(0.7, NOW - DAY, NOW)).toBeGreaterThan(blendScore(0.1, NOW - DAY, NOW));
  });

  it('an equally similar newer entry ranks above an older one', () => {
    expect(blendScore(0.5, NOW - DAY, NOW)).toBeGreaterThan(blendScore(0.5, NOW - 5 * DAY, NOW));
  });

  it('a strong match from a week ago does not permanently beat a decent one from today', () => {
    expect(blendScore(0.4, NOW, NOW)).toBeGreaterThan(blendScore(0.7, NOW - 14 * DAY, NOW));
    // ...but a strong match is not buried by a trivial one a day newer.
    expect(blendScore(0.7, NOW - 2 * DAY, NOW)).toBeGreaterThan(blendScore(0.2, NOW - DAY, NOW));
  });

  it('freshness is FRESH_WEIGHT for a brand-new entry, halves every 3 days and is never negative', () => {
    expect(freshness(0)).toBeCloseTo(FRESH_WEIGHT);
    expect(freshness(3 * DAY)).toBeCloseTo(FRESH_WEIGHT / 2);
    expect(freshness(-DAY)).toBeCloseTo(FRESH_WEIGHT); // published "in the future": clamped
    expect(freshness(3650 * DAY)).toBeGreaterThanOrEqual(0);
  });

  it('an entry without an embedding scores with the neutral cosine', () => {
    expect(blendScore(null, NOW, NOW)).toBeCloseTo(NEUTRAL_COSINE + FRESH_WEIGHT);
  });

  it('the score key is an integer in micro-units', () => {
    expect(scoreKey(0.1234567)).toBe(123457);
    expect(Number.isInteger(scoreKey(-0.25))).toBe(true);
  });
});

describe('embedding text and the budget', () => {
  it('joins title and summary as plain text and clips to about 100 tokens', () => {
    expect(embeddingText('  A   title ', 'Some\n summary.')).toBe('A title. Some summary.');
    expect(embeddingText('Only title', null)).toBe('Only title');
    expect(embeddingText(null, '  ')).toBe('');
    expect(embeddingText('t', 'x'.repeat(1000))).toHaveLength(EMBED_TEXT_CHARS);
  });

  it('prices tokens at 1,841 neurons per million and caps the day at 3,000 neurons', () => {
    expect(neuronsFor(1_000_000)).toBe(1841);
    expect(neuronsFor(DAILY_TOKEN_CAP)).toBeLessThanOrEqual(3000);
    expect(neuronsFor(DAILY_TOKEN_CAP + 1000)).toBeGreaterThan(3000);
    // A full 400-character entry is about 136 estimated tokens: a deliberate over-estimate.
    expect(estimateTokens(['x'.repeat(400)])).toBe(136);
  });
});
