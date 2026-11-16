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

// Tester additions (TID-010 AC6, adversarial).
async function callRoute(
  method: string,
  path: string,
  overrides: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`https://example.test${path}`, { method }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

const PROD = 'https://tidings.mcn.am';

describe('Worker config guard: every route, every origin shape', () => {
  it.each([
    ['GET', '/api/health'],
    ['GET', '/api/nope'],
    ['POST', '/api/anything'],
    ['DELETE', '/api/subscriptions/1'],
  ])('%s %s returns 500 config_error in a production-like config', async (method, path) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = await callRoute(method as string, path as string, {
      APP_ORIGIN: PROD,
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'config_error' } });
    spy.mockRestore();
  });

  it.each([
    'https://localhost:8788',
    'http://localhost.evil.com',
    'http://localhost@evil.com',
    'http://evil.com@localhost',
    'http://127.0.0.1:8788',
    'http://localhost.:8788',
    'garbage',
    '',
  ])('refuses when ALLOW_FETCH_HOSTS is set and APP_ORIGIN is %j', async (origin) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status } = await callRoute('GET', '/api/health', {
      APP_ORIGIN: origin,
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(status).toBe(500);
    spy.mockRestore();
  });

  it('the error response does not leak the allow-list', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { body } = await callRoute('GET', '/api/health', {
      APP_ORIGIN: PROD,
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(JSON.stringify(body)).not.toContain('8790');
    expect(JSON.stringify(body)).not.toContain('ALLOW_FETCH_HOSTS');
    spy.mockRestore();
  });

  it('scheduled() logs a configuration error and does not run the job', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    worker.scheduled!({ cron: '* * * * *', scheduledTime: 0 } as ScheduledController, {
      ...env,
      APP_ORIGIN: PROD,
      ALLOW_FETCH_HOSTS: '127.0.0.1:8790',
    });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('configuration error'));
    expect(log).not.toHaveBeenCalled();
    err.mockRestore();
    log.mockRestore();
  });

  it('scheduled() runs normally on a production config without the var', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    worker.scheduled!({ cron: '* * * * *', scheduledTime: 0 } as ScheduledController, {
      ...env,
      APP_ORIGIN: PROD,
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
