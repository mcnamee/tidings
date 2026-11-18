import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { Db, sql, type Meta, type Statement } from '../src/db';
import { runMaintenance } from '../src/maintenance';
import { count, db, resetData, seedFeed, seedUser } from './support/refresh-harness';

// TID-021 adversarial cases (tester). Fixed clock; the real local D1 in workerd.
const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000; // not the 03:17 run
const NOW_0317 = Date.UTC(2026, 10, 20, 3, 17, 0) / 1000;
const ago = (days: number, extra = 0, from = NOW) => from - days * DAY - extra;

/** Runs maintenance; `before` may act on the database just before a statement matching `when`. */
async function run(at = NOW, hook?: { when: RegExp; before: () => Promise<void> }) {
  const lines: Record<string, unknown>[] = [];
  const hooked = new (class extends Db {
    private fired = false;
    private async maybe(s: Statement) {
      if (hook && !this.fired && hook.when.test(s.sql)) {
        this.fired = true;
        await hook.before();
      }
    }
    override async run(s: Statement): Promise<Meta> {
      await this.maybe(s);
      return super.run(s);
    }
    override async all<T>(s: Statement) {
      await this.maybe(s);
      return super.all<T>(s);
    }
  })(env.DB);
  const summary = await runMaintenance({
    db: hooked,
    clock: () => at * 1000,
    log: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { summary, lines };
}

let nextId = 1;
async function user(id: string) {
  await db.run(
    sql('INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, 0)', id, id),
  );
}
async function feed(id: number, lastAttempt = NOW) {
  await db.run(
    sql(
      `INSERT OR IGNORE INTO feeds (id, url, next_fetch_at, last_attempt_at, created_at)
       VALUES (?, ?, 0, ?, 0)`,
      id,
      `https://f${id}.example.com/rss`,
      lastAttempt,
    ),
  );
}
async function entry(
  published: number,
  refs: { user: string; read?: boolean; starred?: boolean }[] = [],
  o: { feedId?: number; purgedAt?: number } = {},
): Promise<number> {
  const id = nextId++;
  const feedId = o.feedId ?? 1;
  await feed(feedId);
  await db.run(
    sql(
      `INSERT INTO entries (id, feed_id, guid_hash, summary, content_html, published_at, fetched_at, purged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      feedId,
      `g${id}`,
      o.purgedAt ? null : 's',
      o.purgedAt ? null : '<p>b</p>',
      published,
      published,
      o.purgedAt ?? null,
    ),
  );
  for (const r of refs) await ue(r.user, id, feedId, published, !!r.read, !!r.starred);
  return id;
}
async function ue(u: string, e: number, f: number, pub: number, read: boolean, starred: boolean) {
  await user(u);
  await db.run(
    sql(
      `INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, is_starred)
       VALUES (?, ?, ?, ?, ?, ?)`,
      u,
      e,
      f,
      pub,
      read ? 1 : 0,
      starred ? 1 : 0,
    ),
  );
}
const has = async (u: string, e: number) =>
  (await count('user_entries', 'user_id = ? AND entry_id = ?', u, e)) > 0;
const live = async (e: number) =>
  (await count('entries', 'id = ? AND purged_at IS NULL AND content_html IS NOT NULL', e)) > 0;

beforeEach(async () => {
  await resetData();
  for (const t of ['sessions', 'webauthn_challenges', 'rate_limits', 'magic_links']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
});

describe('TID-021 multi-user isolation', () => {
  it('A read and B unread on the same old entry: only A loses the row; the shared entry keeps its content', async () => {
    const e = await entry(ago(40), [
      { user: 'A', read: true },
      { user: 'B', read: false },
    ]);
    const { summary } = await run();
    expect(summary.readDeleted).toBe(1);
    expect(await has('A', e)).toBe(false);
    expect(await has('B', e)).toBe(true);
    expect(await live(e)).toBe(true);
    // And on the daily sweep too.
    await run(NOW_0317);
    expect(await live(e)).toBe(true);
  });

  it("A's starred copy keeps the shared entry alive when B's read copy is deleted", async () => {
    const e = await entry(ago(200), [
      { user: 'A', read: true, starred: true },
      { user: 'B', read: true },
    ]);
    await run(NOW_0317);
    expect(await has('A', e)).toBe(true);
    expect(await has('B', e)).toBe(false);
    expect(await live(e)).toBe(true);
  });

  it('purges the shared entry only once the last user has let go', async () => {
    const e = await entry(ago(100), [
      { user: 'A', read: true },
      { user: 'B', read: false },
    ]);
    await run(); // A (read, > 30d) and B (unread, > 90d) both released in one run
    expect(await count('user_entries', 'entry_id = ?', e)).toBe(0);
    expect(await count('entries', 'id = ? AND purged_at = ?', e, NOW)).toBe(1);
  });

  it('retention of user A never touches user B on a different, unrelated feed', async () => {
    const a = await entry(ago(40), [{ user: 'A', read: true }], { feedId: 1 });
    const b = await entry(ago(40), [{ user: 'B', read: false }], { feedId: 2 });
    await run();
    expect(await has('A', a)).toBe(false);
    expect(await has('B', b)).toBe(true);
    expect(await live(b)).toBe(true);
  });
});

describe('TID-021 exact boundaries (strictly older than)', () => {
  it('read: exactly 30 days is kept, 30 days + 1 s is deleted', async () => {
    const edge = await entry(ago(30), [{ user: 'A', read: true }]);
    const over = await entry(ago(30, 1), [{ user: 'A', read: true }]);
    await run();
    expect(await has('A', edge)).toBe(true);
    expect(await has('A', over)).toBe(false);
  });

  it('unread: exactly 90 days is kept, 90 days + 1 s is deleted', async () => {
    const edge = await entry(ago(90), [{ user: 'A', read: false }]);
    const over = await entry(ago(90, 1), [{ user: 'A', read: false }]);
    await run();
    expect(await has('A', edge)).toBe(true);
    expect(await has('A', over)).toBe(false);
  });

  it('unread between 30 and 90 days is kept even though a read one of that age is not', async () => {
    const e = await entry(ago(60), [
      { user: 'A', read: false },
      { user: 'B', read: true },
    ]);
    await run();
    expect(await has('A', e)).toBe(true);
    expect(await has('B', e)).toBe(false);
  });

  it('purge: an unreferenced entry exactly 30 days old keeps its content, 30 days + 1 s is purged (hourly and daily)', async () => {
    const edge = await entry(ago(30));
    const over = await entry(ago(30, 1));
    await run();
    expect(await live(edge)).toBe(true);
    expect(await live(over)).toBe(false);
    // The daily sweep has its own predicate: check its boundary against its own clock.
    const edgeDaily = await entry(ago(30, 0, NOW_0317));
    const overDaily = await entry(ago(30, 1, NOW_0317));
    await run(NOW_0317);
    expect(await live(edgeDaily)).toBe(true);
    expect(await live(overDaily)).toBe(false);
  });

  it('tombstone: exactly 180 days since purge is kept, 180 days + 1 s is deleted', async () => {
    const edge = await entry(ago(400), [], { purgedAt: ago(180) });
    const over = await entry(ago(400), [], { purgedAt: ago(180, 1) });
    await run();
    expect(await count('entries', 'id = ?', edge)).toBe(1);
    expect(await count('entries', 'id = ?', over)).toBe(0);
  });

  it('parked feed: exactly 7 days is kept, 7 days + 1 s is deleted', async () => {
    const edge = await seedFeed({ subscribers: [] });
    const over = await seedFeed({ subscribers: [] });
    await db.run(sql('UPDATE feeds SET last_attempt_at = ? WHERE id = ?', ago(7), edge));
    await db.run(sql('UPDATE feeds SET last_attempt_at = ? WHERE id = ?', ago(7, 1), over));
    await run();
    expect(await count('feeds', 'id = ?', edge)).toBe(1);
    expect(await count('feeds', 'id = ?', over)).toBe(0);
  });

  it('a purged entry is never purged twice (purged_at keeps its first value)', async () => {
    const e = await entry(ago(100), [], { purgedAt: ago(5) });
    await run(NOW_0317);
    expect(await count('entries', 'id = ? AND purged_at = ?', e, ago(5))).toBe(1);
  });
});

describe('TID-021 clock units', () => {
  it('rows stamped in milliseconds by mistake (far future in seconds) are never deleted or purged', async () => {
    const e = await entry(NOW * 1000, [{ user: 'A', read: true }]);
    const orphan = await entry(NOW * 1000);
    await run(NOW_0317 + DAY);
    expect(await has('A', e)).toBe(true);
    expect(await live(orphan)).toBe(true);
  });

  it('a clock fed seconds instead of milliseconds deletes nothing recent (fails safe)', async () => {
    const e = await entry(ago(5), [{ user: 'A', read: true }]);
    const orphan = await entry(ago(5));
    await runMaintenance({ db, clock: () => NOW, log: () => undefined });
    expect(await has('A', e)).toBe(true);
    expect(await live(orphan)).toBe(true);
  });
});

describe('TID-021 races with refresh and subscribe', () => {
  it('a subscriber links an old entry between "released" and the purge: it is not purged', async () => {
    const e = await entry(ago(40), [{ user: 'A', read: true }]);
    await run(NOW, {
      when: /^UPDATE entries SET content_html = NULL/,
      before: () => ue('B', e, 1, ago(40), false, false),
    });
    expect(await live(e)).toBe(true);
    expect(await has('B', e)).toBe(true);
  });

  it('a refresh inserts a new entry while maintenance runs: untouched', async () => {
    let fresh = 0;
    await entry(ago(40), [{ user: 'A', read: true }]);
    await run(NOW, {
      when: /^DELETE FROM entries WHERE id IN/, // tombstone step
      before: async () => {
        fresh = await entry(ago(0, 60), [{ user: 'A' }]);
      },
    });
    expect(await live(fresh)).toBe(true);
    expect(await has('A', fresh)).toBe(true);
  });

  it('a feed resubscribed after it was picked as dead keeps its feed, entries and user_entries', async () => {
    const dead = await seedFeed({ subscribers: [] });
    await db.run(sql('UPDATE feeds SET last_attempt_at = ? WHERE id = ?', ago(8), dead));
    const e = await entry(ago(1), [], { feedId: dead });
    await user('U9');
    await run(NOW, {
      when: /^DELETE FROM entries WHERE id IN \(\s*SELECT e\.id FROM entries e JOIN feeds/,
      before: async () => {
        await db.run(
          sql(
            "INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('sx', 'U9', ?, 0)",
            dead,
          ),
        );
        await ue('U9', e, dead, ago(1), false, true);
      },
    });
    expect(await count('feeds', 'id = ?', dead)).toBe(1);
    expect(await count('entries', 'id = ?', e)).toBe(1);
    expect(await has('U9', e)).toBe(true);
  });

  it('an entry arriving for a picked dead feed before the feed row delete keeps the feed row', async () => {
    const dead = await seedFeed({ subscribers: [] });
    await db.run(sql('UPDATE feeds SET last_attempt_at = ? WHERE id = ?', ago(8), dead));
    await entry(ago(1), [], { feedId: dead });
    let late = 0;
    await run(NOW, {
      when: /^DELETE FROM feeds WHERE id IN/,
      before: async () => {
        late = await entry(ago(0, 5), [], { feedId: dead });
      },
    });
    expect(await count('feeds', 'id = ?', dead)).toBe(1);
    expect(await count('entries', 'id = ?', late)).toBe(1);
  });
});

describe('TID-021 tombstones keep GUID dedup', () => {
  it('a purged row survives (as a tombstone) for 180 days from the purge, even when the post is 400 days old', async () => {
    const e = await entry(ago(400));
    // Keep feed 1 subscribed: otherwise the dead-feed step would remove it (and its tombstones).
    await user('A');
    await db.run(
      sql("INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('s1', 'A', 1, 0)"),
    );
    await run(); // purged now
    expect(await count('entries', 'id = ? AND purged_at = ?', e, NOW)).toBe(1);
    await run(NOW + 179 * DAY);
    expect(await count('entries', 'id = ?', e)).toBe(1);
    await run(NOW + 181 * DAY);
    expect(await count('entries', 'id = ?', e)).toBe(0);
  });
});

describe('TID-021 DEF-110: a long rate-limit window survives maintenance', () => {
  it('the daily email-send cap (86,400 s window) is not reset by an hourly run', async () => {
    const { consumeRateLimits } = await import('../src/auth/rate-limit');
    const rule = [{ key: 'email:send:2026-11-20', limit: 10, windowSeconds: 86_400 }];
    const at = (s: number) => () => s * 1000;
    const start = NOW - 5 * 3_600; // 07:00 UTC, five hours before maintenance
    for (let i = 0; i < 10; i++) {
      expect((await consumeRateLimits(db, rule, at(start))).allowed).toBe(true);
    }
    expect((await consumeRateLimits(db, rule, at(start))).allowed).toBe(false);

    await run(NOW); // hourly maintenance

    // Still capped: the window is only 5 hours old.
    expect((await consumeRateLimits(db, rule, at(NOW))).allowed).toBe(false);
  });

  it('still deletes a window that is over 24 hours old', async () => {
    await db.run(
      sql("INSERT INTO rate_limits (key, window_start, count) VALUES ('old', ?, 3)", NOW - 86_401),
    );
    await run(NOW);
    expect(await count('rate_limits', "key = 'old'")).toBe(0);
  });
});
