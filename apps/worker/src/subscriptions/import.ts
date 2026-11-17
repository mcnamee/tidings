/**
 * `POST /api/import/opml` (spec 8.7, FR-OP-1 to FR-OP-4, ADR 0013 decision 5).
 *
 * The browser parses the file; this route receives up to 100 feeds. Nothing is fetched here
 * (FR-OP-3): the feeds are inserted as `pending`, due at staggered times (20 a minute), and the
 * dispatcher fetches them. At most 250 first fetches are scheduled per UTC day; the rest start
 * from 00:05 UTC the next day and are reported as `deferred`.
 */
import { Hono } from 'hono';
import {
  IMPORT_FIRST_FETCH_DAILY_CAP,
  SUBSCRIPTION_LIMIT,
  type ImportInvalidReason,
  type ImportOpmlResponse,
} from '@tidings/shared';
import { importOpmlRequestSchema } from '@tidings/shared/schemas';
import { fail } from '../api/respond';
import type { AppEnv } from '../api/security';
import { parseBody } from '../auth/routes';
import {
  Db,
  countSubscriptions,
  newId,
  nowSeconds,
  systemClock,
  tryCanonicalizeUrl,
  type Clock,
} from '../db';
import {
  ensureFolders,
  folderKey,
  insertImported,
  knownFeeds,
  scheduledFirstFetches,
  subscribedUrls,
  type ImportRow,
} from '../db/import';
import { checkUrl, FetchConfigError, resolveFetchPolicy } from '../fetch';
import { PARKED_AT } from '../refresh/backoff';
import { REFRESH_BATCH_SIZE } from '../refresh/dispatcher';

const DAY_S = 86400;
/** ADR 0013: deferred feeds start at 00:05 UTC. */
const DEFERRED_START_S = 300;

export interface ImportDeps {
  clock: Clock;
  /** Returns a value in [0, 1). Used for the in-minute jitter of `next_fetch_at`. */
  random: () => number;
}

export function createImportRoutes(deps?: Partial<ImportDeps>): Hono<AppEnv> {
  const clock = deps?.clock ?? systemClock;
  const random = deps?.random ?? (() => Math.random());
  const app = new Hono<AppEnv>();

  app.post('/opml', async (c) => {
    const userId = c.get('session').user.id;
    const db = new Db(c.env.DB);
    const body = await parseBody(c, importOpmlRequestSchema);
    if (body instanceof Response) return body;

    let policy;
    try {
      policy = resolveFetchPolicy(c.env);
    } catch (err) {
      if (!(err instanceof FetchConfigError)) throw err;
      return fail(c, 500, 'config_error', 'Server configuration error');
    }

    // Validate every feed first (AC6): canonical form, then the address rules. The first
    // occurrence of a URL wins, so the first folder wins (FR-OP-2).
    const invalid: ImportOpmlResponse['invalid'] = [];
    const wanted = new Map<string, { folder: string | null; title: string | null }>();
    const consider = (
      feed: { xmlUrl: string; title?: string | undefined },
      folder: string | null,
    ) => {
      const reject = (reason: ImportInvalidReason) =>
        void invalid.push({ url: feed.xmlUrl.slice(0, 2048), reason });
      const url = tryCanonicalizeUrl(feed.xmlUrl);
      if (url === null) return reject('invalid_url');
      const check = checkUrl(url, policy.appOrigin, policy.allowHosts);
      if (!check.ok) return reject(check.code ?? 'invalid_url');
      if (!wanted.has(url)) wanted.set(url, { folder, title: feed.title || null });
    };
    const folderNames: string[] = [];
    for (const folder of body.folders) {
      const name = folder.name === '' ? null : folder.name;
      if (name !== null) folderNames.push(name);
      for (const feed of folder.feeds) consider(feed, name);
    }
    for (const feed of body.feeds) consider(feed, null);

    const now = nowSeconds(clock);
    const urls = [...wanted.keys()];
    const subscribed = await subscribedUrls(db, userId, urls);
    const fresh = urls.filter((u) => !subscribed.has(u));

    // The 1,000-subscription limit (FR-SU-7): what does not fit is reported, the rest imports.
    const room = Math.max(0, SUBSCRIPTION_LIMIT - (await countSubscriptions(db, userId)));
    for (const url of fresh.slice(room)) invalid.push({ url, reason: 'limit_reached' });
    const importing = fresh.slice(0, room);

    const folders = await ensureFolders(db, userId, folderNames, now, newId);
    const known = await knownFeeds(db, importing);

    // ADR 0013 decision 5: 250 first fetches per UTC day, 20 a minute, the rest on later days.
    const today = Math.floor(now / DAY_S);
    const counts = await scheduledFirstFetches(db, userId, today * DAY_S);
    let deferred = 0;
    const rows: ImportRow[] = importing.map((url) => {
      const want = wanted.get(url);
      const feed = known.get(url);
      const needsFetch =
        !feed || feed.nextFetchAt >= PARKED_AT || feed.state === 'dead' || feed.state === 'gone';
      let nextFetchAt: number | null = null;
      if (needsFetch) {
        let day = today;
        while ((counts.get(day) ?? 0) >= IMPORT_FIRST_FETCH_DAILY_CAP) day += 1;
        const slot = counts.get(day) ?? 0;
        counts.set(day, slot + 1);
        const base = day === today ? now : day * DAY_S + DEFERRED_START_S;
        nextFetchAt = base + Math.floor(slot / REFRESH_BATCH_SIZE) * 60 + Math.floor(random() * 60);
        if (day > today) deferred += 1;
      }
      return {
        subscriptionId: newId(),
        url,
        folderId: want?.folder ? (folders.get(folderKey(want.folder)) ?? null) : null,
        titleOverride: want?.title ?? null,
        nextFetchAt,
        isNewFeed: !feed,
      };
    });

    const created = await insertImported(db, { userId, now, limit: SUBSCRIPTION_LIMIT, rows });
    return c.json<ImportOpmlResponse>({
      created,
      existing: subscribed.size,
      deferred,
      invalid,
    });
  });

  return app;
}
