import { describe, expect, it } from 'vitest';
import { isMutating, isPublicRoute, passesCsrfCheck } from './security';

const ORIGIN = 'https://tidings.mcn.am';
const h = (init: Record<string, string>) => new Headers(init);

describe('passesCsrfCheck (spec 10.3)', () => {
  it('accepts a matching Origin with a JSON body', () => {
    expect(passesCsrfCheck(h({ Origin: ORIGIN, 'Content-Type': 'application/json' }), ORIGIN)).toBe(
      true,
    );
  });

  it('accepts same-origin Sec-Fetch-Site when Origin is absent', () => {
    expect(
      passesCsrfCheck(
        h({ 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' }),
        ORIGIN,
      ),
    ).toBe(true);
  });

  it('needs both halves', () => {
    expect(passesCsrfCheck(h({ Origin: ORIGIN }), ORIGIN)).toBe(false);
    expect(passesCsrfCheck(h({ 'Content-Type': 'application/json' }), ORIGIN)).toBe(false);
    expect(passesCsrfCheck(h({ Origin: ORIGIN, 'Content-Type': 'text/plain' }), ORIGIN)).toBe(
      false,
    );
  });

  it('compares the whole origin string, not a prefix or suffix', () => {
    for (const origin of [
      `${ORIGIN}.evil.example`,
      `${ORIGIN}:8443`,
      'http://tidings.mcn.am',
      'null',
      '',
    ]) {
      expect(
        passesCsrfCheck(h({ Origin: origin, 'Content-Type': 'application/json' }), ORIGIN),
      ).toBe(false);
    }
  });

  it('a present but wrong Origin is not rescued by Sec-Fetch-Site', () => {
    expect(
      passesCsrfCheck(
        h({
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        }),
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe('route classification', () => {
  it('knows the mutating methods', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(isMutating(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isMutating(m)).toBe(false);
  });

  it('is exact on method and path: near misses are not public', () => {
    expect(isPublicRoute('GET', '/api/health')).toBe(true);
    expect(isPublicRoute('POST', '/api/health')).toBe(false);
    expect(isPublicRoute('GET', '/api/health/')).toBe(false);
    expect(isPublicRoute('GET', '/api/Health')).toBe(false);
    expect(isPublicRoute('GET', '/api/auth/session/x')).toBe(false);
    expect(isPublicRoute('POST', '/api/auth/logout')).toBe(false);
    expect(isPublicRoute('GET', '/api/auth/setup/options')).toBe(false);
  });
});
