import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('api app', () => {
  const app = createApp();

  it('GET /api/health returns ok and a version', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  it('an unknown /api route is 401 without a session (deny by default), as JSON', async () => {
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });
});
