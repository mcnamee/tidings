// Manual verification of TID-004 AC1, AC2 and AC5 against the local (miniflare) D1.
// Run: npm run db:migrate:local && npm run db:seed:local && node scripts/verify-local.mjs
// The tester can port these checks into @cloudflare/vitest-pool-workers integration tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'tid004-')), 'db.mjs');
execFileSync(
  'npx',
  ['esbuild', 'src/db/index.ts', '--bundle', '--format=esm', '--outfile=' + out],
  {
    cwd: root,
    stdio: 'ignore',
  },
);
const { Db, sql, listEntries } = await import(pathToFileURL(out).href);

const { env, dispose } = await getPlatformProxy({ configPath: join(root, 'wrangler.jsonc') });
const db = new Db(env.DB);
let failed = false;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failed = true;
};

// AC1: every table and index from spec 6.1 exists.
const tables = [
  'users',
  'passkeys',
  'webauthn_challenges',
  'recovery_codes',
  'sessions',
  'rate_limits',
  'feeds',
  'folders',
  'subscriptions',
  'entries',
  'user_entries',
];
const indexes = [
  'passkeys_user',
  'recovery_codes_user',
  'sessions_user',
  'subscriptions_feed',
  'subscriptions_user_folder',
  'entries_published',
  'ue_all',
  'ue_feed',
  'ue_unread_all',
  'ue_unread_feed',
];
const master = await db.all(
  sql("SELECT type, name FROM sqlite_master WHERE type IN ('table','index')"),
);
const names = new Set(master.rows.map((r) => r.type + ':' + r.name));
for (const t of tables) check('AC1 table ' + t, names.has('table:' + t));
for (const i of indexes) check('AC1 index ' + i, names.has('index:' + i));

// AC2: duplicate (feed_id, guid_hash) is rejected, or ignored with ON CONFLICT DO NOTHING.
const dup = sql(
  "INSERT INTO entries (feed_id, guid_hash, published_at, fetched_at) VALUES (1, 'guid-1', 1, 1)",
);
let rejected = false;
try {
  await db.run(dup);
} catch {
  rejected = true;
}
check('AC2 plain duplicate insert rejected', rejected);
const ignored = await db.run(sql(dup.sql + ' ON CONFLICT(feed_id, guid_hash) DO NOTHING'));
check(
  'AC2 ON CONFLICT DO NOTHING writes nothing',
  ignored.changes === 0,
  JSON.stringify({ changes: ignored.changes }),
);

// AC5: All-unread page of 50 reads <= 102 rows (NFR-7); page 2 via cursor too.
const p1 = await listEntries(db, 'seed-user', { view: 'all', unreadOnly: true, limit: 50 });
check('AC5 page 1 returns 50 items', p1.items.length === 50);
check('AC5 page 1 rows_read <= 102', p1.meta.rows_read <= 102, 'rows_read=' + p1.meta.rows_read);
const p2 = await listEntries(db, 'seed-user', {
  view: 'all',
  unreadOnly: true,
  limit: 50,
  cursor: p1.nextCursor,
});
check(
  'AC5 page 2 rows_read <= 103 (cursor row re-read costs 1)',
  p2.meta.rows_read <= 103,
  'rows_read=' + p2.meta.rows_read,
);
const feed = await listEntries(db, 'seed-user', {
  view: 'feed',
  id: 1,
  unreadOnly: true,
  limit: 20,
});
check('feed view rows_read <= 42', feed.meta.rows_read <= 42, 'rows_read=' + feed.meta.rows_read);
const folder = await listEntries(db, 'seed-user', {
  view: 'folder',
  id: 'seed-folder-1',
  unreadOnly: true,
  limit: 20,
});
console.log(
  'INFO folder view rows_read=' + folder.meta.rows_read + ' items=' + folder.items.length,
);

await dispose();
process.exit(failed ? 1 : 0);
