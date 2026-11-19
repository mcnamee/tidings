/**
 * `scheduled()` handler for the refresh dispatcher cron. Kept out of `src/index.ts` so that file
 * only wires it in.
 */
import type { Env } from '../../env';
import { Db, sql } from '../db';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';
import { runMaintenance } from '../maintenance';
import type { Recommender } from '../recommend/entrypoint';
import { EMBED_MAX_TRIES } from '../recommend/embed';
import { runDispatcher, type DispatcherDeps } from './dispatcher';
import type { FeedRefresher } from './entrypoint';

/** Cron `17 * * * *` is the maintenance job (TID-021); everything else dispatches refreshes. */
export const MAINTENANCE_CRON = '17 * * * *';

/** The two Workers AI steps (TID-067). Tests pass fakes; production calls `ctx.exports.Recommender`. */
export type RecommenderSteps = Pick<Recommender, 'embedPending' | 'buildProfiles'>;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  overrides: Partial<DispatcherDeps> = {},
  recommender?: RecommenderSteps,
): Promise<void> {
  // TID-010 AC6: refuse to run when ALLOW_FETCH_HOSTS is set outside local development.
  try {
    resolveFetchPolicy(env);
  } catch (err) {
    if (!(err instanceof FetchConfigError)) throw err;
    console.error(`configuration error: ${err.message}`);
    return;
  }
  const steps =
    recommender ??
    (ctx.exports as unknown as { Recommender?: RecommenderSteps } | undefined)?.Recommender;
  if (controller.cron === MAINTENANCE_CRON) {
    await runMaintenance({ db: new Db(env.DB), clock: () => Date.now() });
    // TID-067: rebuild the interest profiles in their own invocation (own CPU budget). A failure
    // there is logged inside and never fails the maintenance run.
    await steps?.buildProfiles().catch(() => null);
    return;
  }

  const exportsWithRefresher = ctx.exports as unknown as { FeedRefresher: FeedRefresher };
  const db = new Db(env.DB);
  const summary = await runDispatcher({
    db,
    clock: () => Date.now(),
    random: () => Math.random(),
    refresh: (job) => exportsWithRefresher.FeedRefresher.refresh(job),
    ...overrides,
  });
  console.log(JSON.stringify({ event: 'refresh_dispatch', cron: controller.cron, ...summary }));

  // TID-067: embed queued entries in their own invocation, and only when there is something to do
  // and Workers AI is bound (one indexed read otherwise). Never affects the refresh above.
  if (env.AI) {
    try {
      const pending = await db.first<{ one: number }>(
        sql('SELECT 1 AS one FROM embed_queue WHERE tries < ? LIMIT 1', EMBED_MAX_TRIES),
      );
      if (pending) await steps?.embedPending();
    } catch {
      console.warn(JSON.stringify({ level: 'warn', event: 'embed_dispatch_failed' }));
    }
  }
}
