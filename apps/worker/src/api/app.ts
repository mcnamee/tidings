import { Hono } from 'hono';
import type { ApiError, HealthResponse } from '@tidings/shared';
import type { Env } from '../../env';
import { createAuthRoutes, type AuthDeps } from '../auth/routes';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';

export const APP_VERSION = '0.0.0';

export function createApp(deps?: Partial<AuthDeps>): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>().basePath('/api');

  // Spec 8.1. Recovery codes travel in these responses, so nothing may be cached. It is registered
  // first so it also covers the config guard's short-circuit below (DEF-012). TID-008 adds
  // the rest of the API security headers next to this.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

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

  app.route('/auth', createAuthRoutes(deps));

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
