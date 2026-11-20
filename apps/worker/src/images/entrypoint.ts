/**
 * `ImageEnricher`: RPC entrypoint for the image step (TID-071, ADR 0019). Like `FeedRefresher` and
 * `Recommender`, each call is its own invocation with its own CPU and subrequest budget, so the
 * refresh dispatcher is unchanged in cost. A failure is logged as counts only and never reaches the
 * caller as an exception.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../../env';
import { Db } from '../db';
import { FetchConfigError, resolveFetchPolicy } from '../fetch';
import { runEnrichImages, type EnrichSummary } from './enrich';

export class ImageEnricher extends WorkerEntrypoint<Env> {
  async enrichPending(): Promise<EnrichSummary | null> {
    try {
      const policy = resolveFetchPolicy(this.env);
      const summary = await runEnrichImages({
        db: new Db(this.env.DB),
        // Looked up at call time so tests can replace `globalThis.fetch`.
        fetch: (input, init) => fetch(input, init),
        appOrigin: policy.appOrigin,
        allowHosts: policy.allowHosts,
        clock: () => Date.now(),
      });
      if (summary.fetched > 0) console.log(JSON.stringify({ event: 'enrich_images', ...summary }));
      return summary;
    } catch (err) {
      if (err instanceof FetchConfigError) console.error(`configuration error: ${err.message}`);
      else console.warn(JSON.stringify({ level: 'warn', event: 'enrich_images_failed' }));
      return null;
    }
  }
}
