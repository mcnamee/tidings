/**
 * `/api/folders` (read) and `/api/subscriptions` (list, subscribe), spec §8.4. Folder writes and
 * subscription edit, delete and refresh belong to TID-014 and TID-015.
 *
 * Subscribe (spec §7.5, FR-SU-1 to FR-SU-4, FR-SU-7, FR-SU-8): canonicalise, check the address,
 * find the feed, upsert it and the subscription in one batch, then *await* the `FeedRefresher`
 * entrypoint (10 s) so the first fetch has its own invocation and CPU budget.
 */
import { Hono, type Context } from 'hono';
import {
  SUBSCRIPTION_LIMIT,
  feedErrorMessage,
  type AlreadySubscribedDetails,
  type FeedChoiceDetails,
  type FoldersResponse,
  type SubscribeFetchOutcome,
  type SubscribeResponse,
  type SubscriptionsResponse,
} from '@tidings/shared';
import { subscribeRequestSchema } from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { parseBody } from '../auth/routes';
import {
  Db,
  canonicalizeUrl,
  countSubscriptions,
  countUserEntriesForFeed,
  createSubscription,
  findFeedByUrl,
  findSubscriptionIdByFeedUrl,
  folderBelongsToUser,
  getSubscription,
  listFolders,
  listSubscriptions,
  newId,
  nowSeconds,
  systemClock,
  ValidationError,
  type Clock,
  type FeedRow,
} from '../db';
import { checkUrl, FetchConfigError, resolveFetchPolicy, type FetchFn } from '../fetch';
import { classifyRejection } from '../refresh/dispatcher';
import type { FeedRefresher } from '../refresh/entrypoint';
import type { RefreshJob, RefreshOutcome } from '../refresh/types';
import { resolveFeedUrl, type ResolveDeps } from './resolve';

/** FR-SU-2: a feed fetched within this long is not fetched again for a new subscriber. */
const FRESH_FEED_SECONDS = 30 * 60;

/** Spec §7.5: how long the API waits for the first fetch. */
export const FIRST_FETCH_TIMEOUT_MS = 10_000;

export interface SubscriptionDeps {
  clock: Clock;
  /** Returns a value in [0, 1). Used for `next_fetch_at` jitter. */
  random: () => number;
  /** For discovery. The first fetch itself goes through `refresh`. */
  fetch: FetchFn;
  /**
   * Runs the first fetch. Production calls `ctx.exports.FeedRefresher.refresh` (ADR 0004); tests
   * inject a spy.
   */
  refresh?: (job: RefreshJob) => Promise<RefreshOutcome>;
  firstFetchTimeoutMs: number;
  discover?: ResolveDeps['discover'];
}

function fixedMessage(code: 'blocked_address' | 'invalid_url'): string {
  return feedErrorMessage(code) ?? 'This address is not allowed';
}

function jobFor(feed: FeedRow): RefreshJob {
  return {
    feedId: feed.id,
    url: feed.url,
    etag: feed.etag,
    lastModified: feed.last_modified,
    bodyHash: feed.body_hash,
    errorCount: feed.error_count,
    state: feed.state,
    fetchIntervalS: feed.fetch_interval_s,
    lastSuccessAt: feed.last_success_at,
  };
}

