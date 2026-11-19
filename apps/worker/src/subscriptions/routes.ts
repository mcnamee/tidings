/**
 * `/api/folders` and `/api/subscriptions`, spec §8.4: folder list, create, rename and delete;
 * subscription list, subscribe, edit and unsubscribe (TID-013, TID-014). Refresh is TID-015.
 *
 * Subscribe (spec §7.5, FR-SU-1 to FR-SU-4, FR-SU-7, FR-SU-8): canonicalise, check the address,
 * find the feed, upsert it and the subscription in one batch, then *await* the `FeedRefresher`
 * entrypoint (10 s) so the first fetch has its own invocation and CPU budget.
 */
import { Hono, type Context } from 'hono';
import {
  FOLDER_LIMIT,
  SUBSCRIPTION_LIMIT,
  feedErrorMessage,
  type Folder,
  type AlreadySubscribedDetails,
  type ChangeFeedUrlResponse,
  type FeedChoiceDetails,
  type FoldersResponse,
  type SubscribeFetchOutcome,
  type SubscribeResponse,
  type Subscription,
  type SubscriptionsResponse,
} from '@tidings/shared';
import {
  changeFeedUrlRequestSchema,
  folderRequestSchema,
  subscribeRequestSchema,
  updateSubscriptionRequestSchema,
} from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { parseBody } from '../auth/routes';
import {
  Db,
  canonicalizeUrl,
  changeSubscriptionFeed,
  countSubscriptions,
  countUserEntriesForFeed,
  createFolder,
  createSubscription,
  deleteFolder,
  deleteSubscription,
  findFeedByUrl,
  findSubscriptionIdByFeedUrl,
  folderBelongsToUser,
  getSubscription,
  listFolders,
  listSubscriptions,
  newId,
  nowSeconds,
  renameFolder,
  systemClock,
  updateSubscription,
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
    recentKeys: feed.recent_keys,
    newEntriesDay: feed.new_entries_day,
    newEntriesCount: feed.new_entries_count,
    warningCode: feed.warning_code,
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

  type Policy = ReturnType<typeof resolveFetchPolicy>;

  const vetAddress = (
    c: Context<AppEnv>,
    raw: string,
  ): { feedUrl: string; policy: Policy } | Response => {
    let feedUrl: string;
    try {
      feedUrl = canonicalizeUrl(raw);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return fail(c, 400, 'validation_failed', err.message, { field: 'url' });
    }
    let policy: Policy;
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
        : fail(c, 400, 'validation_failed', fixedMessage('invalid_url'), { field: 'url' });
    }
    return { feedUrl, policy };
  };

  /** Looks at what the address serves: the feed URL, or a failure response with fixed copy. */
  const discoverFeed = async (
    c: Context<AppEnv>,
    feedUrl: string,
    policy: Policy,
  ): Promise<string | Response> => {
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
        return resolution.url;
    }
  };

  /**
   * FR-SU-2: a feed fetched in the last 30 minutes is not fetched again; the newest entries were
   * linked with the subscription. Anything else is fetched now, by the refresher.
   */
  const firstFetchFor = async (
    c: Context<AppEnv>,
    db: Db,
    userId: string,
    feed: FeedRow,
    before: FeedRow | null,
    now: number,
  ): Promise<SubscribeFetchOutcome> => {
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
    return outcome;
  };

  app.get('/', async (c) => {
    const items = await listSubscriptions(new Db(c.env.DB), c.get('session').user.id);
    return c.json<SubscriptionsResponse>({ items });
  });

  app.post('/', async (c) => {
    const userId = c.get('session').user.id;
    const db = new Db(c.env.DB);

    const body = await parseBody(c, subscribeRequestSchema);
    if (body instanceof Response) return body;

    const vetted = vetAddress(c, body.url);
    if (vetted instanceof Response) return vetted;
    let feedUrl = vetted.feedUrl;
    const policy = vetted.policy;

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
      const found = await discoverFeed(c, feedUrl, policy);
      if (found instanceof Response) return found;
      feedUrl = found;
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

    const outcome = await firstFetchFor(c, db, userId, feed, before, now);

    const row = await getSubscription(db, userId, subscriptionId);
    if (!row) throw new Error('subscription missing after subscribe');
    return c.json<SubscribeResponse>({ subscription: row.subscription, fetch: outcome }, 201);
  });

  app.patch('/:id', async (c) => {
    const userId = c.get('session').user.id;
    const db = new Db(c.env.DB);
    const id = c.req.param('id');
    const body = await parseBody(c, updateSubscriptionRequestSchema);
    if (body instanceof Response) return body;
    // Both IDs resolve against the caller's rows only: A's folder is "not found" for B (§10.8).
    if (body.folderId != null && !(await folderBelongsToUser(db, userId, body.folderId))) {
      return fail(c, 404, 'not_found', 'Not found');
    }
    const found = await updateSubscription(db, userId, id, {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.folderId === undefined ? {} : { folderId: body.folderId }),
    });
    const row = found ? await getSubscription(db, userId, id) : null;
    if (!row) return fail(c, 404, 'not_found', 'Not found');
    return c.json<Subscription>(row.subscription);
  });

  /**
   * TID-068: change the feed address of a subscription. Same address rules, discovery and fixed
   * errors as subscribe. The subscription keeps its id, title, folder and created date; the old
   * shared feed row is untouched (other users may follow it).
   */
  app.post('/:id/url', async (c) => {
    const userId = c.get('session').user.id;
    const db = new Db(c.env.DB);
    const id = c.req.param('id');

    const body = await parseBody(c, changeFeedUrlRequestSchema);
    if (body instanceof Response) return body;
    // Another user's subscription is "not found", before any address is looked at (spec 10.8).
    const current = await getSubscription(db, userId, id);
    if (!current) return fail(c, 404, 'not_found', 'Not found');

    const vetted = vetAddress(c, body.url);
    if (vetted instanceof Response) return vetted;
    let feedUrl = vetted.feedUrl;

    const alreadyHave = (other: string) =>
      fail(c, 409, 'already_subscribed', 'You already follow this feed', {
        subscriptionId: other,
      } satisfies AlreadySubscribedDetails);
    /** The same feed (no-op success), another subscription of theirs (409), or null. */
    const sameOrOther = async (url: string): Promise<Response | null> => {
      if (url === current.subscription.feedUrl) return unchanged(c, db, userId, current);
      const other = await findSubscriptionIdByFeedUrl(db, userId, url);
      return other && other !== id ? alreadyHave(other) : null;
    };

    const early = await sameOrOther(feedUrl);
    if (early) return early;

    if ((await findFeedByUrl(db, feedUrl)) === null) {
      const found = await discoverFeed(c, feedUrl, vetted.policy);
      if (found instanceof Response) return found;
      feedUrl = found;
      const viaPage = await sameOrOther(feedUrl);
      if (viaPage) return viaPage;
    }

    const now = nowSeconds(clock);
    const before = await findFeedByUrl(db, feedUrl);
    const moved = await changeSubscriptionFeed(db, {
      userId,
      subscriptionId: id,
      feedUrl,
      fromFeedId: current.feedId,
      now,
      jitterS: Math.floor(random() * 60),
    });
    if (!moved) {
      // Lost a race: the subscription changed or went, or the new feed was followed meanwhile.
      const raced = await findSubscriptionIdByFeedUrl(db, userId, feedUrl);
      return raced && raced !== id ? alreadyHave(raced) : fail(c, 404, 'not_found', 'Not found');
    }

    const feed = await findFeedByUrl(db, feedUrl);
    if (!feed) throw new Error('feed missing after change');
    const outcome = await firstFetchFor(c, db, userId, feed, before, now);
    const row = await getSubscription(db, userId, id);
    if (!row) throw new Error('subscription missing after change');
    return c.json<ChangeFeedUrlResponse>({
      subscription: row.subscription,
      fetch: outcome,
      changed: true,
    });
  });

  async function unchanged(
    c: Context<AppEnv>,
    db: Db,
    userId: string,
    current: { subscription: Subscription; feedId: number },
  ): Promise<Response> {
    const newEntries = await countUserEntriesForFeed(db, userId, current.feedId);
    return c.json<ChangeFeedUrlResponse>({
      subscription: current.subscription,
      fetch: { ok: true, newEntries },
      changed: false,
    });
  }

  app.delete('/:id', async (c) => {
    const deleted = await deleteSubscription(
      new Db(c.env.DB),
      c.get('session').user.id,
      c.req.param('id'),
    );
    return deleted ? c.body(null, 204) : fail(c, 404, 'not_found', 'Not found');
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

export function createFolderRoutes(deps?: { clock?: Clock }): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const items = await listFolders(new Db(c.env.DB), c.get('session').user.id);
    return c.json<FoldersResponse>({ items });
  });

  app.post('/', async (c) => {
    const body = await parseBody(c, folderRequestSchema);
    if (body instanceof Response) return body;
    const result = await createFolder(new Db(c.env.DB), c.get('session').user.id, {
      id: newId(),
      name: body.name,
      now: nowSeconds(clock),
    });
    if (result.ok) return c.json<Folder>(result.folder, 201);
    return result.reason === 'limit_reached'
      ? fail(c, 422, 'limit_reached', `You've reached the limit of ${FOLDER_LIMIT} folders.`)
      : fail(c, 409, 'conflict', 'A folder with that name already exists');
  });

  app.patch('/:id', async (c) => {
    const body = await parseBody(c, folderRequestSchema);
    if (body instanceof Response) return body;
    const result = await renameFolder(
      new Db(c.env.DB),
      c.get('session').user.id,
      c.req.param('id'),
      body.name,
    );
    if (result.ok) return c.json<Folder>(result.folder);
    return result.reason === 'conflict'
      ? fail(c, 409, 'conflict', 'A folder with that name already exists')
      : fail(c, 404, 'not_found', 'Not found');
  });

  app.delete('/:id', async (c) => {
    const deleted = await deleteFolder(
      new Db(c.env.DB),
      c.get('session').user.id,
      c.req.param('id'),
    );
    return deleted ? c.body(null, 204) : fail(c, 404, 'not_found', 'Not found');
  });

  return app;
}
