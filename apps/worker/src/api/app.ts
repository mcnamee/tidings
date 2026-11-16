import { Hono } from 'hono';
import type { ApiError, HealthResponse } from '@tidings/shared';
import type { Env } from '../../env';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';

export const APP_VERSION = '0.0.0';

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>().basePath('/api');

  // TID-010 AC6: a misconfigured ALLOW_FETCH_HOSTS makes every request fail loudly.
  app.use('*', async (c, next) => {
    if (c.env) {
      try {
        resolveFetchPolicy(c.env);
      } catch (err) {
        if (!(err instanceof FetchConfigError)) throw err;
        console.error(`configuration error: ${err.message}`);
        const body: ApiError = {
          error: { code: 'config_error', message: 'Server configuration error' },
        };
        return c.json(body, 500);
      }
    }
    await next();
  });

  app.get('/health', (c) => {
    const body: HealthResponse = { ok: true, version: APP_VERSION };
    return c.json(body);
  });

  app.notFound((c) => {
    const body: ApiError = { error: { code: 'not_found', message: 'Not found' } };
    return c.json(body, 404);
  });

  app.onError((err, c) => {
    console.error('unhandled error', err);
    const body: ApiError = { error: { code: 'internal_error', message: 'Internal error' } };
    return c.json(body, 500);
  });

  return app;
}
