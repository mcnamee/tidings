import { describe, expect, it } from 'vitest';
import sharedEntry from '../../../packages/shared/src/index.ts?raw';
import spec from '../../../docs/PRODUCT_SPEC.md?raw';

// The SPA imports `@tidings/shared`. zod's runtime would come along, and its `Function('')`
// probe is a CSP violation (the policy has no 'unsafe-eval'). So the entry point stays zod-free
// and the schemas live in ./schemas for the Worker (found by TID-007 AC10's CSP check).
describe('@tidings/shared entry point', () => {
  it('does not import zod or the schemas', () => {
    expect(sharedEntry).not.toMatch(/from\s+['"]zod['"]/);
    expect(sharedEntry).not.toMatch(/from\s+['"]\.\/schemas['"]/);
  });
});

/** The string literals of a `type ErrorCode = | 'a' | 'b'` union, in order. */
function errorCodes(source: string): string[] {
  const match = /type ErrorCode\s*=([^;]*);/.exec(source);
  expect(match, 'ErrorCode union found').not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

// TID-008 AC12: the shared ErrorCode is exactly spec 8.1's.
describe('ErrorCode', () => {
  it('matches spec 8.1 exactly (same codes, no extras)', () => {
    const fromSpec = errorCodes(spec);
    const fromCode = errorCodes(sharedEntry);
    expect(fromSpec.length).toBeGreaterThan(15);
    expect([...fromCode].sort()).toEqual([...fromSpec].sort());
  });

  it('says internal, not internal_error, and includes config_error', () => {
    const codes = errorCodes(sharedEntry);
    expect(codes).toContain('internal');
    expect(codes).not.toContain('internal_error');
    expect(codes).toContain('config_error');
  });
});
