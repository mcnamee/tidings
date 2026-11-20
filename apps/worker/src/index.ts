import type { Env } from '../env';
import { createApp } from './api/app';
import { handleScheduled } from './refresh/scheduled';

// TID-012: the per-feed RPC entrypoint must be a named export of the main module (ctx.exports).
export { FeedRefresher } from './refresh/entrypoint';
// TID-067: the Workers AI steps of the recommended sort (embedding and profiles), same mechanism.
export { Recommender } from './recommend/entrypoint';

// TID-071: preview images from article pages for entries whose feed gave none, same mechanism.
export { ImageEnricher } from './images/entrypoint';

const app = createApp();

export default {
  fetch: app.fetch,
  // TID-012: refresh dispatcher. The hourly maintenance cron arrives with TID-021.
  scheduled: (controller, env, ctx) => handleScheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