/** Awaits the refresher for at most `timeoutMs`; every outcome becomes a fixed code. */
async function firstFetch(
  run: () => Promise<RefreshOutcome>,
  timeoutMs: number,
): Promise<SubscribeFetchOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const call = run();
    call.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    const outcome = await Promise.race([call, timeout]);
    if (outcome === 'timeout') return { ok: false, newEntries: 0, errorCode: 'timeout' };
    if (outcome.result === 'failed' || outcome.result === 'skipped') {
      return { ok: false, newEntries: 0, errorCode: outcome.errorCode ?? 'internal' };
    }
    return { ok: true, newEntries: 0 };
  } catch (err) {
    return { ok: false, newEntries: 0, errorCode: classifyRejection(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function createSubscriptionRoutes(deps?: Partial<SubscriptionDeps>): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const random = deps?.random ?? (() => Math.random());
  const timeoutMs = deps?.firstFetchTimeoutMs ?? FIRST_FETCH_TIMEOUT_MS;
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const items = await listSubscriptions(new Db(c.env.DB), c.get('session').user.id);
    return c.json<SubscriptionsResponse>({ items });
  });

  app.post('/', async (c) => {
    const userId = c.get('session').user.id;
    const db = new Db(c.env.DB);

    const body = await parseBody(c, subscribeRequestSchema);
    if (body instanceof Response) return body;

    let feedUrl: string;
    try {
      feedUrl = canonicalizeUrl(body.url);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return fail(c, 400, 'validation_failed', err.message, { field: 'url' });
    }

    let policy;
    try {
      policy = resolveFetchPolicy(c.env);
    } catch (err) {
      if (!(err instanceof FetchConfigError)) throw err;
      return fail(c, 500, 'config_error', 'Server configuration error');
    }

    // The address rules run before anything is looked up or created (AC6).
    const check = checkUrl(feedUrl, policy.appOrigin, policy.allowHosts);
    if (!check.ok) {
      return check.code === 'blocked_address'
        ? fail(c, 422, 'blocked_address', fixedMessage('blocked_address'))
        : fail(c, 400, 'validation_failed', fixedMessage('invalid_url'), {
            field: 'url',
          });
    }

    // Another user's folder is "not found", exactly like one that does not exist (spec §10.8).
    const folderId = body.folderId ?? null;
    if (folderId !== null && !(await folderBelongsToUser(db, userId, folderId))) {
      return fail(c, 404, 'not_found', 'Not found');
    }

    if ((await countSubscriptions(db, userId)) >= SUBSCRIPTION_LIMIT) return limitReached(c);

    const alreadyHave = (id: string) =>
      fail(c, 409, 'already_subscribed', 'You already follow this feed', {
        subscriptionId: id,
      } satisfies AlreadySubscribedDetails);

    const existingId = await findSubscriptionIdByFeedUrl(db, userId, feedUrl);
    if (existingId) return alreadyHave(existingId);

    // A feed we already know is a feed: no discovery fetch. Otherwise look at what the URL serves.
    if ((await findFeedByUrl(db, feedUrl)) === null) {
      const resolution = await resolveFeedUrl(feedUrl, {
        fetch: deps?.fetch ?? ((input, init) => fetch(input, init)),
        appOrigin: policy.appOrigin,
        allowHosts: policy.allowHosts,
        ...(deps?.discover ? { discover: deps.discover } : {}),
      });
      switch (resolution.kind) {
        case 'blocked':
          return fail(c, 422, 'blocked_address', fixedMessage('blocked_address'));
        case 'none':
          return fail(c, 422, 'no_feed_found', "We couldn't find a feed at that address.");
        case 'choice':
          return fail(c, 422, 'feed_choice_required', 'This site has more than one feed', {
            candidates: resolution.candidates,
          } satisfies FeedChoiceDetails);
        case 'feed':
          feedUrl = resolution.url;
      }
      // Discovery can lead to a feed the person already follows.
      const viaPage = await findSubscriptionIdByFeedUrl(db, userId, feedUrl);
      if (viaPage) return alreadyHave(viaPage);
    }

    const now = nowSeconds(clock);
    const before = await findFeedByUrl(db, feedUrl);
    const subscriptionId = newId();
    const created = await createSubscription(db, {
      userId,
      subscriptionId,
      feedUrl,
      folderId,
      titleOverride: body.title ?? null,
      now,
      jitterS: Math.floor(random() * 60),
      limit: SUBSCRIPTION_LIMIT,
    });
    if (!created) {
      // Lost a race with ourselves, or hit the limit between the check and the insert.
      const raced = await findSubscriptionIdByFeedUrl(db, userId, feedUrl);
      return raced ? alreadyHave(raced) : limitReached(c);
    }

    const feed = await findFeedByUrl(db, feedUrl);
    if (!feed) throw new Error('feed missing after subscribe');

    // FR-SU-2: a feed fetched in the last 30 minutes is not fetched again; the newest entries
    // were linked above. Anything else is fetched now, by the refresher.
    const fresh =
      before !== null &&
      before.last_success_at !== null &&
      now - before.last_success_at < FRESH_FEED_SECONDS;
    let outcome: SubscribeFetchOutcome = { ok: true, newEntries: 0 };
    if (!fresh) {
      const refresh =
        deps?.refresh ??
        ((job: RefreshJob) => {
          const exported = c.executionCtx.exports as unknown as { FeedRefresher: FeedRefresher };
          return exported.FeedRefresher.refresh(job);
        });
      outcome = await firstFetch(() => refresh(jobFor(feed)), timeoutMs);
    }
    outcome.newEntries = await countUserEntriesForFeed(db, userId, feed.id);

    const row = await getSubscription(db, userId, subscriptionId);
    if (!row) throw new Error('subscription missing after subscribe');
    return c.json<SubscribeResponse>({ subscription: row.subscription, fetch: outcome }, 201);
  });

  return app;
}

function limitReached(c: Context<AppEnv>): Response {
  return fail(
    c,
    422,
    'limit_reached',
    `You've reached the limit of ${SUBSCRIPTION_LIMIT.toLocaleString('en-US')} feeds.`,
  );
}

export function createFolderRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const items = await listFolders(new Db(c.env.DB), c.get('session').user.id);
    return c.json<FoldersResponse>({ items });
  });
  return app;
}
