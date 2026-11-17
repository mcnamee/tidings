import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './returnPath';

describe('safeReturnPath (auth-common.md 7)', () => {
  it('keeps same-origin app paths, with their search', () => {
    for (const p of ['/all', '/folders/f1', '/feeds/s1/a/e9', '/manage/add', '/all?state=all']) {
      expect(safeReturnPath(p)).toBe(p);
    }
  });

  it('refuses anything that is not a single-slash path', () => {
    for (const p of [
      '',
      'all',
      '//evil.example',
      '///evil.example',
      'https://evil.example/',
      'http://localhost/all',
      'javascript:alert(1)',
      '/\\evil.example',
      '/all\u0000',
      '/all\n/x',
      `/${'a'.repeat(3000)}`,
    ]) {
      expect(safeReturnPath(p), JSON.stringify(p.slice(0, 20))).toBeNull();
    }
  });

  it('refuses non-strings', () => {
    for (const v of [undefined, null, 5, {}, ['/all'], true]) expect(safeReturnPath(v)).toBeNull();
  });

  it('refuses the auth screens, with or without a query, hash or trailing slash', () => {
    for (const p of ['/setup', '/login', '/recover', '/login?x=1', '/recover#a', '/login/']) {
      expect(safeReturnPath(p), p).toBeNull();
    }
  });

  it('does not refuse a path that merely starts like an auth screen', () => {
    expect(safeReturnPath('/login-help')).toBe('/login-help');
    expect(safeReturnPath('/all/login')).toBe('/all/login');
  });
});
