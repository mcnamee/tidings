/**
 * `GET /api/entries` and `GET /api/counts` (spec 8.5, 8.6). Read only: neither route fetches a
 * feed (FR-RD-11). Read-state writes and `GET /api/entries/:id` belong to TID-019 and TID-020.
 */
import { Hono } from 'hono';
import type { ApiError, Counts, EntriesResponse, EntrySummary } from '@tidings/shared';
import { entriesQuerySchema } from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import {
  Db,
  feedIdForSubscription,
  folderBelongsToUser,
  labelsForFeeds,
  listEntries,
  nowSeconds,
  systemClock,
  toIso,
  unreadCounts,
  ValidationError,
  type Clock,
} from '../db';

export interface EntryDeps {
  clock: Clock;
}

export function createEntryRoutes(deps?: Partial<EntryDeps>): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { user } = c.get('session');
    const db = new Db(c.env.DB);

    const parsed = entriesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const body: ApiError = {
        error: {
          code: 'validation_failed',
          message: 'Invalid request',
          details: parsed.error.issues,
        },
      };
      return c.json(body, 400);
    }
    const q = parsed.data;

    // The state defaults to the user's setting (spec 6.2: `unreadOnly`, default true).
    const unreadOnly = q.state ? q.state === 'unread' : user.settings.unreadOnly !== false;

    // An ID that is not the caller's is "not found", exactly like one that does not exist (8.1).
    let id: string | number | undefined;
    if (q.view === 'folder') {
      if (!(await folderBelongsToUser(db, user.id, q.id ?? ''))) {
        return fail(c, 404, 'not_found', 'Not found');
      }
      id = q.id;
    } else if (q.view === 'feed') {
      const feedId = await feedIdForSubscription(db, user.id, q.id ?? '');
      if (feedId === null) return fail(c, 404, 'not_found', 'Not found');
      id = feedId;
    }

    const asOf = toIso(nowSeconds(clock));
    let page;
    try {
      page = await listEntries(db, user.id, {
        view: q.view,
        ...(id === undefined ? {} : { id }),
        unreadOnly,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return fail(c, 400, 'validation_failed', err.message, err.details);
    }

    const labels = await labelsForFeeds(
      db,
      user.id,
      page.items.map((r) => r.feed_id),
    );
    const items: EntrySummary[] = [];
    for (const r of page.items) {
      const label = labels.get(r.feed_id);
      // A user_entries row whose subscription is gone is not shown (it is cleaned up on unsubscribe).
      if (!label) continue;
      items.push({
        id: String(r.entry_id),
        subscriptionId: label.subscriptionId,
        feedTitle: label.title,
        title: r.title,
        author: r.author,
        url: r.url,
        summary: r.summary,
        imageUrl: r.image_url,
        publishedAt: toIso(r.published_at),
        isRead: r.is_read === 1,
        isStarred: r.is_starred === 1,
      });
    }
    return c.json<EntriesResponse>({ items, nextCursor: page.nextCursor, asOf });
  });

  return app;
}

export function createCountsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const { counts } = await unreadCounts(new Db(c.env.DB), c.get('session').user.id);
    return c.json<Counts>(counts);
  });
  return app;
}
