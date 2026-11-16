import { describe, expect, it } from 'vitest';

// TID-007 AC9 (ADR 0002): the WebAuthn library is evaluated lazily. It adds ~17 ms of start-up
// and 710 KiB to whatever imports it, so only auth/webauthn.ts may reach it, via `await import()`.
const sources = import.meta.glob('/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const LOADER = '/src/auth/webauthn.ts';
const LIBRARY = '@simplewebauthn/server';

/** Drops comments so prose mentioning the package is not mistaken for an import. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('AC9: @simplewebauthn/server is only loaded through await import()', () => {
  it('scans the Worker source', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(sources[LOADER]).toBeDefined();
  });

  it('no module outside auth/webauthn.ts mentions the library at all', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== LOADER && !path.endsWith('.test.ts'))
      .filter(([, text]) => code(text).includes(LIBRARY))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('auth/webauthn.ts has no static import or re-export of it, only a dynamic import()', () => {
    const text = code(sources[LOADER] ?? '');
    const staticImport = new RegExp(`^\\s*(import|export)\\b[^;]*?\\bfrom\\s*['"]${LIBRARY}`, 'm');
    expect(text).not.toMatch(staticImport);
    expect(text).not.toMatch(new RegExp(`^\\s*import\\s*['"]${LIBRARY}`, 'm'));
    expect(text).toMatch(new RegExp(`\\bimport\\(\\s*['"]${LIBRARY}['"]\\s*\\)`));
  });

  it('the dynamic import is inside a function, so evaluating the module does not load it', () => {
    const text = code(sources[LOADER] ?? '');
    expect(text).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*(await\s+)?import\(/m);
    expect(text).not.toMatch(/^await\s+import\(/m);
  });
});
