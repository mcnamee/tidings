import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// TID-010 AC6 in workerd: the real Worker entry point refuses every request when
// ALLOW_FETCH_HOSTS is set while APP_ORIGIN is not http://localhost:*.
async function call(
  overrides: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request('https://example.test/api/health') as Request<unknown, IncomingRequestCfProperties>,
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

describe('Worker config guard (AC6)', () => {
  it('refuses requests with a logged configuration error in a production-like config', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = await call({
      APP_ORIGIN: 'https://tidings.mcn.am',
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'config_error' } });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('configuration error'));
    spy.mockRestore();
  });

  it('serves requests when the var is absent', async () => {
    const { status, body } = await call({ APP_ORIGIN: 'https://tidings.mcn.am' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });

  it('serves requests with the var set on http://localhost:*', async () => {
    const { status } = await call({
      APP_ORIGIN: 'http://localhost:8788',
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(status).toBe(200);
  });

  it('the configured test environment has no allow-list (production-like)', () => {
    expect(env.ALLOW_FETCH_HOSTS).toBeUndefined();
  });
});
