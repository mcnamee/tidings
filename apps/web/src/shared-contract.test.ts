import { describe, expect, it } from 'vitest';
import sharedEntry from '../../../packages/shared/src/index.ts?raw';

// The SPA imports `@tidings/shared`. zod's runtime would come along, and its `Function('')`
// probe is a CSP violation (the policy has no 'unsafe-eval'). So the entry point stays zod-free
// and the schemas live in ./schemas for the Worker (found by TID-007 AC10's CSP check).
describe('@tidings/shared entry point', () => {
  it('does not import zod or the schemas', () => {
    expect(sharedEntry).not.toMatch(/from\s+['"]zod['"]/);
    expect(sharedEntry).not.toMatch(/from\s+['"]\.\/schemas['"]/);
  });
});
