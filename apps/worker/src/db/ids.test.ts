import { describe, expect, it } from 'vitest';
import { fromIso, guidHash, newId, nowSeconds, toIso } from './ids';

describe('time helpers', () => {
  it('uses the injected clock and floors to seconds', () => {
    expect(nowSeconds(() => 1_760_000_000_999)).toBe(1_760_000_000);
  });

  it('converts to and from ISO', () => {
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(fromIso('2025-10-09T08:53:20Z')).toBe(1_760_000_000);
    expect(fromIso(toIso(1_760_000_123))).toBe(1_760_000_123);
    expect(() => fromIso('garbage')).toThrow(RangeError);
  });
});

describe('ids', () => {
  it('newId returns distinct UUIDs', () => {
    const a = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newId()).not.toBe(a);
  });

  it('guidHash is 22 base64url chars, deterministic, and scoped by feed id', async () => {
    const h = await guidHash(1, 'abc');
    expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await guidHash(1, 'abc')).toBe(h);
    expect(await guidHash(2, 'abc')).not.toBe(h);
    expect(await guidHash(1, 'ABC')).not.toBe(h);
  });
});
