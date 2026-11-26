import { Hono } from 'hono';
import { TOPICS, TOPICS_VERSION, type TopicsResponse } from '@tidings/shared';
import type { AppEnv } from './security';

const BODY: TopicsResponse = {
  items: TOPICS.map((t) => ({ id: t.slug, name: t.name })),
  version: TOPICS_VERSION,
};

/**
 * `GET /api/topics` (TID-077, spec 8.5): the active system topics in display order. The list lives in
 * code, so there is no database access. A session is required like every route (the guard runs first).
 */
export function createTopicRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', (c) => c.json<TopicsResponse>(BODY));
  return app;
}
