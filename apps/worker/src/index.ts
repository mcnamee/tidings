import type { Env } from '../env';
import { createApp } from './api/app';
import { handleScheduled } from './refresh/scheduled';

// TID-012: the per-feed RPC entrypoint must be a named export of the main module (ctx.exports).
export { FeedRefresher } from './refresh/entrypoint';

const app = createApp();

export default {
  fetch: app.fetch,
  // TID-012: refresh dispatcher. The hourly maintenance cron arrives with TID-021.
  scheduled: (controller, env, ctx) => handleScheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
