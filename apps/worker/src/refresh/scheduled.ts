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
import { tagStepDue } from '../recommend/tag';
import { runDispatcher, type DispatcherDeps } from './dispatcher';
import type { FeedRefresher } from './entrypoint';
import type { ImageEnricher } from '../images/entrypoint';

/** Cron `17 * * * *` is the maintenance job (TID-021); everything else dispatches refreshes. */
export const MAINTENANCE_CRON = '17 * * * *';

/** The Workers AI steps (TID-067, TID-077). Tests pass fakes; production calls `ctx.exports.Recommender`. */
export type RecommenderSteps = Pick<Recommender, 'embedPending' | 'buildProfiles' | 'tagPending'>;

/** The image step (TID-071). Tests pass a fake; production calls `ctx.exports.ImageEnricher`. */
export type ImageSteps = Pick<ImageEnricher, 'enrichPending'>;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  overrides: Partial<DispatcherDeps> = {},
  recommender?: RecommenderSteps,
  imageSteps?: ImageSteps,
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
  // TID-071: fetch preview images for queued entries in their own invocation, only when the queue
  // has a row (one primary-key read otherwise). Never affects the refresh above.
  try {
    const pending = await db.first<{ one: number }>(
      sql('SELECT 1 AS one FROM image_queue LIMIT 1'),
    );
    if (pending) {
      const images =
        imageSteps ??
        (ctx.exports as unknown as { ImageEnricher?: ImageSteps } | undefined)?.ImageEnricher;
      await images?.enrichPending();
    }
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'image_dispatch_failed' }));
  }
  // TID-077: tag recent untagged entries in their own invocation. It runs at minute 41 of each UTC
  // hour, and every minute while the last run left a backlog (one point read). Never affects the
  // refresh above. Last, because a run with a backlog can take a while.
  if (env.AI) {
    try {
      if (await tagStepDue(db, controller.scheduledTime)) await steps?.tagPending();
    } catch {
      console.warn(JSON.stringify({ level: 'warn', event: 'tag_dispatch_failed' }));
    }
  }
}
