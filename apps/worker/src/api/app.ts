import { Hono } from 'hono';
import type { ApiError, HealthResponse } from '@tidings/shared';
import { createAuthRoutes, type AuthDeps } from '../auth/routes';
import { systemClock } from '../db';
import { createCountsRoutes, createEntryRoutes } from '../entries/routes';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';
import {
  createFolderRoutes,
  createSubscriptionRoutes,
  type SubscriptionDeps,
} from '../subscriptions/routes';
import { fail } from './respond';
import { apiGuard, securityHeaders, type ApiRateLimiter, type AppEnv } from './security';

export const APP_VERSION = '0.0.0';

export interface AppDeps extends AuthDeps {
  /** Stub for the `API_RL` binding in tests; production uses `env.API_RL`. */
  apiRateLimit: ApiRateLimiter;
  /** Subscribe and discovery dependencies (TID-013); production uses the real ones. */
  subscriptions: Partial<SubscriptionDeps>;
}

export function createApp(deps?: Partial<AppDeps>): Hono<AppEnv> {
  const app = new Hono<AppEnv>().basePath('/api');

  // Spec 8.1 and 10.4: Cache-Control, nosniff and CORP on every response. Registered first so it
  // also covers the short-circuits below (DEF-012). No CORS headers are ever added.
  app.use('*', securityHeaders);

  // TID-010 AC6: a misconfigured ALLOW_FETCH_HOSTS makes every request fail loudly.
  app.use('*', async (c, next) => {
    if (c.env) {
      try {
        resolveFetchPolicy(c.env);
      } catch (err) {
        if (!(err instanceof FetchConfigError)) throw err;
        console.error(`configuration error: ${err.message}`);
        return fail(c, 500, 'config_error', 'Server configuration error');
      }
    }
    await next();
  });

  // Session, CSRF and the per-user rate limit (spec 8.1, 10.3, 10.7). Deny by default.
  app.use('*', apiGuard({ clock: deps?.clock ?? systemClock, apiRateLimit: deps?.apiRateLimit }));

  app.route('/auth', createAuthRoutes(deps));
  app.route('/folders', createFolderRoutes());
  app.route(
    '/subscriptions',
    createSubscriptionRoutes({ clock: deps?.clock, ...deps?.subscriptions }),
  );

  app.route('/entries', createEntryRoutes({ clock: deps?.clock }));
  app.route('/counts', createCountsRoutes());

  app.get('/health', (c) => {
    const body: HealthResponse = { ok: true, version: APP_VERSION };
    return c.json(body);
  });

  app.notFound((c) => fail(c, 404, 'not_found', 'Not found'));

  app.onError((err, c) => {
    // The exception text stays in the log; the response carries a fixed message (spec 8.1).
    console.error('unhandled error', err);
    const body: ApiError = { error: { code: 'internal', message: 'Internal error' } };
    return c.json(body, 500);
  });

  return app;
}
