import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';
import { ValidationError } from './errors';

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('cursor', () => {
  it('round-trips', () => {
    for (const c of [
      { p: 1_760_000_000, i: 42 },
      { p: 0, i: 0 },
      { p: Number.MAX_SAFE_INTEGER, i: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    }
  });

  it('encodes as base64url of {"p","i"} without padding', () => {
    const encoded = encodeCursor({ p: 5, i: 7 });
    expect(encoded).toBe(b64url('{"p":5,"i":7}'));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty', ''],
    ['not base64', '!!!'],
    ['standard base64 alphabet', 'a+b/'],
    ['not json', b64url('hello')],
    ['json null', b64url('null')],
    ['json array', b64url('[1,2]')],
    ['missing i', b64url('{"p":1}')],
    ['string p', b64url('{"p":"1","i":2}')],
    ['float', b64url('{"p":1.5,"i":2}')],
    ['negative', b64url('{"p":-1,"i":2}')],
    ['too long', 'A'.repeat(500)],
    ['invalid utf-8', btoa(String.fromCharCode(0xff, 0xfe))],
  ])('rejects malformed cursor: %s', (_name, value) => {
    expect(() => decodeCursor(value)).toThrow(ValidationError);
  });

  it('ValidationError maps to 400 validation_failed', () => {
    try {
      decodeCursor('nope!');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe('validation_failed');
      expect((e as ValidationError).status).toBe(400);
    }
  });
});
