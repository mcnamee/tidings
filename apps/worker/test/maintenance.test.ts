import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Db, sql, type Meta, type Statement } from '../src/db';
import { CHUNK, MAX_STATEMENTS, runMaintenance, type MaintenanceSummary } from '../src/maintenance';
import { handleScheduled, MAINTENANCE_CRON } from '../src/refresh/scheduled';
import {
  count,
  createFixture,
  db,
  FEED_URL,
  items,
  jobFor,
  resetData,
  rss,
  seedFeed,
  seedUser,
} from './support/refresh-harness';
import { refreshFeed } from '../src/refresh';

// TID-021 against a real (local) D1 in workerd with a fixed clock.
const DAY = 86_400;
// 2026-11-20 12:00:00 UTC. A run at 03:17 uses NOW_0317.
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const NOW_0317 = Date.UTC(2026, 10, 20, 3, 17, 0) / 1000;
const ago = (days: number, from = NOW) => from - days * DAY;

interface Run {
  summary: MaintenanceSummary;
  /** `changes` of every write statement, in order. */
  changes: number[];
  lines: Record<string, unknown>[];
}

async function run(at = NOW): Promise<Run> {
  const changes: number[] = [];
  const lines: Record<string, unknown>[] = [];
  const counting = new (class extends Db {
    override async run(s: Statement): Promise<Meta> {
      const meta = await super.run(s);
      changes.push(meta.changes);
      return meta;
    }
    override async all<T>(s: Statement) {
      const r = await super.all<T>(s);
      changes.push(r.meta.changes);
      return r;
    }
  })(env.DB);
  const summary = await runMaintenance({
    db: counting,
    clock: () => at * 1000,
    log: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { summary, changes, lines };
}

async function reset(): Promise<void> {
  await resetData();
  for (const t of ['sessions', 'webauthn_challenges', 'rate_limits', 'magic_links']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
}

let nextEntry = 1;

/** An entry (feed 1 is created on demand) with optional user_entries rows. */
async function entry(o: {
  published: number;
  purgedAt?: number | null;
  content?: boolean;
  refs?: { user?: string; read?: boolean; starred?: boolean }[];
  feed?: number;
}): Promise<number> {
  const id = nextEntry++;
  const feed = o.feed ?? 1;
  await db.run(
    sql(
      `INSERT OR IGNORE INTO feeds (id, url, next_fetch_at, last_attempt_at, created_at)
       VALUES (?, ?, 0, ?, 0)`,
      feed,
      `https://f${feed}.example.com/rss`,
      NOW,
    ),
  );
  await db.run(
    sql(
      `INSERT INTO entries (id, feed_id, guid_hash, summary, content_html, published_at, fetched_at, purged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      feed,
      `g${id}`,
      o.content === false ? null : 'sum',
      o.content === false ? null : '<p>body</p>',
      o.published,
      o.published,
      o.purgedAt ?? null,
    ),
  );
  for (const r of o.refs ?? []) {
    const user = r.user ?? 'u1';
    await db.run(
      sql(
        'INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, 0)',
        user,
        user,
      ),
    );
    await db.run(
      sql(
        `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, is_starred)
         VALUES (?, ?, ?, ?, ?, ?)`,
        user,
        id,
        feed,
        o.published,
        r.read ? 1 : 0,
        r.starred ? 1 : 0,
      ),
    );
  }
  return id;
}

async function exists(table: string, where: string, ...p: (string | number)[]) {
  return (await count(table, where, ...p)) > 0;
}

/** Bulk-inserts `n` entries, each with one user_entries row for u1. */
async function bulkUserEntries(n: number, published: number, read: boolean): Promise<void> {
  await db.run(
    sql(
      "INSERT OR IGNORE INTO feeds (id, url, next_fetch_at, last_attempt_at, created_at) VALUES (1, 'https://f1.example.com/rss', 0, ?, 0)",
      NOW,
    ),
  );
  await db.run(
    sql("INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES ('u1', 'u1', 0)"),
  );
  const base = nextEntry;
  nextEntry += n;
  await db.run(
    sql(
      `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
       INSERT INTO entries (id, feed_id, guid_hash, summary, content_html, published_at, fetched_at)
       SELECT ? + i, 1, 'b' || (? + i), 's', 'c', ?, ? FROM s`,
      n - 1,
      base,
      base,
      published,
      published,
    ),
  );
  await db.run(
    sql(
      `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read)
       SELECT 'u1', id, 1, published_at, ? FROM entries WHERE id >= ? AND id < ?`,
      read ? 1 : 0,
      base,
      base + n,
    ),
  );
}

beforeEach(reset);

describe('AC1: retention of user_entries', () => {
  it('deletes read items past 30 days and unread past 90, keeps newer and starred', async () => {
    const keep = async (o: Parameters<typeof entry>[0]) => entry(o);
    const readOld = await entry({ published: ago(31), refs: [{ read: true }] });
    const readNew = await keep({ published: ago(29), refs: [{ read: true }] });
    const readStarred = await keep({ published: ago(200), refs: [{ read: true, starred: true }] });
    const unreadMid = await keep({ published: ago(89), refs: [{ read: false }] });
    const unreadOld = await entry({ published: ago(91), refs: [{ read: false }] });
    const unreadStarred = await keep({
      published: ago(300),
      refs: [{ read: false, starred: true }],
    });

    const { summary } = await run();

    expect(summary.readDeleted).toBe(1);
    expect(summary.unreadDeleted).toBe(1);
    const has = (id: number) => exists('user_entries', 'entry_id = ?', id);
    expect(await has(readOld)).toBe(false);
    expect(await has(unreadOld)).toBe(false);
    for (const id of [readNew, readStarred, unreadMid, unreadStarred]) {
      expect(await has(id)).toBe(true);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    await entry({ published: ago(40), refs: [{ read: true }] });
    await run();
    const again = await run();
    expect(again.summary.readDeleted + again.summary.entriesPurged).toBe(0);
    expect(again.changes.every((c) => c === 0)).toBe(true);
  });
});

describe('AC2: purge of unreferenced entries', () => {
  it('nulls content and summary and sets purged_at; keeps the row; leaves referenced ones', async () => {
    const orphan = await entry({ published: ago(31) });
    const young = await entry({ published: ago(29) });
    const starred = await entry({ published: ago(31), refs: [{ read: true, starred: true }] });
    // Unreferenced only because retention removes the last reference in the same run.
    const afterRetention = await entry({ published: ago(40), refs: [{ read: true }] });

    const { summary } = await run();

    expect(summary.entriesPurged).toBe(2);
    const row = await db.first<{
      content_html: string | null;
      summary: string | null;
      purged_at: number | null;
      title: string | null;
    }>(sql('SELECT content_html, summary, purged_at, title FROM entries WHERE id = ?', orphan));
    expect(row).toEqual({ content_html: null, summary: null, purged_at: NOW, title: null });
    expect(await exists('entries', 'id = ? AND purged_at = ?', afterRetention, NOW)).toBe(true);
    expect(await exists('entries', 'id = ? AND purged_at IS NULL', young)).toBe(true);
    expect(await exists('entries', 'id = ? AND purged_at IS NULL', starred)).toBe(true);
  });
});

describe('AC2: the daily sweep and the bounded hourly scan', () => {
  it('finds an orphan behind 600 old referenced entries only on the 03:17 run', async () => {
    await bulkUserEntries(600, ago(300), false); // made read and starred below
    await env.DB.exec('UPDATE user_entries SET is_starred = 1, is_read = 1');
    const orphan = await entry({ published: ago(31) });

    const hourly = await run(NOW);
    expect(hourly.summary.entriesPurged).toBe(0);
    // Window of 500 candidates plus one probe each; nothing grows with the 600.
    expect(hourly.summary.rowsRead).toBeLessThan(1_300);

    const daily = await run(NOW_0317);
    expect(daily.summary.entriesPurged).toBe(1);
    expect(await exists('entries', 'id = ? AND purged_at IS NOT NULL', orphan)).toBe(true);
  });
});

describe('AC3: a purged entry is not resurrected by a refresh', () => {
  it('does not re-insert it or create user_entries', async () => {
    const fx = createFixture();
    const id = await seedFeed({ url: FEED_URL, subscribers: ['u1'] });
    const feed = fx.fake.serveFeed(FEED_URL, rss(items(1, 3)), { etag: '"v1"' });
    await refreshFeed(await jobFor(id), fx.deps);
    expect(await count('entries', 'feed_id = ?', id)).toBe(3);

    // The reader lets go of all three (e.g. unsubscribed and resubscribed), 40 days pass.
    await env.DB.exec('DELETE FROM user_entries');
    const later = Math.floor(fx.clock.now() / 1000) + 40 * DAY;
    const { summary } = await run(later);
    expect(summary.entriesPurged).toBe(3);

    // The feed still lists g1..g3 and adds g4.
    feed.update(rss(items(1, 4)), '"v2"');
    const refreshed = await refreshFeed(await jobFor(id), fx.deps);

    expect(refreshed.newEntries).toBe(1);
    expect(await count('entries', 'feed_id = ?', id)).toBe(4);
    expect(await count('entries', 'purged_at IS NOT NULL')).toBe(3);
    expect(await count('user_entries')).toBe(1); // only g4
  });
});

describe('AC4: tombstones', () => {
  it('deletes tombstones purged over 180 days ago and keeps newer ones', async () => {
    const old = await entry({ published: ago(400), purgedAt: ago(181), content: false });
    const recent = await entry({ published: ago(400), purgedAt: ago(179), content: false });

    const { summary } = await run();

    expect(summary.tombstonesDeleted).toBe(1);
    expect(await exists('entries', 'id = ?', old)).toBe(false);
    expect(await exists('entries', 'id = ?', recent)).toBe(true);
  });
});

describe('AC5: batch bounds', () => {
  it('deletes at most 500 per statement and 10 statements per run, the rest on later runs', async () => {
    await bulkUserEntries(5_500, ago(40), true);

    const first = await run();
    const writes = first.changes.filter((c) => c > 0);
    expect(writes).toHaveLength(MAX_STATEMENTS);
    expect(Math.max(...first.changes)).toBeLessThanOrEqual(CHUNK);
    expect(first.summary.readDeleted).toBe(5_000);
    expect(await count('user_entries')).toBe(500);

    const second = await run();
    expect(second.summary.readDeleted).toBe(500);
    expect(await count('user_entries')).toBe(0);

    // The 5,500 now-unreferenced entries are purged by the targeted step, the hourly window and
    // the daily sweep, never more than 500 per statement and 10 statements per run.
    let runs = 0;
    while ((await count('entries', 'purged_at IS NULL')) > 0 && runs < 6) {
      const r = await run(NOW_0317 + runs);
      expect(Math.max(...r.changes)).toBeLessThanOrEqual(CHUNK);
      expect(r.changes.length).toBeLessThanOrEqual(MAX_STATEMENTS + 7);
      runs += 1;
    }
    expect(await count('entries', 'purged_at IS NULL')).toBe(0);
    expect(runs).toBeGreaterThan(1);
  });

  it('spends the shared budget in order, so a later step waits for the next run', async () => {
    await bulkUserEntries(5_000, ago(40), true);
    await entry({ published: ago(400), purgedAt: ago(200), content: false });
    const first = await run();
    expect(first.summary.readDeleted).toBe(5_000);
    expect(first.summary.tombstonesDeleted).toBe(0);
    expect((await run()).summary.tombstonesDeleted).toBe(1);
  });

  it('keeps the retention statements within 10 even when every step has a backlog', async () => {
    await bulkUserEntries(1_200, ago(40), true);
    await bulkUserEntries(1_200, ago(100), false);
    const r = await run();
    expect(r.changes.filter((c) => c > 0).length).toBeLessThanOrEqual(MAX_STATEMENTS);
    expect(Math.max(...r.changes)).toBeLessThanOrEqual(CHUNK);
  });
});

describe('AC6: sessions, challenges, rate limits, magic links', () => {
  beforeEach(() => seedUser('u1'));

  it('deletes expired sessions (sliding or absolute) and keeps live ones', async () => {
    const ins = (id: string, exp: number, abs: number) =>
      db.run(
        sql(
          `INSERT INTO sessions (id_hash, user_id, created_at, authenticated_at, expires_at, absolute_expires_at)
           VALUES (?, 'u1', 0, 0, ?, ?)`,
          id,
          exp,
          abs,
        ),
      );
    await ins('expired', NOW - 1, NOW + DAY);
    await ins('abs-expired', NOW + DAY, NOW - 1);
    await ins('live', NOW + DAY, NOW + 2 * DAY);
    const { summary } = await run();
    expect(summary.sessionsDeleted).toBe(2);
    expect(await count('sessions')).toBe(1);
    expect(await exists('sessions', "id_hash = 'live'")).toBe(true);
  });

  it('deletes expired challenges of every purpose, including orphans, and keeps live ones', async () => {
    const ins = (id: string, purpose: string, user: string | null, exp: number) =>
      db.run(
        sql(
          'INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
          id,
          user,
          purpose,
          'c',
          exp,
        ),
      );
    await ins('setup-old', 'setup', null, NOW - 1);
    await ins('login-old', 'login', null, NOW - 1);
    await ins('add-old', 'add_passkey', 'u1', NOW - 1);
    await ins('setup-live', 'setup', null, NOW + 60);
    await ins('login-live', 'login', null, NOW + 60);
    const { summary } = await run();
    expect(summary.challengesDeleted).toBe(3);
    expect(await count('webauthn_challenges')).toBe(2);
    expect(await exists('webauthn_challenges', "id IN ('setup-live','login-live')")).toBe(true);
  });

  it('deletes rate-limit windows older than the longest window and keeps current ones', async () => {
    const ins = (key: string, start: number) =>
      db.run(
        sql('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 3)', key, start),
      );
    await ins('stale', NOW - 86_401);
    await ins('current', NOW - 86_399);
    await ins('fresh', NOW);
    const { summary } = await run();
    expect(summary.rateLimitsDeleted).toBe(1);
    expect(await exists('rate_limits', "key = 'stale'")).toBe(false);
    expect(await count('rate_limits')).toBe(2);
  });

  it('deletes expired and used magic links (ADR 0016) and keeps live unused ones', async () => {
    const ins = (h: string, exp: number, used: number | null) =>
      db.run(
        sql(
          "INSERT INTO magic_links (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, 'u1', 0, ?, ?)",
          h,
          exp,
          used,
        ),
      );
    await ins('expired', NOW - 1, null);
    await ins('used', NOW + 600, NOW - 5);
    await ins('live', NOW + 600, null);
    const { summary } = await run();
    expect(summary.magicLinksDeleted).toBe(2);
    expect(await count('magic_links')).toBe(1);
    expect(await exists('magic_links', "token_hash = 'live'")).toBe(true);
  });
});

describe('AC7: parked feeds with no subscribers', () => {
  const lastAttempt = (id: number, at: number) =>
    db.run(sql('UPDATE feeds SET last_attempt_at = ? WHERE id = ?', at, id));

  it('deletes them and their entries after 7 days; keeps subscribed or recent ones', async () => {
    const dead = await seedFeed({ subscribers: [] });
    const recent = await seedFeed({ subscribers: [] });
    const subscribed = await seedFeed({ subscribers: ['u1'] });
    await lastAttempt(dead, ago(8));
    await lastAttempt(recent, ago(6));
    await lastAttempt(subscribed, ago(30));
    for (const feed of [dead, recent, subscribed]) await entry({ published: ago(1), feed });

    const { summary } = await run();

    expect(summary.deadFeedsDeleted).toBe(1);
    expect(await exists('feeds', 'id = ?', dead)).toBe(false);
    expect(await count('entries', 'feed_id = ?', dead)).toBe(0);
    expect(await count('entries', 'feed_id IN (?, ?)', recent, subscribed)).toBe(2);
  });

  it('empties a large feed in chunks of 500 before deleting it', async () => {
    const dead = await seedFeed({ subscribers: [] });
    await lastAttempt(dead, ago(8));
    await db.run(
      sql(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1200)
         INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at)
         SELECT ?, 'x' || i, ?, ? FROM s`,
        dead,
        ago(1),
        ago(1),
      ),
    );
    const r = await run();
    expect(r.changes.filter((c) => c > 0)).toEqual([500, 500, 200, 1]);
    expect(r.summary.deadFeedEntriesDeleted).toBe(1_200);
    expect(await exists('feeds', 'id = ?', dead)).toBe(false);
  });

  it('keeps the feed while entries remain (budget spent) and finishes on a later run', async () => {
    const dead = await seedFeed({ subscribers: [] });
    await lastAttempt(dead, ago(8));
    await db.run(
      sql(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 5200)
         INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at)
         SELECT ?, 'x' || i, ?, ? FROM s`,
        dead,
        ago(1),
        ago(1),
      ),
    );
    // Steps 1 to 4 spend one (empty) statement each, so 6 of the 10 are left: 3,000 rows.
    const first = await run();
    expect(first.summary.deadFeedEntriesDeleted).toBe(3_000);
    expect(await exists('feeds', 'id = ?', dead)).toBe(true);
    const second = await run();
    expect(second.summary.deadFeedEntriesDeleted).toBe(2_200);
    expect(second.summary.deadFeedsDeleted).toBe(1);
    expect(await exists('feeds', 'id = ?', dead)).toBe(false);
  });

  it('does not delete a feed that gained a subscriber', async () => {
    const dead = await seedFeed({ subscribers: [] });
    await lastAttempt(dead, ago(8));
    await seedUser('u9');
    await db.run(
      sql(
        "INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('s9', 'u9', ?, 0)",
        dead,
      ),
    );
    expect((await run()).summary.deadFeedsDeleted).toBe(0);
    expect(await exists('feeds', 'id = ?', dead)).toBe(true);
  });
});

describe('AC8: log lines', () => {
  it('logs one counts-only line per run', async () => {
    const { lines } = await run(NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'maintenance', readDeleted: 0, errors: 0 });
    expect(lines[0]).not.toHaveProperty('daily');
    for (const v of Object.values(lines[0]!)) expect(['string', 'number']).toContain(typeof v);
  });

  it('adds DB size and the previous day counts on the 03:17 UTC run', async () => {
    const yesterdayNoon = NOW_0317 - (NOW_0317 % DAY) - DAY / 2;
    await entry({ published: yesterdayNoon });
    await entry({ published: yesterdayNoon + 60 });
    await entry({ published: NOW_0317 - 60 }); // today, not counted
    const { lines } = await run(NOW_0317);
    const daily = lines[0]!.daily as {
      dbSizeBytes: number | null;
      entriesPublishedYesterday: number;
    };
    expect(daily.entriesPublishedYesterday).toBe(2);
    expect(typeof daily.dbSizeBytes).toBe('number');
  });
});

describe('D1 cost per run (spec 9.4, 9.5)', () => {
  it('an idle run on a populated database reads few rows and writes none', async () => {
    await bulkUserEntries(3_000, ago(5), false); // nothing eligible
    await entry({ published: ago(60), refs: [{ read: false }] }); // unread 30-90 d: not scanned
    await entry({ published: ago(300), refs: [{ read: false, starred: true }] });
    const { summary } = await run();
    expect(summary.rowsWritten).toBe(0);
    // Reads must not grow with the 3,000 retained rows: tiny tables plus a few index probes.
    expect(summary.rowsRead).toBeLessThan(120);
    expect(summary.statements).toBeLessThanOrEqual(12);
  });

  it('a full 500-row chunk writes and reads a bounded number of rows', async () => {
    await bulkUserEntries(500, ago(40), true);
    // A second reader keeps every entry referenced, so only the user_entries delete is measured.
    await seedUser('u2');
    await db.run(
      sql(
        `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read)
         SELECT 'u2', entry_id, feed_id, published_at, 0 FROM user_entries`,
      ),
    );
    const { summary } = await run();
    expect(summary.readDeleted).toBe(500);
    // Production D1 counts row + ue_all + ue_feed + ue_entry + ue_read_old = 5 per deleted row
    // (local workerd reports fewer), so 5 is the ceiling used for the budget.
    expect(summary.rowsWritten).toBeLessThanOrEqual(500 * 5 + 10);
    expect(summary.rowsWritten).toBeGreaterThanOrEqual(500);
    // Measured locally: about 11 reads per released row (delete with RETURNING 5, then the
    // targeted purge probe, the window scan and the housekeeping probes).
    expect(summary.rowsRead).toBeLessThan(500 * 12);
  });

  it('a full retention run (10 statements) stays well under the daily write quota', async () => {
    await bulkUserEntries(5_000, ago(40), true);
    const { summary } = await run();
    expect(summary.readDeleted).toBe(5_000);
    expect(summary.rowsWritten).toBeLessThanOrEqual(5_000 * 5 + 100);
  });
});

describe('scheduled() wiring', () => {
  it('runs maintenance on the 17 * * * * cron and not the dispatcher', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleScheduled(
      { cron: MAINTENANCE_CRON, scheduledTime: NOW * 1000 } as ScheduledController,
      env,
      {} as ExecutionContext,
    );
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(lines.filter((l) => l.includes('"event":"maintenance"'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('refresh_dispatch'))).toBe(false);
  });
});

describe('failure isolation', () => {
  it('counts a failed step and still runs the rest', async () => {
    await entry({ published: ago(40), refs: [{ read: true }] });
    const failing = new (class extends Db {
      override async run(s: Statement): Promise<Meta> {
        if (s.sql.includes('FROM sessions')) throw new Error('boom');
        return super.run(s);
      }
    })(env.DB);
    const summary = await runMaintenance({
      db: failing,
      clock: () => NOW * 1000,
      log: () => undefined,
    });
    expect(summary.errors).toBe(1);
    expect(summary.readDeleted).toBe(1);
  });
});
