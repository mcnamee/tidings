import { describe, expect, it } from 'vitest';
import headers from '../public/_headers?raw';
import indexHtml from '../index.html?raw';

// Spec 10.4. The built-app check (AC6) is a header assertion against `wrangler dev`; these tests
// guard the source files.
describe('_headers', () => {
  const lines = headers.split('\n').map((l) => l.trim());
  const value = (name: string) =>
    lines
      .find((l) => l.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim();

  it('applies to every path', () => {
    expect(lines[0]).toBe('/*');
  });

  it('carries the spec CSP, with no unsafe-inline or unsafe-eval', () => {
    const csp = value('Content-Security-Policy');
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
    expect(csp).not.toMatch(/unsafe-/);
  });

  it('carries the other spec headers', () => {
    expect(value('Referrer-Policy')).toBe('no-referrer');
    expect(value('X-Content-Type-Options')).toBe('nosniff');
    expect(value('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(value('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(value('Strict-Transport-Security')).toBe('max-age=31536000');
  });
});

describe('index.html', () => {
  it('has no inline script, style block, style attribute or event handler (CSP)', () => {
    expect(indexHtml).not.toMatch(/<style/i);
    expect(indexHtml).not.toMatch(/\sstyle=/i);
    expect(indexHtml).not.toMatch(/\son[a-z]+=/i);
    for (const m of indexHtml.matchAll(/<script\b([^>]*)>/gi)) {
      expect(m[1]).toMatch(/\bsrc=/);
    }
  });

  it('loads theme-init.js blocking, before the module script, with the documented metas', () => {
    expect(indexHtml).toMatch(/<script src="\/theme-init\.js"><\/script>/);
    expect(indexHtml.indexOf('theme-init.js')).toBeLessThan(indexHtml.indexOf('/src/main.tsx'));
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).not.toMatch(/user-scalable|maximum-scale/);
    expect(indexHtml).toContain('<meta name="color-scheme" content="light dark" />');
    expect(indexHtml).toContain('<meta name="theme-color" content="#f6f5f1" />');
    expect(indexHtml).toContain('Tidings needs JavaScript to run. Turn it on and reload.');
  });
});
