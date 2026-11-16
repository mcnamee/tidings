import { describe, expect, it } from 'vitest';
import { fetchHealth } from './api';

describe('fetchHealth', () => {
  it('returns the parsed health response', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ ok: true, version: '1.2.3' }))) as unknown as typeof fetch;
    await expect(fetchHealth(fake)).resolves.toEqual({ ok: true, version: '1.2.3' });
  });

  it('throws on a non-2xx response', async () => {
    const fake = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchHealth(fake)).rejects.toThrow(/500/);
  });
});
