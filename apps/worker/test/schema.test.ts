import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Db, sql } from '../src/db';

// TID-004 AC1 and AC2 against the migrated D1 (migrations applied per file by test/setup.ts).
// Names are copied from spec 6.1 (not read from the migration), so drift in either is caught.
const SPEC_TABLES = [
  'users',
  'passkeys',
  'webauthn_challenges',
  'recovery_codes',
  'sessions',
  'rate_limits',
  'magic_links',
  'feeds',
  'folders',
  'subscriptions',
  'entries',
  'user_entries',
];
const SPEC_INDEXES = [
  'passkeys_user',
  'recovery_codes_user',
  'sessions_user',
  'magic_links_user',
  'subscriptions_feed',
  'subscriptions_user_folder',
  'entries_published',
  'ue_all',
  'ue_feed',
  'ue_unread_all',
  'ue_unread_feed',
];

const db = new Db(env.DB);

async function names(type: 'table' | 'index'): Promise<string[]> {
  const r = await db.all<{ name: string }>(
    sql(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
      type,
    ),
  );
  return r.rows.map((x) => x.name);
}

describe('TID-004 AC1: schema matches spec 6.1', () => {
  it('AC1: every table named in spec 6.1 exists, and no others', async () => {
    expect(await names('table')).toEqual([...SPEC_TABLES].sort());
  });

  it('AC1: every index named in spec 6.1 exists, and no others', async () => {
    expect(await names('index')).toEqual([...SPEC_INDEXES].sort());
  });

  it('AC1: the unread indexes are partial (WHERE is_read = 0)', async () => {
    const r = await db.all<{ name: string; sql: string }>(
      sql("SELECT name, sql FROM sqlite_master WHERE name IN ('ue_unread_all', 'ue_unread_feed')"),
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.sql).toMatch(/WHERE is_read = 0/);
  });
});

describe('TID-004 AC2: entries are unique per (feed_id, guid_hash)', () => {
  const insert =
    "INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at) VALUES (1, 'guid-dup', 1, 1)";

  it('AC2: a plain duplicate insert is rejected, and ON CONFLICT DO NOTHING reports changes 0', async () => {
    await db.run(
      sql(
        "INSERT INTO feeds (id, url, next_fetch_at, created_at) VALUES (1, 'https://a.example.com/rss', 0, 0)",
      ),
    );
    const first = await db.run(sql(insert));
    expect(first.changes).toBe(1);

    await expect(db.run(sql(insert))).rejects.toThrow(/UNIQUE constraint failed/);

    const ignored = await db.run(sql(insert + ' ON CONFLICT(feed_id, guid_hash) DO NOTHING'));
    expect(ignored.changes).toBe(0);

    const n = await db.first<{ n: number }>(
      sql("SELECT COUNT(*) AS n FROM entries WHERE feed_id = 1 AND guid_hash = 'guid-dup'"),
    );
    expect(n?.n).toBe(1);
  });

  it('AC2: the same guid_hash under a different feed is a distinct entry', async () => {
    await db.run(
      sql(
        "INSERT INTO feeds (id, url, next_fetch_at, created_at) VALUES (2, 'https://b.example.com/rss', 0, 0)",
      ),
    );
    const r = await db.run(
      sql(
        "INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at) VALUES (2, 'guid-dup', 1, 1)",
      ),
    );
    expect(r.changes).toBe(1);
  });
});
