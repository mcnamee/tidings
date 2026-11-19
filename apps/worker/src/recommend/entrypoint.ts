/**
 * `Recommender`: RPC entrypoint for the two Workers AI steps of the recommended sort (TID-067,
 * ADR 0018). Like `FeedRefresher`, each call is its own invocation with its own CPU budget, so the
 * dispatcher and maintenance crons stay as small as before. Without the AI binding both steps do
 * nothing. A failure is logged as counts only and never reaches the caller as an exception.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../../env';
import { Db } from '../db';
import { runEmbedPending, workersAiEmbedder, type EmbedSummary } from './embed';
import { runProfiles, type ProfileSummary } from './profile';

export class Recommender extends WorkerEntrypoint<Env> {
  async embedPending(): Promise<EmbedSummary | null> {
    if (!this.env.AI) return null;
    try {
      const summary = await runEmbedPending({
        db: new Db(this.env.DB),
        embedder: workersAiEmbedder(this.env.AI),
        clock: () => Date.now(),
      });
      if (summary.embedded > 0 || summary.stopped === 'ai_error') {
        console.log(JSON.stringify({ event: 'embed_pending', ...summary }));
      }
      return summary;
    } catch {
      console.warn(JSON.stringify({ level: 'warn', event: 'embed_pending_failed' }));
      return null;
    }
  }

  async buildProfiles(): Promise<ProfileSummary | null> {
    try {
      const summary = await runProfiles({
        db: new Db(this.env.DB),
        embedder: this.env.AI ? workersAiEmbedder(this.env.AI) : null,
        clock: () => Date.now(),
      });
      console.log(JSON.stringify({ event: 'profiles', ...summary }));
      return summary;
    } catch {
      console.warn(JSON.stringify({ level: 'warn', event: 'profiles_failed' }));
      return null;
    }
  }
}
