/**
 * `Recommender`: RPC entrypoint for the Workers AI steps: the two of the recommended sort (TID-067,
 * ADR 0018) and the tag step (TID-077, ADR 0021). Like `FeedRefresher`, each call is its own invocation with its own CPU budget, so the
 * dispatcher and maintenance crons stay as small as before. Without the AI binding both steps do
 * nothing. A failure is logged as counts only and never reaches the caller as an exception.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../../env';
import { Db } from '../db';
import { runEmbedPending, workersAiEmbedder, type EmbedSummary } from './embed';
import { runProfiles, type ProfileSummary } from './profile';
import { runTagPending, workersAiTagger, type TagSummary } from './tag';

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

  /** The hourly tag step (TID-077). Logs one counts-only `embed_tag` line; never stores or logs model text. */
  async tagPending(): Promise<TagSummary | null> {
    if (!this.env.AI) return null;
    try {
      const summary = await runTagPending({
        db: new Db(this.env.DB),
        tagger: workersAiTagger(this.env.AI),
        embedder: workersAiEmbedder(this.env.AI),
        clock: () => Date.now(),
      });
      console.log(JSON.stringify({ event: 'embed_tag', ...summary }));
      return summary;
    } catch {
      console.warn(JSON.stringify({ level: 'warn', event: 'embed_tag_failed' }));
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
