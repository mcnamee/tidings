import type { Env } from '../env';
import { createApp } from './api/app';

const app = createApp();

export default {
  fetch: app.fetch,
  // Empty for now; the refresh dispatcher and maintenance arrive with TID-012 / TID-021.
  scheduled(controller: ScheduledController): void {
    console.log(
      `scheduled: cron=${controller.cron} at=${new Date(controller.scheduledTime).toISOString()}`,
    );
  },
} satisfies ExportedHandler<Env>;
