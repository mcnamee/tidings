/**
 * `scheduled()` handler for the refresh dispatcher cron. Kept out of `src/index.ts` so that file
 * only wires it in.
 */
import type { Env } from '../../env';
import { Db } from '../db';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';
import { runDispatcher, type DispatcherDeps } from './dispatcher';
import type { FeedRefresher } from './entrypoint';

/** Cron `17 * * * *` is the maintenance job (TID-021); everything else dispatches refreshes. */
export const MAINTENANCE_CRON = '17 * * * *';

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  overrides: Partial<DispatcherDeps> = {},
): Promise<void> {
  // TID-010 AC6: refuse to run when ALLOW_FETCH_HOSTS is set outside local development.
  try {
    resolveFetchPolicy(env);
  } catch (err) {
    if (!(err instanceof FetchConfigError)) throw err;
    console.error(`configuration error: ${err.message}`);
    return;
  }
  if (controller.cron === MAINTENANCE_CRON) return; // TID-021

  const exportsWithRefresher = ctx.exports as unknown as { FeedRefresher: FeedRefresher };
  const summary = await runDispatcher({
    db: new Db(env.DB),
    clock: () => Date.now(),
    random: () => Math.random(),
    refresh: (job) => exportsWithRefresher.FeedRefresher.refresh(job),
    ...overrides,
  });
  console.log(JSON.stringify({ event: 'refresh_dispatch', cron: controller.cron, ...summary }));
}
