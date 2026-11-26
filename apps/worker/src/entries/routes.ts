/**
 * `GET /api/entries`, `GET /api/counts` (TID-018) and the single-entry read and read-state writes
 * (TID-019) and mark all as read (TID-020), spec 8.5, 8.6. None of them fetches a feed (FR-RD-11).
 */
import { Hono, type Context } from 'hono';
import type {
  ApiError,
  Counts,
  EngagementResponse,
  EntriesResponse,
  Entry,
  EntrySort,
  EntrySummary,
  MarkAllReadResponse,
  SortNote,
  ReadStateResponse,
} from '@tidings/shared';
import {
  engagementRequestSchema,
  entriesQuerySchema,
  markAllReadRequestSchema,
  patchEntryRequestSchema,
  readStateRequestSchema,
} from '@tidings/shared/schemas';
import { MARK_ALL_UNDO_MAX } from '@tidings/shared';
import { parseBody } from '../auth/routes';
import { listRecommended, loadProfile } from '../recommend/rank';
import { profileReady } from '../recommend/score';
import { decodeProfile } from '../recommend/vector';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import {
  Db,
  feedIdForSubscription,
  folderBelongsToUser,
  fromIso,
  getEntry,
  labelsForFeeds,
  listEntries,
  markAllRead,
  nowSeconds,
  parseEntryId,
  recordEngagement,
  setRead,
  setReadMany,
  systemClock,
  toIso,
  unreadCounts,
  ValidationError,
  type Clock,
  type EntrySummaryRow,
  type FeedLabel,
} from '../db';
import { topicSlugs } from '../recommend/topics';

export interface EntryDeps {
  clock: Clock;
}

function summaryOf(r: EntrySummaryRow, label: FeedLabel): EntrySummary {
  return {
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
    topics: topicSlugs(r.topics),
  };
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
    // TID-067: `recommended` applies to unread lists with a ready profile, else newest first.
    let sort: EntrySort = 'newest';
    let sortNote: SortNote | undefined;
    let profile: { vec: string; signals: number } | null = null;
    if (q.sort === 'recommended' && unreadOnly) {
      profile = await loadProfile(db, user.id);
      if (profile && profileReady(profile.signals) && decodeProfile(profile.vec))
        sort = 'recommended';
      else sortNote = c.env.AI ? 'cold_start' : 'unavailable';
    }
    let page;
    try {
      const base = {
        view: q.view,
        ...(id === undefined ? {} : { id }),
        limit: q.limit,
        cursor: q.cursor ?? null,
      };
      page =
        sort === 'recommended' && profile
          ? await listRecommended(db, user.id, {
              ...base,
              profile: profile.vec,
              now: nowSeconds(clock),
            })
          : await listEntries(db, user.id, { ...base, unreadOnly });
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
      items.push(summaryOf(r, label));
    }
    return c.json<EntriesResponse>({
      items,
      nextCursor: page.nextCursor,
      asOf,
      sort,
      ...(sortNote ? { sortNote } : {}),
    });
  });

  // An ID that is not the caller's, or not an ID at all, is "not found" (8.1, 10.8).
  async function loadEntry(c: Context<AppEnv>, raw: string) {
    const { user } = c.get('session');
    const db = new Db(c.env.DB);
    const id = parseEntryId(raw);
    const row = id === null ? null : await getEntry(db, user.id, id);
    const label = row ? (await labelsForFeeds(db, user.id, [row.feed_id])).get(row.feed_id) : null;
    return row && label ? { row, label } : null;
  }

  app.get('/:id', async (c) => {
    const found = await loadEntry(c, c.req.param('id'));
    if (!found) return fail(c, 404, 'not_found', 'Not found');
    return c.json<Entry>({
      ...summaryOf(found.row, found.label),
      contentHtml: found.row.content_html,
    });
  });

  // Costs at most one user_entries row (plus its index rows), and nothing when the state is
  // already what was asked for (spec 9.4).
  app.patch('/:id', async (c) => {
    const body = await parseBody(c, patchEntryRequestSchema);
    if (body instanceof Response) return body;
    const { user } = c.get('session');
    const id = parseEntryId(c.req.param('id'));
    if (id === null) return fail(c, 404, 'not_found', 'Not found');
    const db = new Db(c.env.DB);
    await setRead(db, user.id, id, body.isRead, nowSeconds(clock));
    const found = await loadEntry(c, c.req.param('id'));
    if (!found) return fail(c, 404, 'not_found', 'Not found');
    return c.json<EntrySummary>(summaryOf(found.row, found.label));
  });

  // ADR 0018: at most one row written per signal, and nothing for a repeat. An entry that is not the
  // caller's, or not an entry at all, is "not found" (8.1).
  app.post('/:id/engagement', async (c) => {
    const body = await parseBody(c, engagementRequestSchema);
    if (body instanceof Response) return body;
    const { user } = c.get('session');
    const id = parseEntryId(c.req.param('id'));
    if (id === null) return fail(c, 404, 'not_found', 'Not found');
    const result = await recordEngagement(
      new Db(c.env.DB),
      user.id,
      id,
      body.kind,
      nowSeconds(clock),
    );
    if (!result) return fail(c, 404, 'not_found', 'Not found');
    return c.json<EngagementResponse>({ recorded: result.recorded });
  });

  app.post('/read-state', async (c) => {
    const body = await parseBody(c, readStateRequestSchema);
    if (body instanceof Response) return body;
    const { user } = c.get('session');
    // IDs that are not integers can match nothing; IDs that are not the caller's change nothing.
    const ids = body.entryIds.flatMap((raw) => parseEntryId(raw) ?? []);
    const { updated } =
      ids.length === 0
        ? { updated: 0 }
        : await setReadMany(new Db(c.env.DB), user.id, ids, body.isRead, nowSeconds(clock));
    return c.json<ReadStateResponse>({ updated });
  });

  // FR-RD-9: one UPDATE scoped to the caller, the view and `published_at <= before`, touching only
  // unread rows (spec 9.4). A folder or subscription that is not the caller's is "not found".
  app.post('/mark-all-read', async (c) => {
    const body = await parseBody(c, markAllReadRequestSchema);
    if (body instanceof Response) return body;
    const { user } = c.get('session');
    const db = new Db(c.env.DB);
    let id: string | number | undefined;
    if (body.view === 'folder') {
      if (!(await folderBelongsToUser(db, user.id, body.id ?? ''))) {
        return fail(c, 404, 'not_found', 'Not found');
      }
      id = body.id;
    } else if (body.view === 'feed') {
      const feedId = await feedIdForSubscription(db, user.id, body.id ?? '');
      if (feedId === null) return fail(c, 404, 'not_found', 'Not found');
      id = feedId;
    }
    const { entryIds } = await markAllRead(
      db,
      user.id,
      body.view,
      id,
      fromIso(body.before),
      nowSeconds(clock),
    );
    return c.json<MarkAllReadResponse>({
      updated: entryIds.length,
      entryIds: entryIds.length <= MARK_ALL_UNDO_MAX ? entryIds.map(String) : null,
    });
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
