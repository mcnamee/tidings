import type { Env } from '../env';
import { createApp } from './api/app';
import { resolveFetchPolicy } from './fetch';

const app = createApp();

export default {
  fetch: app.fetch,
  // Empty for now; the refresh dispatcher and maintenance arrive with TID-012 / TID-021.
  scheduled(controller: ScheduledController, env: Env): void {
    try {
      resolveFetchPolicy(env);
    } catch (err) {
      console.error(`configuration error: ${String(err)}`);
      return;
    }
    console.log(
      `scheduled: cron=${controller.cron} at=${new Date(controller.scheduledTime).toISOString()}`,
    );
  },
} satisfies ExportedHandler<Env>;
